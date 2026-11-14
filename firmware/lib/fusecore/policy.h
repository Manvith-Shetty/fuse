#pragma once
// Policy engine. Platform independent (ArduinoJson only). The chip decides from decoded bytes, never from hints.
#include <string>
#include <vector>
#include <utility>
#include "borsh.h"
#include "codes.h"
namespace fuse {
struct Policy {
  std::string agent;                 // expected signer_id
  std::string wallet;                // expected receiver_id (the fuse-wallet contract)
  std::vector<std::string> methods;  // allowed method names
  std::vector<std::string> receivers;// allowed payment receivers (pay.receiver)
  std::vector<std::string> tokens;   // allowed tokens (pay.token), "near" = native
  std::string perTxCap = "0";        // decimal string, atomic units
  std::string buttonThreshold = "0"; // amount > threshold needs the button
  std::string chainValueCap = "0";   // request_chain_sig.value cap (decimal string)
  std::vector<std::pair<std::string,std::string>> chainDests; // (chain, to)
  uint64_t gasCap = 100000000000000ULL; // 100 Tgas
  uint32_t velocityCap = 20;         // max signs per window
  uint32_t velocityWindowMs = 600000;// 10 minutes
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
};
Decision evaluate(const Policy& p, const DecodedTx& tx, const EvalContext& ctx);
}
