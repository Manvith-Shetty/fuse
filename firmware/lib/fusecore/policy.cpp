#include "policy.h"
#include "util.h"
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
  std::string s; serializeJson(doc, s); return s;
}

static Decision refuse(uint8_t code, const std::string& detail) {
  Decision d; d.verdict = Verdict::REFUSE; d.code = code; d.detail = detail; return d;
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

  Decision d; d.verdict = Verdict::SIGN; d.code = CODE_OK;
  if (tx.method == "pay") {
    std::string receiver = doc["receiver"] | "", token = doc["token"] | "", amount = doc["amount"] | "";
    if (receiver.empty() || token.empty() || !isDecimal(amount)) return refuse(BAD_ARGS, "pay needs receiver, token, decimal amount");
    if (!has(p.receivers, receiver)) return refuse(RECEIVER_NOT_ALLOWED, "receiver " + receiver);
    if (!has(p.tokens, token)) return refuse(TOKEN_NOT_ALLOWED, "token " + token);
    bool ok; if (cmpDecimal(amount, p.perTxCap, ok) > 0 || !ok) return refuse(AMOUNT_OVER_CAP, "amount " + amount + " > cap " + p.perTxCap);
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
    d.verdict = Verdict::SIGN_WITH_BUTTON; // cross-chain always needs a finger
    d.summary = "chain_sig " + chain + " " + value + " -> " + to;
    return d;
  }
  return refuse(METHOD_NOT_ALLOWED, "no rule for " + tx.method);
}
}
