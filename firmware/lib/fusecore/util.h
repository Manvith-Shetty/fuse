#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string>
#include <vector>
namespace fuse {
std::string base58Encode(const uint8_t* data, size_t len);
bool base58Decode(const std::string& s, std::vector<uint8_t>& out);
std::string base64Encode(const uint8_t* data, size_t len);
bool base64Decode(const std::string& s, std::vector<uint8_t>& out);
std::string hexEncode(const uint8_t* data, size_t len);
// Compare two unsigned decimal strings numerically. Returns <0, 0, >0. Sets ok=false if either is not a plain decimal.
int cmpDecimal(const std::string& a, const std::string& b, bool& ok);
bool isDecimal(const std::string& s);
// "007" -> "7", "000" -> "0". Input must already be a decimal string.
std::string stripLeadingZeros(const std::string& s);
// "ed25519:<base58>" or bare base58 -> 32 bytes. False if malformed or not 32 bytes.
bool parseKey32(const std::string& s, uint8_t out[32]);
}
