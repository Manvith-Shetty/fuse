// Board implementation of lib/fusecore/crypto_iface.h on top of rweather/Crypto.
#include "crypto_iface.h"
#include <SHA256.h>
#include <Ed25519.h>
namespace fuse {
void sha256(const uint8_t* data, size_t len, uint8_t out[32]) { SHA256 h; h.update(data, len); h.finalize(out, 32); }
bool ed25519Verify(const uint8_t sig[64], const uint8_t* msg, size_t len, const uint8_t pub[32]) { return Ed25519::verify(sig, pub, msg, len); }
}
