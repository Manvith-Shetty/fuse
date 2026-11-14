// Fuse firmware: a NEAR function-call key that lives in this chip and signs only what it has decoded and
// policy-checked itself. No network. Newline-delimited JSON over USB serial (docs/protocol.md, protocol v2).
#include <Arduino.h>
#include "esp_app_desc.h"
#include <ArduinoJson.h>
#include <vector>
#include <string>
#include "borsh.h"
#include "policy.h"
#include "util.h"
#include "codes.h"
#include "crypto_iface.h"
#include "keystore.h"
#include "ui.h"
using namespace fuse;

#ifndef FUSE_FW_VERSION
#define FUSE_FW_VERSION "0.2.0"
#endif
static const uint32_t BUTTON_TIMEOUT_MS = 30000;
static const uint32_t BRIDGE_TIMEOUT_MS = 6000;
static const uint32_t HOST_PRESENT_MS = 5000;   // a byte from the host within this window = someone is listening
static const uint32_t TX_DRAIN_MAX_MS = 50;     // spec 2.7: never wait longer than this for the USB TX buffer
static const size_t MAX_LINE = 20000;           // sign + 8 KiB decision response (base64) fits; larger lines are dropped

static Keystore ks;
static Policy policy;
static std::string policyJson;                  // the policy bytes exactly as stored (compact JSON); hashed for hello/policy_set
static std::string fwSha256Hex;                 // this image's ELF SHA-256, lowercase hex (also in hello.fw_sha256)
static std::vector<RefusalRecord> refusals;     // ring of the last 16 refusals this chip issued
static std::vector<uint32_t> signTimes;         // millis() of recent signatures (velocity window)
static uint32_t lastPingMs = 0;
static uint32_t lastRxMs = 0;
static int txIdleFree = 0;                      // availableForWrite() with an empty TX buffer, sampled at boot
static String lineBuf;

static std::string policyHash() { uint8_t h[32]; sha256((const uint8_t*)policyJson.data(), policyJson.size(), h); return hexEncode(h, 8); }

// Output discipline (spec 2.7). Native USB CDC holds short writes until its ISR runs, so after a reply we wait for the
// TX buffer to drain, but never more than TX_DRAIN_MAX_MS and not at all when the host has gone quiet: a host that
// closes the port right after a reply used to leave Serial.flush() stuck until reset. The write itself is bounded by
// the core's per-write TX timeout, so no path here can hold the main loop on a host that is not reading.
static void send(JsonDocument& doc) {
  std::string out; serializeJson(doc, out); out += '\n';
  Serial.write((const uint8_t*)out.data(), out.size());
  // Host present = a byte arrived recently, or bytes are waiting unread (pings pile up while waitForButton blocks the loop).
  if (millis() - lastRxMs > HOST_PRESENT_MS && Serial.available() <= 0) return;
  uint32_t t0 = millis();
  while (Serial.availableForWrite() < txIdleFree && millis() - t0 < TX_DRAIN_MAX_MS) delay(1);
}
static void sendError(const char* id, uint8_t code, const std::string& detail) {
  JsonDocument d; d["id"] = id; d["ok"] = false; d["code"] = codeName(code); d["code_num"] = code; d["detail"] = detail; send(d);
}
static uint32_t recentSigns(uint32_t now) {
  std::vector<uint32_t> keep; for (auto t : signTimes) if (now - t < policy.velocityWindowMs) keep.push_back(t);
  signTimes = keep; return (uint32_t)signTimes.size();
}
static void loadPolicy() {
  std::string j = ks.policyJson(); std::string err; Policy p;
  if (!j.empty() && policyFromJson(j, p, err)) { policy = p; policyJson = j; return; }
  policy = defaultPolicy(); policyJson = policyToJson(policy);
}
static std::string ownerPubkeyStr() { return ks.hasOwner() ? "ed25519:" + base58Encode(ks.ownerPub(), 32) : std::string(); }

// Refusal receipt v2 (spec 2.6): sign sha256("FUSE_REFUSAL_V2" || tx_hash || code || counter_le || receiver_hash) so the
// chain and the shared registry can verify the chip issued it and which receiver it refused.
static std::string issueRefusalReceipt(const uint8_t txHash[32], uint8_t code, const std::string& receiver, uint32_t& counterOut) {
  counterOut = ks.nextCounter();
  uint8_t digest[32]; refusalDigestV2(txHash, code, counterOut, receiver, digest);
  uint8_t sig[64]; ks.sign(digest, 32, sig);
  RefusalRecord r; memcpy(r.hash, txHash, 32); r.code = code; r.counter = counterOut;
  refusals.push_back(r); if (refusals.size() > 16) refusals.erase(refusals.begin());
  return base64Encode(sig, 64);
}

