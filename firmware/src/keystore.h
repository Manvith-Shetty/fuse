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
  // Owner-signed policy (protocol v2): the owner's ed25519 key and the last accepted policy seq. No owner = v1 state.
  bool hasOwner() const { return hasOwner_; }
  const uint8_t* ownerPub() const { return owner_; }
  uint32_t policySeq() const { return seq_; }
  void setOwner(const uint8_t pub[32], uint32_t seq);  // persists both
private:
  uint8_t seed_[32]; uint8_t pub_[32]; uint64_t nonce_ = 0; uint32_t counter_ = 0;
  uint8_t owner_[32] = {0}; bool hasOwner_ = false; uint32_t seq_ = 0;
  void generateSeed();
};
}
