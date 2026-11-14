#pragma once
// Policy engine. Platform independent (ArduinoJson + crypto_iface only). The chip decides from decoded bytes, never from hints.
#include <string>
#include <vector>
#include <array>
#include <utility>
#include "borsh.h"
#include "codes.h"
namespace fuse {
struct Policy {
  std::string agent;                 // expected signer_id
  std::string wallet;                // expected receiver_id (the fuse-wallet contract)
  std::vector<std::string> methods;  // allowed method names (pay, record_refusal, request_chain_sig, approve_payment)
  std::vector<std::string> receivers;// allowed payment receivers (pay.receiver)
  std::vector<std::string> tokens;   // allowed tokens (pay.token), "near" = native
  std::string perTxCap = "0";        // decimal string, atomic units
  std::string buttonThreshold = "0"; // amount > threshold needs the button
  std::string chainValueCap = "0";   // request_chain_sig.value cap (decimal string)
  std::vector<std::pair<std::string,std::string>> chainDests; // (chain, to)
  uint64_t gasCap = 100000000000000ULL; // 100 Tgas
  uint32_t velocityCap = 20;         // max signs per window
  uint32_t velocityWindowMs = 600000;// 10 minutes
  // protocol v2 (docs/v2-spec.md 2.1); defaults are the permissive v1 behaviour
  bool requireFwArg = false;         // pay / request_chain_sig args must carry "fw" == this chip's fw_sha256
  std::vector<std::array<uint8_t, 32>> decisionSigners; // non-empty: pay needs an attested decision by one of these keys
  bool approveButton = true;         // approve_payment needs the button
};
struct RefusalRecord { uint8_t hash[32]; uint8_t code; uint32_t counter; };
enum class Verdict : uint8_t { SIGN = 0, SIGN_WITH_BUTTON = 1, REFUSE = 2 };
struct Decision { Verdict verdict = Verdict::REFUSE; uint8_t code = BAD_BORSH; std::string detail; std::string summary; };

// Parse / serialize policy JSON (schema in docs/protocol.md). Returns false on malformed input.
bool policyFromJson(const std::string& json, Policy& out, std::string& err);
std::string policyToJson(const Policy& p);
// Default policy baked into firmware; overridden by NVS when present.
Policy defaultPolicy();

struct EvalContext {
  const uint8_t* chipPub;            // 32 bytes
  uint64_t lastNonce;                // last nonce this chip signed
  uint32_t recentSigns;              // signs within the velocity window
  const std::vector<RefusalRecord>* refusals; // refusals this chip issued (for record_refusal matching)
  const char* fwSha256 = nullptr;    // this chip's firmware hash, lowercase hex (spec 2.4); null = unknown
};
Decision evaluate(const Policy& p, const DecodedTx& tx, const EvalContext& ctx);

// Attested decision attached to a `sign` request (spec 2.3). Strings exactly as received; decoding happens in checkDecision.
struct DecisionFields {
  bool present = false;              // the request carried a "decision" object
  std::string text;                  // "<model>:<req_sha256_hex>:<resp_sha256_hex>"
  std::string sigB64;                // ed25519 over sha256(text), base64
  std::string signer;                // "ed25519:<b58>" or bare base58
  bool hasResp = false;
  std::string respB64;               // optional response bytes, base64, <= 8 KiB decoded
};
enum class Binding : uint8_t { NONE = 0, ENVELOPE = 1, BOUND = 2 };
inline const char* bindingName(Binding b) { return b == Binding::BOUND ? "bound" : b == Binding::ENVELOPE ? "envelope" : "none"; }
// Pure check, run after evaluate() passed for a `pay`. Returns CODE_OK, DECISION_REQUIRED or DECISION_INVALID.
// With an empty decision_signers list it returns CODE_OK / Binding::NONE without looking at the decision.
uint8_t checkDecision(const Policy& p, const DecodedTx& pay, const DecisionFields& d, std::string& detail, Binding& binding);

// pay.receiver as a string if `tx` is a pay whose args parse and carry a string receiver, else "" (spec 2.6).
std::string payReceiver(const DecodedTx& tx);
// digest_v2 = sha256("FUSE_REFUSAL_V2" || tx_hash || code || counter_le || receiver_hash), receiver_hash = sha256(receiver) or 32 zero bytes.
void refusalDigestV2(const uint8_t txHash[32], uint8_t code, uint32_t counter, const std::string& receiver, uint8_t out[32]);
// Owner message for policy_set, scheme "raw": sha256("FUSE_POLICY_V1" || sha256(policyJson) || seq_u32_le) (spec 2.2).
void policyAuthDigest(const std::string& policyJson, uint32_t seq, uint8_t out[32]);
// Scheme "nep413" (browser wallets): the chip builds message = "FUSE_POLICY_V1:" + hex(sha256(policyJson)) + ":" + seq itself
// and the owner signs the NEP-413 payload hash:
//   sha256(u32_le(2147484061) || borsh_string(message) || nonce[32] || borsh_string(recipient) || (callback ? 0x01 || borsh_string(callback) : 0x00))
std::string policyAuthMessage(const std::string& policyJson, uint32_t seq);
void policyAuthDigestNep413(const std::string& policyJson, uint32_t seq, const uint8_t nonce[32], const std::string& recipient,
                            const std::string* callbackUrl, uint8_t out[32]);
}