static void handleHello(const char* id) {
  JsonDocument d; d["id"] = id; d["ok"] = true;
  d["pubkey"] = "ed25519:" + base58Encode(ks.pub(), 32);
  d["pubkey_hex"] = hexEncode(ks.pub(), 32);
  d["fw"] = FUSE_FW_VERSION; d["policy_hash"] = policyHash(); d["counter"] = ks.counter();
  // Attestation of what is running: SHA-256 of the firmware ELF, as the bootloader stored it in the app descriptor.
  // Compare with `esptool image-info .pio/build/<env>/firmware.bin` from your own build.
  d["fw_sha256"] = fwSha256Hex;
  d["last_nonce"] = ks.lastNonce(); d["mode"] = "HARDWARE";
#ifdef FUSE_RGB_PIN
  d["board"] = "esp32s3";
#else
  d["board"] = "esp32";
#endif
  // protocol v2
  d["proto"] = 2;
  if (ks.hasOwner()) d["owner_pubkey"] = ownerPubkeyStr(); else d["owner_pubkey"] = nullptr;
  d["policy_seq"] = ks.policySeq(); d["receipt_v"] = 2;
  auto sch = d["schemes"].to<JsonArray>(); sch.add("raw"); sch.add("nep413");   // owner signature schemes policy_set accepts
  send(d);
}

static DecisionFields parseDecision(JsonVariantConst dv) {
  DecisionFields df;
  if (!dv.is<JsonObjectConst>()) return df;
  df.present = true;
  df.text = dv["text"] | ""; df.sigB64 = dv["sig"] | ""; df.signer = dv["signer"] | "";
  JsonVariantConst resp = dv["resp"];
  if (!resp.isNull()) { df.hasResp = true; df.respB64 = resp.as<const char*>() ? resp.as<const char*>() : ""; }
  return df;
}

static void handleSign(const char* id, JsonVariantConst req) {
  std::string txB64 = req["tx"] | "";
  std::vector<uint8_t> tx; if (!base64Decode(txB64, tx) || tx.empty()) { sendError(id, BAD_BORSH, "tx must be base64"); return; }
  uint8_t txHash[32]; sha256(tx.data(), tx.size(), txHash);
  std::string hashB58 = base58Encode(txHash, 32);

  uiSet(Led::BUSY);
  DecodedTx dec; Code c = decodeTransaction(tx.data(), tx.size(), dec);
  std::string receiver = (c == CODE_OK) ? payReceiver(dec) : std::string();   // bound into the v2 receipt
  Decision dcs; Binding binding = Binding::NONE;
  if (c != CODE_OK) { dcs.verdict = Verdict::REFUSE; dcs.code = c; dcs.detail = "structural"; }
  else {
    EvalContext ctx{ks.pub(), ks.lastNonce(), recentSigns(millis()), &refusals, fwSha256Hex.c_str()};
    dcs = evaluate(policy, dec, ctx);
    // Attested decision (spec 2.3): only for pay, only when the policy names decision signers, checked before the button.
    if (dcs.verdict != Verdict::REFUSE && dec.method == "pay" && !policy.decisionSigners.empty()) {
      std::string detail; uint8_t code = checkDecision(policy, dec, parseDecision(req["decision"]), detail, binding);
      if (code != CODE_OK) { dcs.verdict = Verdict::REFUSE; dcs.code = code; dcs.detail = detail; }
    }
  }

  if (dcs.verdict == Verdict::SIGN_WITH_BUTTON) {
    JsonDocument n; n["id"] = id; n["event"] = "button_required"; n["summary"] = dcs.summary; n["timeout_ms"] = BUTTON_TIMEOUT_MS; send(n);
    if (!waitForButton(BUTTON_TIMEOUT_MS)) { dcs.verdict = Verdict::REFUSE; dcs.code = BUTTON_TIMEOUT; dcs.detail = "no button press within timeout"; }
  }

  JsonDocument d; d["id"] = id; d["hash"] = hashB58;
  if (c == CODE_OK) { d["decoded"]["signer"] = dec.signer; d["decoded"]["receiver"] = dec.receiver; d["decoded"]["method"] = dec.method; d["decoded"]["nonce"] = dec.nonce; d["decoded"]["gas"] = dec.gas; }
  if (dcs.verdict == Verdict::REFUSE) {
    uint32_t counter; std::string receipt = issueRefusalReceipt(txHash, dcs.code, receiver, counter);
    d["ok"] = false; d["code"] = codeName(dcs.code); d["code_num"] = dcs.code; d["detail"] = dcs.detail;
    d["receipt"] = receipt; d["counter"] = counter; d["receipt_v"] = 2; d["receiver"] = receiver;
    uiSet(Led::IDLE); send(d); uiBlink(Led::REFUSED, 5); return;
  }
  uint8_t sig[64]; ks.sign(txHash, 32, sig);
  ks.setLastNonce(dec.nonce); signTimes.push_back(millis());
  d["ok"] = true; d["sig"] = base64Encode(sig, 64); d["summary"] = dcs.summary; d["button"] = (dcs.verdict == Verdict::SIGN_WITH_BUTTON);
  d["decision"] = bindingName(binding);
  uiSet(Led::IDLE); send(d); uiBlink(Led::SIGNED, 3);
}

