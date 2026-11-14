#pragma once
// Hash and signature primitives the core needs. Implemented in src/crypto_board.cpp (rweather/Crypto) for the
// board and in test/test_native/crypto_host.cpp (vendored TweetNaCl-derived verifier) for `pio test -e native`,
// so policy.cpp stays platform independent and the native tests exercise the real decision checks.
#include <stdint.h>
#include <stddef.h>
namespace fuse {
void sha256(const uint8_t* data, size_t len, uint8_t out[32]);
// Standard ed25519 (RFC 8032) verification of a 64-byte signature over `msg` by `pub`.
bool ed25519Verify(const uint8_t sig[64], const uint8_t* msg, size_t len, const uint8_t pub[32]);
}
