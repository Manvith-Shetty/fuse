#pragma once
// Strict decoder for a NEAR `Transaction` (Borsh). Platform independent: no Arduino headers.
// Layout verified against near-api-js 7.5.3 on 2026-11-13 (bridge/scripts/borsh-vector.mjs).
#include <stdint.h>
#include <stddef.h>
#include <string>
#include "codes.h"
namespace fuse {
struct DecodedTx {
  std::string signer;
  uint8_t keyType = 0;        // 0 = ed25519
  uint8_t pubkey[32] = {0};
  uint64_t nonce = 0;
  std::string receiver;
  uint8_t blockHash[32] = {0};
  uint32_t nActions = 0;
  uint8_t actionTag = 0xff;   // 2 = FunctionCall
  std::string method;
  std::string args;           // raw bytes (JSON for our contract)
  uint64_t gas = 0;
  uint64_t depositLo = 0, depositHi = 0;  // u128 little endian halves
};
// Returns OK, or the first failing Code. Only a FunctionCall with exactly one action decodes to OK.
// Limits: account ids <= 64 bytes, method <= 64, args <= 4096, total <= 8192.
Code decodeTransaction(const uint8_t* buf, size_t len, DecodedTx& out);
}
