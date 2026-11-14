#include "borsh.h"
#include <string.h>
namespace fuse {
namespace {
struct Reader {
  const uint8_t* p; size_t len; size_t o = 0; bool bad = false;
  bool need(size_t n) { if (o + n > len) { bad = true; return false; } return true; }
  uint8_t u8() { if (!need(1)) return 0; return p[o++]; }
  uint32_t u32() { if (!need(4)) return 0; uint32_t v = (uint32_t)p[o] | ((uint32_t)p[o+1] << 8) | ((uint32_t)p[o+2] << 16) | ((uint32_t)p[o+3] << 24); o += 4; return v; }
  uint64_t u64() { if (!need(8)) return 0; uint64_t v = 0; for (int i = 7; i >= 0; --i) v = (v << 8) | p[o+i]; o += 8; return v; }
  bool bytes(uint8_t* dst, size_t n) { if (!need(n)) return false; memcpy(dst, p + o, n); o += n; return true; }
  bool str(std::string& dst, uint32_t maxLen) {
    uint32_t l = u32(); if (bad) return false;
    if (l > maxLen || !need(l)) { bad = true; return false; }
    dst.assign((const char*)p + o, l); o += l; return true;
  }
};
}

Code decodeTransaction(const uint8_t* buf, size_t len, DecodedTx& out) {
  if (len == 0 || len > 8192) return TX_TOO_LARGE;
  Reader r{buf, len};
  if (!r.str(out.signer, 64)) return BAD_BORSH;
  out.keyType = r.u8();
  if (r.bad || out.keyType != 0) return BAD_BORSH;         // only ed25519 keys are ours
  if (!r.bytes(out.pubkey, 32)) return BAD_BORSH;
  out.nonce = r.u64(); if (r.bad) return BAD_BORSH;
  if (!r.str(out.receiver, 64)) return BAD_BORSH;
  if (!r.bytes(out.blockHash, 32)) return BAD_BORSH;
  out.nActions = r.u32(); if (r.bad) return BAD_BORSH;
  if (out.nActions == 0) return BAD_BORSH;
  if (out.nActions != 1) return MULTI_ACTION;
  out.actionTag = r.u8(); if (r.bad) return BAD_BORSH;
  if (out.actionTag != 2) return NOT_FUNCTION_CALL;
  if (!r.str(out.method, 64)) return BAD_BORSH;
  if (!r.str(out.args, 4096)) return BAD_BORSH;
  out.gas = r.u64(); if (r.bad) return BAD_BORSH;
  out.depositLo = r.u64(); out.depositHi = r.u64(); if (r.bad) return BAD_BORSH;
  if (r.o != len) return TRAILING_BYTES;
  return CODE_OK;
}
}
