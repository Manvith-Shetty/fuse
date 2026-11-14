#pragma once
#include <stdint.h>
namespace fuse {
// Refusal / decision codes. Names are the wire format (docs/protocol.md). Keep in sync with bridge/src/codes.ts.
enum Code : uint8_t {
  CODE_OK = 0,
  BAD_BORSH = 1, TRAILING_BYTES = 2, MULTI_ACTION = 3, NOT_FUNCTION_CALL = 4,
  WRONG_SIGNER = 5, WRONG_KEY = 6, WRONG_RECEIVER = 7, METHOD_NOT_ALLOWED = 8,
  DEPOSIT_NOT_ZERO = 9, GAS_TOO_HIGH = 10, NONCE_REPLAY = 11, BAD_ARGS = 12,
  RECEIVER_NOT_ALLOWED = 13, TOKEN_NOT_ALLOWED = 14, AMOUNT_OVER_CAP = 15, VELOCITY_CAP = 16,
  BUTTON_TIMEOUT = 17, REFUSAL_MISMATCH = 18, CHAIN_DEST_NOT_ALLOWED = 19, CHAIN_VALUE_OVER_CAP = 20,
  BAD_POLICY = 21, TX_TOO_LARGE = 22,
  // protocol v2 (docs/v2-spec.md section 1)
  FW_MISMATCH = 23, DECISION_REQUIRED = 24, DECISION_INVALID = 25, OWNER_SIG_INVALID = 26, APPROVAL_NOT_ALLOWED = 27,
};
inline const char* codeName(uint8_t c) {
  switch (c) {
    case CODE_OK: return "OK";
    case BAD_BORSH: return "BAD_BORSH"; case TRAILING_BYTES: return "TRAILING_BYTES";
    case MULTI_ACTION: return "MULTI_ACTION"; case NOT_FUNCTION_CALL: return "NOT_FUNCTION_CALL";
    case WRONG_SIGNER: return "WRONG_SIGNER"; case WRONG_KEY: return "WRONG_KEY";
    case WRONG_RECEIVER: return "WRONG_RECEIVER"; case METHOD_NOT_ALLOWED: return "METHOD_NOT_ALLOWED";
    case DEPOSIT_NOT_ZERO: return "DEPOSIT_NOT_ZERO"; case GAS_TOO_HIGH: return "GAS_TOO_HIGH";
    case NONCE_REPLAY: return "NONCE_REPLAY"; case BAD_ARGS: return "BAD_ARGS";
    case RECEIVER_NOT_ALLOWED: return "RECEIVER_NOT_ALLOWED"; case TOKEN_NOT_ALLOWED: return "TOKEN_NOT_ALLOWED";
    case AMOUNT_OVER_CAP: return "AMOUNT_OVER_CAP"; case VELOCITY_CAP: return "VELOCITY_CAP";
    case BUTTON_TIMEOUT: return "BUTTON_TIMEOUT"; case REFUSAL_MISMATCH: return "REFUSAL_MISMATCH";
    case CHAIN_DEST_NOT_ALLOWED: return "CHAIN_DEST_NOT_ALLOWED"; case CHAIN_VALUE_OVER_CAP: return "CHAIN_VALUE_OVER_CAP";
    case BAD_POLICY: return "BAD_POLICY"; case TX_TOO_LARGE: return "TX_TOO_LARGE";
    case FW_MISMATCH: return "FW_MISMATCH"; case DECISION_REQUIRED: return "DECISION_REQUIRED";
    case DECISION_INVALID: return "DECISION_INVALID"; case OWNER_SIG_INVALID: return "OWNER_SIG_INVALID";
    case APPROVAL_NOT_ALLOWED: return "APPROVAL_NOT_ALLOWED";
    default: return "UNKNOWN";
  }
}
}