// Owner-signed policy update (spec 2.2). The policy bytes that are hashed are ArduinoJson's compact re-serialisation of
// the `policy` value as received (same text as JSON.stringify for the plain strings, booleans and integers a policy holds).
static void handlePolicySet(const char* id, JsonVariantConst req) {
  std::string j; serializeJson(req["policy"], j);
  Policy p; std::string err;
  if (j.empty() || j == "null" || !policyFromJson(j, p, err)) { sendError(id, BAD_POLICY, err.empty() ? "policy missing" : err); return; }
  JsonVariantConst seqv = req["seq"];
  if (!seqv.is<uint32_t>() || req["owner_sig"].isNull()) { sendError(id, OWNER_SIG_INVALID, "policy_set needs seq and owner_sig (protocol v2)"); return; }
  uint32_t seq = seqv.as<uint32_t>();
  uint8_t owner[32];
  if (ks.hasOwner()) memcpy(owner, ks.ownerPub(), 32);                       // later sets: owner_pubkey in the request is ignored
  else if (!parseKey32(req["owner_pubkey"] | "", owner)) { sendError(id, OWNER_SIG_INVALID, "no owner key stored: first policy_set must carry owner_pubkey"); return; }
  if (seq <= ks.policySeq()) { sendError(id, OWNER_SIG_INVALID, "seq must be > " + std::to_string(ks.policySeq())); return; }
  std::vector<uint8_t> sig;
  if (!base64Decode(req["owner_sig"] | "", sig) || sig.size() != 64) { sendError(id, OWNER_SIG_INVALID, "owner_sig must be base64 64 bytes"); return; }
  // Signature scheme: "raw" (default) signs the digest directly; "nep413" is what browser wallets produce (signMessage).
  std::string scheme = req["owner_sig_scheme"] | "raw";
  uint8_t digest[32];
  if (scheme == "raw") policyAuthDigest(j, seq, digest);
  else if (scheme == "nep413") {
    std::vector<uint8_t> nonce;
    if (!base64Decode(req["nonce"] | "", nonce) || nonce.size() != 32) { sendError(id, OWNER_SIG_INVALID, "nep413 nonce must be base64 32 bytes"); return; }
    const char* recipient = req["recipient"].as<const char*>();
    if (!recipient || !*recipient) { sendError(id, OWNER_SIG_INVALID, "nep413 recipient required"); return; }
    const char* cb = req["callback_url"].as<const char*>(); std::string cbStr = cb ? cb : "";
    policyAuthDigestNep413(j, seq, nonce.data(), recipient, cb ? &cbStr : nullptr, digest);
  }
  else { sendError(id, OWNER_SIG_INVALID, "unknown owner_sig_scheme " + scheme); return; }
  if (!ed25519Verify(sig.data(), digest, 32, owner)) { sendError(id, OWNER_SIG_INVALID, "owner signature does not verify (" + scheme + ")"); return; }

  JsonDocument n; n["id"] = id; n["event"] = "button_required"; n["summary"] = "update policy"; n["timeout_ms"] = BUTTON_TIMEOUT_MS; send(n);
  if (!waitForButton(BUTTON_TIMEOUT_MS)) { sendError(id, BUTTON_TIMEOUT, "policy update not confirmed"); return; }
  policy = p; policyJson = j; ks.setPolicyJson(j); ks.setOwner(owner, seq);
  uint8_t ph[32]; sha256((const uint8_t*)j.data(), j.size(), ph);
  JsonDocument d; d["id"] = id; d["ok"] = true; d["policy_hash"] = hexEncode(ph, 8); d["policy_sha256"] = hexEncode(ph, 32);
  d["policy_seq"] = seq; d["owner_pubkey"] = ownerPubkeyStr(); d["owner_sig_scheme"] = scheme;
  send(d); uiBlink(Led::SIGNED, 2);
}

