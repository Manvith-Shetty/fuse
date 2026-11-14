// Fuse firmware: a NEAR function-call key that lives in this chip and signs only what it has decoded and
// policy-checked itself. No network. Newline-delimited JSON over USB serial (docs/protocol.md).
#include <Arduino.h>
#include "esp_app_desc.h"
#include <ArduinoJson.h>
#include <SHA256.h>
#include <vector>
#include <string>
#include "borsh.h"
#include "policy.h"
#include "util.h"
#include "codes.h"
#include "keystore.h"
#include "ui.h"
using namespace fuse;

#ifndef FUSE_FW_VERSION
#define FUSE_FW_VERSION "0.1.0"
#endif
static const uint32_t BUTTON_TIMEOUT_MS = 30000;
static const uint32_t BRIDGE_TIMEOUT_MS = 6000;

static Keystore ks;
static Policy policy;
static std::string policyJson;
static std::vector<RefusalRecord> refusals;     // ring of the last 16 refusals this chip issued
static std::vector<uint32_t> signTimes;         // millis() of recent signatures (velocity window)
static uint32_t lastPingMs = 0;
static String lineBuf;

static void sha256(const uint8_t* d, size_t n, uint8_t out[32]) { SHA256 h; h.update(d, n); h.finalize(out, 32); }
static std::string policyHash() { uint8_t h[32]; sha256((const uint8_t*)policyJson.data(), policyJson.size(), h); return hexEncode(h, 8); }
static void send(JsonDocument& doc) { serializeJson(doc, Serial); Serial.write('\n'); Serial.flush(); }  // flush: native USB CDC holds short writes
static void sendError(const char* id, uint8_t code, const std::string& detail) {
  JsonDocument d; d["id"] = id; d["ok"] = false; d["code"] = codeName(code); d["detail"] = detail; send(d);
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

// Refusal receipt: sign sha256("FUSE_REFUSAL_V1" || tx_hash || code || counter_le) so the chain can verify the chip issued it.
static std::string issueRefusalReceipt(const uint8_t txHash[32], uint8_t code, uint32_t& counterOut) {
  counterOut = ks.nextCounter();
  uint8_t buf[15 + 32 + 1 + 4]; memcpy(buf, "FUSE_REFUSAL_V1", 15); memcpy(buf + 15, txHash, 32); buf[47] = code;
  buf[48] = counterOut & 0xff; buf[49] = (counterOut >> 8) & 0xff; buf[50] = (counterOut >> 16) & 0xff; buf[51] = (counterOut >> 24) & 0xff;
  uint8_t digest[32]; sha256(buf, sizeof(buf), digest);
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
  const esp_app_desc_t* app = esp_app_get_description(); d["fw_sha256"] = hexEncode(app->app_elf_sha256, 32);
  d["last_nonce"] = ks.lastNonce(); d["mode"] = "HARDWARE";
#ifdef FUSE_RGB_PIN
  d["board"] = "esp32s3";
#else
  d["board"] = "esp32";
#endif
  send(d);
}

static void handleSign(const char* id, JsonVariantConst req) {
  std::string txB64 = req["tx"] | "";
  std::vector<uint8_t> tx; if (!base64Decode(txB64, tx) || tx.empty()) { sendError(id, BAD_BORSH, "tx must be base64"); return; }
  uint8_t txHash[32]; sha256(tx.data(), tx.size(), txHash);
  std::string hashB58 = base58Encode(txHash, 32);

  uiSet(Led::BUSY);
  DecodedTx dec; Code c = decodeTransaction(tx.data(), tx.size(), dec);
  Decision dcs;
  if (c != CODE_OK) { dcs.verdict = Verdict::REFUSE; dcs.code = c; dcs.detail = "structural"; }
  else { EvalContext ctx{ks.pub(), ks.lastNonce(), recentSigns(millis()), &refusals}; dcs = evaluate(policy, dec, ctx); }

  if (dcs.verdict == Verdict::SIGN_WITH_BUTTON) {
    JsonDocument n; n["id"] = id; n["event"] = "button_required"; n["summary"] = dcs.summary; n["timeout_ms"] = BUTTON_TIMEOUT_MS; send(n);
    if (!waitForButton(BUTTON_TIMEOUT_MS)) { dcs.verdict = Verdict::REFUSE; dcs.code = BUTTON_TIMEOUT; dcs.detail = "no button press within timeout"; }
  }

  JsonDocument d; d["id"] = id; d["hash"] = hashB58;
  if (c == CODE_OK) { d["decoded"]["signer"] = dec.signer; d["decoded"]["receiver"] = dec.receiver; d["decoded"]["method"] = dec.method; d["decoded"]["nonce"] = dec.nonce; d["decoded"]["gas"] = dec.gas; }
  if (dcs.verdict == Verdict::REFUSE) {
    uint32_t counter; std::string receipt = issueRefusalReceipt(txHash, dcs.code, counter);
    d["ok"] = false; d["code"] = codeName(dcs.code); d["code_num"] = dcs.code; d["detail"] = dcs.detail;
    d["receipt"] = receipt; d["counter"] = counter;
    uiSet(Led::IDLE); send(d); uiBlink(Led::REFUSED, 5); return;
  }
  uint8_t sig[64]; ks.sign(txHash, 32, sig);
  ks.setLastNonce(dec.nonce); signTimes.push_back(millis());
  d["ok"] = true; d["sig"] = base64Encode(sig, 64); d["summary"] = dcs.summary; d["button"] = (dcs.verdict == Verdict::SIGN_WITH_BUTTON);
  uiSet(Led::IDLE); send(d); uiBlink(Led::SIGNED, 3);
}

static void handlePolicySet(const char* id, JsonVariantConst req) {
  std::string j; serializeJson(req["policy"], j);
  Policy p; std::string err;
  if (j.empty() || j == "null" || !policyFromJson(j, p, err)) { sendError(id, BAD_POLICY, err.empty() ? "policy missing" : err); return; }
  JsonDocument n; n["id"] = id; n["event"] = "button_required"; n["summary"] = "update policy"; n["timeout_ms"] = BUTTON_TIMEOUT_MS; send(n);
  if (!waitForButton(BUTTON_TIMEOUT_MS)) { sendError(id, BUTTON_TIMEOUT, "policy update not confirmed"); return; }
  policy = p; policyJson = policyToJson(p); ks.setPolicyJson(policyJson);
  JsonDocument d; d["id"] = id; d["ok"] = true; d["policy_hash"] = policyHash(); send(d); uiBlink(Led::SIGNED, 2);
}

static void handleLine(const String& line) {
  JsonDocument req; if (deserializeJson(req, line)) { sendError("", BAD_ARGS, "line is not JSON"); return; }
  const char* op = req["op"] | ""; const char* id = req["id"] | "";
  if (!strcmp(op, "hello")) handleHello(id);
  else if (!strcmp(op, "ping")) { lastPingMs = millis(); if (uiStateIsNoBridge()) uiSet(Led::IDLE); JsonDocument d; d["id"] = id; d["pong"] = true; d["uptime_ms"] = millis(); send(d); }
  else if (!strcmp(op, "sign")) { lastPingMs = millis(); handleSign(id, req.as<JsonVariantConst>()); }
  else if (!strcmp(op, "policy_get")) { JsonDocument d; d["id"] = id; d["ok"] = true; JsonDocument p; deserializeJson(p, policyJson); d["policy"] = p; d["policy_hash"] = policyHash(); send(d); }
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
  Serial.setRxBufferSize(16384); // a sign request is ~450 bytes and native USB delivers it in one burst; the default 256-byte RX buffer overflows
  Serial.begin(FUSE_BAUD);
  uiBegin(); uiSet(Led::BUSY);
  ks.begin(); loadPolicy();
  lastPingMs = millis();
  uiSet(Led::IDLE);
  JsonDocument d; d["event"] = "ready"; d["pubkey"] = "ed25519:" + base58Encode(ks.pub(), 32); d["fw"] = FUSE_FW_VERSION; send(d);
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n') { if (lineBuf.length()) handleLine(lineBuf); lineBuf = ""; }
    else if (lineBuf.length() < 12000) lineBuf += c;
    else lineBuf = ""; // oversize line: drop
  }
  uint32_t now = millis();
  if (now - lastPingMs > BRIDGE_TIMEOUT_MS && !uiStateIsNoBridge()) uiSet(Led::NO_BRIDGE);
  uiTick(now);
  delay(5);
}
