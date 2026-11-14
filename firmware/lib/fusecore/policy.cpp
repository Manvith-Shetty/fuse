#include "policy.h"
#include "util.h"
#include "crypto_iface.h"
#include <ArduinoJson.h>
#include <string.h>
namespace fuse {

Policy defaultPolicy() {
  Policy p;
  p.agent = "agent.example.testnet"; p.wallet = "fuse.example.testnet";
  p.methods = {"pay", "record_refusal", "request_chain_sig"};
  p.receivers = {}; p.tokens = {"near"};
  p.perTxCap = "1000000000000000000000000";      // 1 NEAR in yocto
  p.buttonThreshold = "500000000000000000000000"; // 0.5 NEAR
  p.chainValueCap = "0";
  return p;
}

static bool has(const std::vector<std::string>& v, const std::string& s) {
  for (auto& x : v) if (x == s) return true; return false;
}

bool policyFromJson(const std::string& json, Policy& out, std::string& err) {
  JsonDocument doc;
  auto e = deserializeJson(doc, json);
  if (e) { err = e.c_str(); return false; }
  Policy p;
  p.agent = doc["agent"] | ""; p.wallet = doc["wallet"] | "";
  if (p.agent.empty() || p.wallet.empty()) { err = "agent and wallet required"; return false; }
  for (JsonVariant v : doc["methods"].as<JsonArray>()) p.methods.push_back(v.as<const char*>() ? v.as<const char*>() : "");
  for (JsonVariant v : doc["receivers"].as<JsonArray>()) p.receivers.push_back(v.as<const char*>() ? v.as<const char*>() : "");
  for (JsonVariant v : doc["tokens"].as<JsonArray>()) p.tokens.push_back(v.as<const char*>() ? v.as<const char*>() : "");
  p.perTxCap = doc["per_tx_cap"] | "0"; p.buttonThreshold = doc["button_threshold"] | "0";
  p.chainValueCap = doc["chain_value_cap"] | "0";
  if (!isDecimal(p.perTxCap) || !isDecimal(p.buttonThreshold) || !isDecimal(p.chainValueCap)) { err = "caps must be decimal strings"; return false; }
  for (JsonObject o : doc["chain_dests"].as<JsonArray>()) {
    std::string c = o["chain"] | "", t = o["to"] | "";
    if (!c.empty() && !t.empty()) p.chainDests.push_back({c, t});
  }
  p.gasCap = doc["gas_cap"] | (uint64_t)100000000000000ULL;
  p.velocityCap = doc["velocity_cap"] | (uint32_t)20;
  p.velocityWindowMs = doc["velocity_window_ms"] | (uint32_t)600000;
  // v2 fields: absent means the permissive default (compatibility rule in docs/v2-spec.md)
  p.requireFwArg = doc["require_fw_arg"] | false;
  p.approveButton = doc["approve_button"] | true;
  for (JsonVariant v : doc["decision_signers"].as<JsonArray>()) {
    const char* s = v.as<const char*>(); std::array<uint8_t, 32> k{};
    if (!s || !parseKey32(s, k.data())) { err = "decision_signers entries must be ed25519 base58 32-byte keys"; return false; }
    p.decisionSigners.push_back(k);
  }
  if (p.methods.empty()) { err = "methods required"; return false; }
  out = p; return true;
}

std::string policyToJson(const Policy& p) {
  JsonDocument doc;
  doc["agent"] = p.agent; doc["wallet"] = p.wallet;
  auto m = doc["methods"].to<JsonArray>(); for (auto& s : p.methods) m.add(s);
  auto r = doc["receivers"].to<JsonArray>(); for (auto& s : p.receivers) r.add(s);
  auto t = doc["tokens"].to<JsonArray>(); for (auto& s : p.tokens) t.add(s);
  doc["per_tx_cap"] = p.perTxCap; doc["button_threshold"] = p.buttonThreshold; doc["chain_value_cap"] = p.chainValueCap;
  auto cd = doc["chain_dests"].to<JsonArray>();
  for (auto& pr : p.chainDests) { auto o = cd.add<JsonObject>(); o["chain"] = pr.first; o["to"] = pr.second; }
  doc["gas_cap"] = p.gasCap; doc["velocity_cap"] = p.velocityCap; doc["velocity_window_ms"] = p.velocityWindowMs;
  doc["require_fw_arg"] = p.requireFwArg;
  auto ds = doc["decision_signers"].to<JsonArray>();
  for (auto& k : p.decisionSigners) ds.add("ed25519:" + base58Encode(k.data(), 32));
  doc["approve_button"] = p.approveButton;
  std::string s; serializeJson(doc, s); return s;
}

static Decision refuse(uint8_t code, const std::string& detail) {
  Decision d; d.verdict = Verdict::REFUSE; d.code = code; d.detail = detail; return d;
}

static bool ieq(const char* a, const char* b) {
  for (;; a++, b++) {
    char x = *a, y = *b;
    if (x >= 'A' && x <= 'Z') x += 32; if (y >= 'A' && y <= 'Z') y += 32;
    if (x != y) return false; if (!x) return true;
  }
}

// fw attestation argument (spec 2.4): present -> must equal this chip's fw_sha256; absent -> fine unless the policy requires it.
// Same check order as bridge/src/policy.ts fwCheck (after the method's own allowlist and cap checks).
static bool fwCheck(const Policy& p, JsonObjectConst args, const EvalContext& ctx, std::string& detail) {
  bool present = false; JsonVariantConst fw;
  for (JsonPairConst kv : args) if (!strcmp(kv.key().c_str(), "fw")) { present = true; fw = kv.value(); break; }
  if (present) {
    const char* s = fw.as<const char*>();
    if (!s || !ctx.fwSha256 || !*ctx.fwSha256 || !ieq(s, ctx.fwSha256)) {
      std::string shown = s ? std::string(s).substr(0, 16) : (fw.isNull() ? "null" : "non-string");
      detail = "fw " + shown + " is not this chip"; return false;
    }
  } else if (p.requireFwArg) { detail = "policy requires the fw argument"; return false; }
  return true;
}

Decision evaluate(const Policy& p, const DecodedTx& tx, const EvalContext& ctx) {
  // Structural checks already passed in decodeTransaction (one FunctionCall, no trailing bytes).
  if (tx.signer != p.agent) return refuse(WRONG_SIGNER, "signer " + tx.signer);
  if (memcmp(tx.pubkey, ctx.chipPub, 32) != 0) return refuse(WRONG_KEY, "public key is not this chip");
  if (tx.receiver != p.wallet) return refuse(WRONG_RECEIVER, "receiver " + tx.receiver);
  if (!has(p.methods, tx.method)) return refuse(METHOD_NOT_ALLOWED, "method " + tx.method);
  if (tx.depositLo != 0 || tx.depositHi != 0) return refuse(DEPOSIT_NOT_ZERO, "deposit attached");
  if (tx.gas > p.gasCap) return refuse(GAS_TOO_HIGH, "gas over cap");
  if (tx.nonce <= ctx.lastNonce) return refuse(NONCE_REPLAY, "nonce not increasing");
  if (ctx.recentSigns >= p.velocityCap) return refuse(VELOCITY_CAP, "too many signatures in window");

  JsonDocument doc;
  if (deserializeJson(doc, tx.args)) return refuse(BAD_ARGS, "args not JSON");
  if (!doc.is<JsonObject>()) return refuse(BAD_ARGS, "args not an object");
  JsonObjectConst args = doc.as<JsonObjectConst>();
  std::string detail;

  Decision d; d.verdict = Verdict::SIGN; d.code = CODE_OK;
  if (tx.method == "pay") {
    std::string receiver = doc["receiver"] | "", token = doc["token"] | "", amount = doc["amount"] | "";
    if (receiver.empty() || token.empty() || !isDecimal(amount)) return refuse(BAD_ARGS, "pay needs receiver, token, decimal amount");
    if (!has(p.receivers, receiver)) return refuse(RECEIVER_NOT_ALLOWED, "receiver " + receiver);
    if (!has(p.tokens, token)) return refuse(TOKEN_NOT_ALLOWED, "token " + token);
    bool ok; if (cmpDecimal(amount, p.perTxCap, ok) > 0 || !ok) return refuse(AMOUNT_OVER_CAP, "amount " + amount + " > cap " + p.perTxCap);
    if (!fwCheck(p, args, ctx, detail)) return refuse(FW_MISMATCH, detail);
    if (cmpDecimal(amount, p.buttonThreshold, ok) > 0) d.verdict = Verdict::SIGN_WITH_BUTTON;
    d.summary = "pay " + amount + " " + token + " -> " + receiver;
    return d;
  }
  if (tx.method == "record_refusal") {
    std::string hashB58 = doc["tx_hash"] | ""; uint8_t code = doc["code"] | 0; uint32_t counter = doc["counter"] | 0;
    std::vector<uint8_t> h; if (!base58Decode(hashB58, h) || h.size() != 32) return refuse(BAD_ARGS, "tx_hash must be base58 32 bytes");
    bool found = false;
    if (ctx.refusals) for (auto& r : *ctx.refusals) if (r.counter == counter && r.code == code && memcmp(r.hash, h.data(), 32) == 0) found = true;
    if (!found) return refuse(REFUSAL_MISMATCH, "no such refusal issued by this chip");
    d.summary = "record refusal #" + std::to_string(counter);
    return d;
  }
  if (tx.method == "request_chain_sig") {
    std::string chain = doc["chain"] | "", to = doc["to"] | "", value = doc["value"] | "";
    if (chain.empty() || to.empty() || !isDecimal(value)) return refuse(BAD_ARGS, "chain, to, decimal value required");
    bool okDest = false; for (auto& pr : p.chainDests) if (pr.first == chain && pr.second == to) okDest = true;
    if (!okDest) return refuse(CHAIN_DEST_NOT_ALLOWED, chain + ":" + to);
    bool ok; if (cmpDecimal(value, p.chainValueCap, ok) > 0 || !ok) return refuse(CHAIN_VALUE_OVER_CAP, "value " + value);
    if (!fwCheck(p, args, ctx, detail)) return refuse(FW_MISMATCH, detail);
    d.verdict = Verdict::SIGN_WITH_BUTTON; // cross-chain always needs a finger
    d.summary = "chain_sig " + chain + " " + value + " -> " + to;
    return d;
  }
  if (tx.method == "approve_payment") {
    // Second-chip approval of a pending payment (spec 2.5). The id is the only argument: a JSON unsigned integer or a decimal string.
    JsonVariantConst idv = doc["id"]; std::string id;
    if (idv.is<const char*>()) { const char* s = idv.as<const char*>(); if (s && isDecimal(s)) id = stripLeadingZeros(s); }
    else if (idv.is<unsigned long long>()) id = std::to_string(idv.as<unsigned long long>());
    if (id.empty()) return refuse(APPROVAL_NOT_ALLOWED, "approve_payment needs an integer id");
    d.verdict = p.approveButton ? Verdict::SIGN_WITH_BUTTON : Verdict::SIGN;
    d.summary = "approve payment #" + id;
    return d;
  }
  return refuse(METHOD_NOT_ALLOWED, "no rule for " + tx.method);
}

static bool payArgs(const DecodedTx& tx, std::string& receiver, std::string& amount) {
  if (tx.method != "pay") return false;
  JsonDocument doc; if (deserializeJson(doc, tx.args) || !doc.is<JsonObject>()) return false;
  const char* r = doc["receiver"].as<const char*>(); if (!r) return false;
  receiver = r;
  JsonVariantConst a = doc["amount"];
  if (a.is<const char*>()) amount = a.as<const char*>();
  else if (a.isNull()) amount.clear();
  else { std::string s; serializeJson(a, s); amount = s; }  // String(a.amount) in the bridge mirror
  return true;
}

std::string payReceiver(const DecodedTx& tx) { std::string r, a; return payArgs(tx, r, a) ? r : std::string(); }

// Same order and codes as bridge/src/policy.ts checkDecision.
uint8_t checkDecision(const Policy& p, const DecodedTx& pay, const DecisionFields& d, std::string& detail, Binding& binding) {
  binding = Binding::NONE; detail.clear();
  if (p.decisionSigners.empty()) return CODE_OK;
  if (!d.present) { detail = "policy requires an attested decision"; return DECISION_REQUIRED; }
  uint8_t signer[32];
  bool known = false;
  if (parseKey32(d.signer, signer)) for (auto& k : p.decisionSigners) if (memcmp(k.data(), signer, 32) == 0) known = true;
  if (!known) { detail = "signer not in decision_signers"; return DECISION_INVALID; }
  std::vector<uint8_t> sig; if (!base64Decode(d.sigB64, sig) || sig.size() != 64) { detail = "signature must be 64 bytes"; return DECISION_INVALID; }
  uint8_t th[32]; sha256((const uint8_t*)d.text.data(), d.text.size(), th);
  if (!ed25519Verify(sig.data(), th, 32, signer)) { detail = "signature does not verify"; return DECISION_INVALID; }
  if (!d.hasResp) { binding = Binding::ENVELOPE; return CODE_OK; }
  std::vector<uint8_t> resp; if (!base64Decode(d.respB64, resp)) { detail = "response is not base64"; return DECISION_INVALID; }
  if (resp.size() > 8192) { detail = "response over 8 KiB"; return DECISION_INVALID; }
  uint8_t rh[32]; sha256(resp.data(), resp.size(), rh); std::string rhHex = hexEncode(rh, 32);
  size_t c1 = d.text.find(':'), last = d.text.rfind(':');
  std::string third = (c1 != std::string::npos && last != std::string::npos && last != c1) ? d.text.substr(last + 1) : std::string();
  if (third.empty() || !ieq(third.c_str(), rhHex.c_str())) { detail = "response hash does not match the signed text"; return DECISION_INVALID; }
  std::string receiver, amount; payArgs(pay, receiver, amount);
  std::string s((const char*)resp.data(), resp.size());
  if (receiver.empty() || s.find(receiver) == std::string::npos || s.find(amount) == std::string::npos) { detail = "response does not mention this receiver and amount"; return DECISION_INVALID; }
  binding = Binding::BOUND; return CODE_OK;
}

void refusalDigestV2(const uint8_t txHash[32], uint8_t code, uint32_t counter, const std::string& receiver, uint8_t out[32]) {
  uint8_t buf[15 + 32 + 1 + 4 + 32]; memcpy(buf, "FUSE_REFUSAL_V2", 15); memcpy(buf + 15, txHash, 32); buf[47] = code;
  buf[48] = counter & 0xff; buf[49] = (counter >> 8) & 0xff; buf[50] = (counter >> 16) & 0xff; buf[51] = (counter >> 24) & 0xff;
  if (receiver.empty()) memset(buf + 52, 0, 32); else sha256((const uint8_t*)receiver.data(), receiver.size(), buf + 52);
  sha256(buf, sizeof(buf), out);
}

std::string policyAuthMessage(const std::string& policyJson, uint32_t seq) {
  uint8_t ph[32]; sha256((const uint8_t*)policyJson.data(), policyJson.size(), ph);
  return "FUSE_POLICY_V1:" + hexEncode(ph, 32) + ":" + std::to_string(seq);
}

static void putU32(std::vector<uint8_t>& v, uint32_t x) { for (int i = 0; i < 4; i++) v.push_back((uint8_t)(x >> (8 * i))); }
static void putBorshString(std::vector<uint8_t>& v, const std::string& s) { putU32(v, (uint32_t)s.size()); v.insert(v.end(), s.begin(), s.end()); }

void policyAuthDigestNep413(const std::string& policyJson, uint32_t seq, const uint8_t nonce[32], const std::string& recipient,
                            const std::string* callbackUrl, uint8_t out[32]) {
  std::vector<uint8_t> v; v.reserve(4 + 4 + 96 + 32 + 4 + recipient.size() + 1 + (callbackUrl ? 4 + callbackUrl->size() : 0));
  putU32(v, 2147484061u);                       // NEP-413 tag: 2^31 + 413
  putBorshString(v, policyAuthMessage(policyJson, seq));
  v.insert(v.end(), nonce, nonce + 32);
  putBorshString(v, recipient);
  if (callbackUrl) { v.push_back(1); putBorshString(v, *callbackUrl); } else v.push_back(0);
  sha256(v.data(), v.size(), out);
}

void policyAuthDigest(const std::string& policyJson, uint32_t seq, uint8_t out[32]) {
  uint8_t buf[14 + 32 + 4]; memcpy(buf, "FUSE_POLICY_V1", 14);
  sha256((const uint8_t*)policyJson.data(), policyJson.size(), buf + 14);
  buf[46] = seq & 0xff; buf[47] = (seq >> 8) & 0xff; buf[48] = (seq >> 16) & 0xff; buf[49] = (seq >> 24) & 0xff;
  sha256(buf, sizeof(buf), out);
}
}
