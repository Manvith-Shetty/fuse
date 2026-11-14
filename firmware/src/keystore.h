#pragma once
#include <stdint.h>
#include <string>
namespace fuse {
// NVS-backed secrets and counters. The seed never leaves this module except into Ed25519::sign.
class Keystore {
public:
  void begin();                       // loads or generates the seed; derives the public key
  const uint8_t* pub() const { return pub_; }
  void sign(const uint8_t* msg, size_t len, uint8_t sig[64]) const;
  uint64_t lastNonce() const { return nonce_; }
  void setLastNonce(uint64_t n);
  uint32_t counter() const { return counter_; }
  uint32_t nextCounter();             // persists and returns the new value
  std::string policyJson() const;     // "" if none stored
  void setPolicyJson(const std::string& j);
private:
  uint8_t seed_[32]; uint8_t pub_[32]; uint64_t nonce_ = 0; uint32_t counter_ = 0;
  void generateSeed();
};
}
