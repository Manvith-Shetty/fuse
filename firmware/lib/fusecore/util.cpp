#include "util.h"
#include <string.h>
namespace fuse {
static const char* B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
static const char* B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base58Encode(const uint8_t* data, size_t len) {
  size_t zeros = 0; while (zeros < len && data[zeros] == 0) zeros++;
  std::vector<uint8_t> b((len - zeros) * 138 / 100 + 1, 0);
  size_t length = 0;
  for (size_t i = zeros; i < len; i++) {
    int carry = data[i]; size_t j = 0;
    for (auto it = b.rbegin(); (carry != 0 || j < length) && it != b.rend(); ++it, ++j) {
      carry += 256 * (*it); *it = carry % 58; carry /= 58;
    }
    length = j;
  }
  auto it = b.begin() + (b.size() - length);
  while (it != b.end() && *it == 0) it++;
  std::string s(zeros, '1');
  for (; it != b.end(); ++it) s += B58[*it];
  return s;
}

bool base58Decode(const std::string& s, std::vector<uint8_t>& out) {
  out.clear();
  size_t zeros = 0; while (zeros < s.size() && s[zeros] == '1') zeros++;
  std::vector<uint8_t> b((s.size() - zeros) * 733 / 1000 + 1, 0);
  size_t length = 0;
  for (size_t i = zeros; i < s.size(); i++) {
    const char* p = strchr(B58, s[i]); if (!p || s[i] == 0) return false;
    int carry = (int)(p - B58); size_t j = 0;
    for (auto it = b.rbegin(); (carry != 0 || j < length) && it != b.rend(); ++it, ++j) {
      carry += 58 * (*it); *it = carry & 0xff; carry >>= 8;
    }
    length = j;
  }
  auto it = b.begin() + (b.size() - length);
  while (it != b.end() && *it == 0) it++;
  out.assign(zeros, 0); out.insert(out.end(), it, b.end());
  return true;
}

std::string base64Encode(const uint8_t* d, size_t len) {
  std::string s; s.reserve((len + 2) / 3 * 4);
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = d[i] << 16; if (i + 1 < len) v |= d[i+1] << 8; if (i + 2 < len) v |= d[i+2];
    s += B64[(v >> 18) & 63]; s += B64[(v >> 12) & 63];
    s += (i + 1 < len) ? B64[(v >> 6) & 63] : '='; s += (i + 2 < len) ? B64[v & 63] : '=';
  }
  return s;
}

bool base64Decode(const std::string& s, std::vector<uint8_t>& out) {
  out.clear(); uint32_t v = 0; int bits = 0;
  for (char c : s) {
    if (c == '=') break;
    if (c == '\r' || c == '\n' || c == ' ') continue;
    const char* p = strchr(B64, c); if (!p || c == 0) return false;
    v = (v << 6) | (uint32_t)(p - B64); bits += 6;
    if (bits >= 8) { bits -= 8; out.push_back((v >> bits) & 0xff); }
  }
  return true;
}

std::string hexEncode(const uint8_t* d, size_t len) {
  static const char* H = "0123456789abcdef"; std::string s; s.reserve(len * 2);
  for (size_t i = 0; i < len; i++) { s += H[d[i] >> 4]; s += H[d[i] & 15]; }
  return s;
}

bool isDecimal(const std::string& s) {
  if (s.empty() || s.size() > 40) return false;
  for (char c : s) if (c < '0' || c > '9') return false;
  return true;
}

static std::string stripZeros(const std::string& s) {
  size_t i = 0; while (i + 1 < s.size() && s[i] == '0') i++;
  return s.substr(i);
}

int cmpDecimal(const std::string& a0, const std::string& b0, bool& ok) {
  ok = isDecimal(a0) && isDecimal(b0); if (!ok) return 0;
  std::string a = stripZeros(a0), b = stripZeros(b0);
  if (a.size() != b.size()) return a.size() < b.size() ? -1 : 1;
  return a.compare(b);
}
}