static void handleLine(const String& line) {
  JsonDocument req; if (deserializeJson(req, line)) { sendError("", BAD_ARGS, "line is not JSON"); return; }
  const char* op = req["op"] | ""; const char* id = req["id"] | "";
  if (!strcmp(op, "hello")) handleHello(id);
  else if (!strcmp(op, "ping")) { lastPingMs = millis(); if (uiStateIsNoBridge()) uiSet(Led::IDLE); JsonDocument d; d["id"] = id; d["pong"] = true; d["uptime_ms"] = millis(); send(d); }
  else if (!strcmp(op, "sign")) { lastPingMs = millis(); handleSign(id, req.as<JsonVariantConst>()); }
  else if (!strcmp(op, "policy_get")) {
    JsonDocument d; d["id"] = id; d["ok"] = true; JsonDocument p; deserializeJson(p, policyJson); d["policy"] = p; d["policy_hash"] = policyHash();
    d["policy_seq"] = ks.policySeq(); if (ks.hasOwner()) d["owner_pubkey"] = ownerPubkeyStr(); else d["owner_pubkey"] = nullptr;
    send(d);
  }
  else if (!strcmp(op, "policy_set")) handlePolicySet(id, req.as<JsonVariantConst>());
  else if (!strcmp(op, "decode")) { // diagnostics: decode without signing, no secrets involved
    std::string txB64 = req["tx"] | ""; std::vector<uint8_t> tx; DecodedTx dec;
    if (!base64Decode(txB64, tx)) { sendError(id, BAD_BORSH, "tx must be base64"); return; }
    Code c = decodeTransaction(tx.data(), tx.size(), dec); JsonDocument d; d["id"] = id; d["ok"] = (c == CODE_OK); d["code"] = codeName(c);
    if (c == CODE_OK) { d["signer"] = dec.signer; d["receiver"] = dec.receiver; d["method"] = dec.method; d["args"] = dec.args; d["nonce"] = dec.nonce; d["gas"] = dec.gas; d["pubkey_hex"] = hexEncode(dec.pubkey, 32); }
    send(d);
  }
  else sendError(id, BAD_ARGS, std::string("unknown op ") + op);
}

void setup() {
  Serial.setRxBufferSize(16384); // a sign request is ~450 bytes (up to ~12 KB with a bound decision) and native USB delivers it in bursts
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT && defined(ARDUINO_USB_MODE) && ARDUINO_USB_MODE
  Serial.setTxBufferSize(4096);  // HWCDC: a whole reply fits the ring buffer, so write() never waits on the USB ISR
#endif
  Serial.begin(FUSE_BAUD);
  txIdleFree = Serial.availableForWrite();
  uiBegin(); uiSet(Led::BUSY);
  ks.begin(); loadPolicy();
  const esp_app_desc_t* app = esp_app_get_description(); fwSha256Hex = hexEncode(app->app_elf_sha256, 32);
  lastPingMs = millis(); lastRxMs = millis();
  uiSet(Led::IDLE);
  JsonDocument d; d["event"] = "ready"; d["pubkey"] = "ed25519:" + base58Encode(ks.pub(), 32); d["fw"] = FUSE_FW_VERSION; d["proto"] = 2; send(d);
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read(); lastRxMs = millis();
    if (c == '\n') { if (lineBuf.length()) handleLine(lineBuf); lineBuf = ""; }
    else if (lineBuf.length() < MAX_LINE) lineBuf += c;
    else lineBuf = ""; // oversize line: drop
  }
  uint32_t now = millis();
  if (now - lastPingMs > BRIDGE_TIMEOUT_MS && !uiStateIsNoBridge()) uiSet(Led::NO_BRIDGE);
  uiTick(now);
  delay(5);
}
