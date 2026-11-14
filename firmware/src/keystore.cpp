#include "keystore.h"
#include <Arduino.h>
#include <Preferences.h>
#include <Ed25519.h>
#include <esp_random.h>
#include <esp_system.h>
#include <string.h>
extern "C" { void bootloader_random_enable(void); void bootloader_random_disable(void); }
namespace fuse {
static Preferences prefs;
static const char* NS = "fuse";

void Keystore::generateSeed() {
  // With the radio off, esp_random() is weak unless the bootloader RNG is enabled. Mix several sources.
  bootloader_random_enable();
  uint8_t a[32], b[32];
  esp_fill_random(a, 32);
  for (int i = 0; i < 32; i++) { b[i] = (uint8_t)analogRead(36) ^ (uint8_t)(micros() & 0xff); delayMicroseconds(37 + (a[i] % 29)); }
  esp_fill_random(seed_, 32);
  for (int i = 0; i < 32; i++) seed_[i] ^= a[i] ^ b[(i * 7) % 32];
  bootloader_random_disable();
  prefs.putBytes("seed", seed_, 32);
}

void Keystore::begin() {
  prefs.begin(NS, false);
  if (prefs.getBytesLength("seed") == 32) prefs.getBytes("seed", seed_, 32); else generateSeed();
  Ed25519::derivePublicKey(pub_, seed_);
  nonce_ = prefs.getULong64("nonce", 0);
  counter_ = prefs.getUInt("counter", 0);
  hasOwner_ = prefs.getBytesLength("owner") == 32;
  if (hasOwner_) prefs.getBytes("owner", owner_, 32);
  seq_ = prefs.getUInt("pseq", 0);
}
void Keystore::sign(const uint8_t* msg, size_t len, uint8_t sig[64]) const { Ed25519::sign(sig, seed_, pub_, msg, len); }
void Keystore::setLastNonce(uint64_t n) { nonce_ = n; prefs.putULong64("nonce", n); }
uint32_t Keystore::nextCounter() { counter_++; prefs.putUInt("counter", counter_); return counter_; }
std::string Keystore::policyJson() const { String s = prefs.getString("policy", ""); return std::string(s.c_str()); }
void Keystore::setPolicyJson(const std::string& j) { prefs.putString("policy", j.c_str()); }
void Keystore::setOwner(const uint8_t pub[32], uint32_t seq) {
  memcpy(owner_, pub, 32); hasOwner_ = true; seq_ = seq;
  prefs.putBytes("owner", owner_, 32); prefs.putUInt("pseq", seq);
}
}
