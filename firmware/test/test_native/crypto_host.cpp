// Host implementation of lib/fusecore/crypto_iface.h for `pio test -e native`.
// SHA-256 / SHA-512 are straight FIPS 180-4; the ed25519 verifier is derived from TweetNaCl (public domain,
// Bernstein, van Gastel, Janssen, Lange, Schwabe, Smetsers), reduced to verification only. Constants were
// regenerated from their definitions (cube/square roots of primes; -121665/121666, 2^((p-1)/4), base point).
// Test code only: the board uses rweather/Crypto (src/crypto_board.cpp).
#include "crypto_iface.h"
#include <string.h>
namespace fuse {

// ---------------------------------------------------------------- SHA-256
static const uint32_t K256[64] = {
  0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
  0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
  0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
  0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
  0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
  0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
  0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
  0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
};
static inline uint32_t ror32(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }
static void sha256Block(uint32_t h[8], const uint8_t* p) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) w[i] = ((uint32_t)p[4*i] << 24) | ((uint32_t)p[4*i+1] << 16) | ((uint32_t)p[4*i+2] << 8) | p[4*i+3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ror32(w[i-15], 7) ^ ror32(w[i-15], 18) ^ (w[i-15] >> 3);
    uint32_t s1 = ror32(w[i-2], 17) ^ ror32(w[i-2], 19) ^ (w[i-2] >> 10);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = ror32(e, 6) ^ ror32(e, 11) ^ ror32(e, 25), ch = (e & f) ^ (~e & g);
    uint32_t t1 = hh + S1 + ch + K256[i] + w[i];
    uint32_t S0 = ror32(a, 2) ^ ror32(a, 13) ^ ror32(a, 22), maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = S0 + maj;
    hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}
void sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
  uint32_t h[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};
  size_t i = 0; for (; i + 64 <= len; i += 64) sha256Block(h, data + i);
  uint8_t tail[128]; memset(tail, 0, sizeof(tail)); size_t r = len - i; memcpy(tail, data + i, r); tail[r] = 0x80;
  size_t n = (r < 56) ? 64 : 128; uint64_t bits = (uint64_t)len * 8;
  for (int k = 0; k < 8; k++) tail[n - 1 - k] = (uint8_t)(bits >> (8 * k));
  sha256Block(h, tail); if (n == 128) sha256Block(h, tail + 64);
  for (int k = 0; k < 8; k++) { out[4*k] = h[k] >> 24; out[4*k+1] = h[k] >> 16; out[4*k+2] = h[k] >> 8; out[4*k+3] = h[k]; }
}

// ---------------------------------------------------------------- SHA-512
static const uint64_t K512[80] = {
  0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL, 0xe9b5dba58189dbbcULL,
  0x3956c25bf348b538ULL, 0x59f111f1b605d019ULL, 0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL,
  0xd807aa98a3030242ULL, 0x12835b0145706fbeULL, 0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL,
  0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL, 0xc19bf174cf692694ULL,
  0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL, 0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL,
  0x2de92c6f592b0275ULL, 0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL,
  0x983e5152ee66dfabULL, 0xa831c66d2db43210ULL, 0xb00327c898fb213fULL, 0xbf597fc7beef0ee4ULL,
  0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL, 0x06ca6351e003826fULL, 0x142929670a0e6e70ULL,
  0x27b70a8546d22ffcULL, 0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL, 0x53380d139d95b3dfULL,
  0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL, 0x92722c851482353bULL,
  0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL, 0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL,
  0xd192e819d6ef5218ULL, 0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL,
  0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL, 0x2748774cdf8eeb99ULL, 0x34b0bcb5e19b48a8ULL,
  0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL, 0x5b9cca4f7763e373ULL, 0x682e6ff3d6b2b8a3ULL,
  0x748f82ee5defb2fcULL, 0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL,
  0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL, 0xc67178f2e372532bULL,
  0xca273eceea26619cULL, 0xd186b8c721c0c207ULL, 0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL,
  0x06f067aa72176fbaULL, 0x0a637dc5a2c898a6ULL, 0x113f9804bef90daeULL, 0x1b710b35131c471bULL,
  0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL, 0x431d67c49c100d4cULL,
  0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL, 0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL,
};
static inline uint64_t ror64(uint64_t x, int n) { return (x >> n) | (x << (64 - n)); }
static void sha512Block(uint64_t h[8], const uint8_t* p) {
  uint64_t w[80];
  for (int i = 0; i < 16; i++) { uint64_t v = 0; for (int k = 0; k < 8; k++) v = (v << 8) | p[8*i+k]; w[i] = v; }
  for (int i = 16; i < 80; i++) {
    uint64_t s0 = ror64(w[i-15], 1) ^ ror64(w[i-15], 8) ^ (w[i-15] >> 7);
    uint64_t s1 = ror64(w[i-2], 19) ^ ror64(w[i-2], 61) ^ (w[i-2] >> 6);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  uint64_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (int i = 0; i < 80; i++) {
    uint64_t S1 = ror64(e, 14) ^ ror64(e, 18) ^ ror64(e, 41), ch = (e & f) ^ (~e & g);
    uint64_t t1 = hh + S1 + ch + K512[i] + w[i];
    uint64_t S0 = ror64(a, 28) ^ ror64(a, 34) ^ ror64(a, 39), maj = (a & b) ^ (a & c) ^ (b & c);
    uint64_t t2 = S0 + maj;
    hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}
static void sha512(const uint8_t* data, size_t len, uint8_t out[64]) {
  uint64_t h[8] = {0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL, 0x3c6ef372fe94f82bULL, 0xa54ff53a5f1d36f1ULL,
                   0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL, 0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL};
  size_t i = 0; for (; i + 128 <= len; i += 128) sha512Block(h, data + i);
  uint8_t tail[256]; memset(tail, 0, sizeof(tail)); size_t r = len - i; memcpy(tail, data + i, r); tail[r] = 0x80;
  size_t n = (r < 112) ? 128 : 256; uint64_t bits = (uint64_t)len * 8;   // 128-bit length field; top 64 bits are zero here
  for (int k = 0; k < 8; k++) tail[n - 1 - k] = (uint8_t)(bits >> (8 * k));
  sha512Block(h, tail); if (n == 256) sha512Block(h, tail + 128);
  for (int k = 0; k < 8; k++) for (int j = 0; j < 8; j++) out[8*k+j] = (uint8_t)(h[k] >> (56 - 8*j));
}

// ---------------------------------------------------------------- ed25519 verify (TweetNaCl-derived)
typedef int64_t i64; typedef uint8_t u8; typedef uint64_t u64;
typedef i64 gf[16];
static const gf gf0 = {0}, gf1 = {1};
static const gf D = {0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070, 0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203};
static const gf D2 = {0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0, 0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406};
static const gf X = {0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c, 0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169};
static const gf Y = {0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666};
static const gf I = {0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43, 0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83};
// group order l, little endian
static const u64 L[32] = {0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
                          0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10};

static int vn(const u8* x, const u8* y, int n) { uint32_t d = 0; for (int i = 0; i < n; i++) d |= x[i] ^ y[i]; return (1 & ((d - 1) >> 8)) - 1; }
static void set25519(gf r, const gf a) { for (int i = 0; i < 16; i++) r[i] = a[i]; }
static void car25519(gf o) {
  for (int i = 0; i < 16; i++) {
    o[i] += (1LL << 16);
    i64 c = o[i] >> 16;
    o[(i + 1) * (i < 15)] += c - 1 + 37 * (c - 1) * (i == 15);
    o[i] -= c << 16;
  }
}
static void sel25519(gf p, gf q, int b) {
  i64 c = ~(i64)(b - 1);
  for (int i = 0; i < 16; i++) { i64 t = c & (p[i] ^ q[i]); p[i] ^= t; q[i] ^= t; }
}
static void pack25519(u8* o, const gf n) {
  gf m, t; set25519(t, n);
  car25519(t); car25519(t); car25519(t);
  for (int j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (int i = 1; i < 15; i++) { m[i] = t[i] - 0xffff - ((m[i-1] >> 16) & 1); m[i-1] &= 0xffff; }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    int b = (m[15] >> 16) & 1;
    m[14] &= 0xffff;
    sel25519(t, m, 1 - b);
  }
  for (int i = 0; i < 16; i++) { o[2*i] = t[i] & 0xff; o[2*i+1] = (u8)(t[i] >> 8); }
}
static int neq25519(const gf a, const gf b) { u8 c[32], d[32]; pack25519(c, a); pack25519(d, b); return vn(c, d, 32); }
static u8 par25519(const gf a) { u8 d[32]; pack25519(d, a); return d[0] & 1; }
static void unpack25519(gf o, const u8* n) { for (int i = 0; i < 16; i++) o[i] = n[2*i] + ((i64)n[2*i+1] << 8); o[15] &= 0x7fff; }
static void A(gf o, const gf a, const gf b) { for (int i = 0; i < 16; i++) o[i] = a[i] + b[i]; }
static void Z(gf o, const gf a, const gf b) { for (int i = 0; i < 16; i++) o[i] = a[i] - b[i]; }
static void M(gf o, const gf a, const gf b) {
  i64 t[31]; for (int i = 0; i < 31; i++) t[i] = 0;
  for (int i = 0; i < 16; i++) for (int j = 0; j < 16; j++) t[i+j] += a[i] * b[j];
  for (int i = 0; i < 15; i++) t[i] += 38 * t[i+16];
  for (int i = 0; i < 16; i++) o[i] = t[i];
  car25519(o); car25519(o);
}
static void S(gf o, const gf a) { M(o, a, a); }
static void inv25519(gf o, const gf i) {
  gf c; set25519(c, i);
  for (int a = 253; a >= 0; a--) { S(c, c); if (a != 2 && a != 4) M(c, c, i); }
  set25519(o, c);
}
static void pow2523(gf o, const gf i) {
  gf c; set25519(c, i);
  for (int a = 250; a >= 0; a--) { S(c, c); if (a != 1) M(c, c, i); }
  set25519(o, c);
}
static void add(gf p[4], gf q[4]) {
  gf a, b, c, d, t, e, f, g, h;
  Z(a, p[1], p[0]); Z(t, q[1], q[0]); M(a, a, t);
  A(b, p[0], p[1]); A(t, q[0], q[1]); M(b, b, t);
  M(c, p[3], q[3]); M(c, c, D2);
  M(d, p[2], q[2]); A(d, d, d);
  Z(e, b, a); Z(f, d, c); A(g, d, c); A(h, b, a);
  M(p[0], e, f); M(p[1], h, g); M(p[2], g, f); M(p[3], e, h);
}
static void cswap(gf p[4], gf q[4], u8 b) { for (int i = 0; i < 4; i++) sel25519(p[i], q[i], b); }
static void pack(u8* r, gf p[4]) {
  gf tx, ty, zi;
  inv25519(zi, p[2]); M(tx, p[0], zi); M(ty, p[1], zi);
  pack25519(r, ty);
  r[31] ^= par25519(tx) << 7;
}
static void scalarmult(gf p[4], gf q[4], const u8* s) {
  set25519(p[0], gf0); set25519(p[1], gf1); set25519(p[2], gf1); set25519(p[3], gf0);
  for (int i = 255; i >= 0; --i) {
    u8 b = (s[i / 8] >> (i & 7)) & 1;
    cswap(p, q, b); add(q, p); add(p, p); cswap(p, q, b);
  }
}
static void scalarbase(gf p[4], const u8* s) {
  gf q[4];
  set25519(q[0], X); set25519(q[1], Y); set25519(q[2], gf1); M(q[3], X, Y);
  scalarmult(p, q, s);
}
static void modL(u8* r, i64 x[64]) {
  i64 carry; int i, j;
  for (i = 63; i >= 32; --i) {
    carry = 0;
    for (j = i - 32; j < i - 12; ++j) {
      x[j] += carry - 16 * x[i] * (i64)L[j - (i - 32)];
      carry = (x[j] + 128) >> 8;
      x[j] -= carry << 8;
    }
    x[j] += carry;
    x[i] = 0;
  }
  carry = 0;
  for (j = 0; j < 32; j++) { x[j] += carry - (x[31] >> 4) * (i64)L[j]; carry = x[j] >> 8; x[j] &= 255; }
  for (j = 0; j < 32; j++) x[j] -= carry * (i64)L[j];
  for (i = 0; i < 32; i++) { x[i+1] += x[i] >> 8; r[i] = x[i] & 255; }
}
static void reduce(u8* r) { i64 x[64]; for (int i = 0; i < 64; i++) x[i] = (u64)r[i]; for (int i = 0; i < 64; i++) r[i] = 0; modL(r, x); }
static int unpackneg(gf r[4], const u8 p[32]) {
  gf t, chk, num, den, den2, den4, den6;
  set25519(r[2], gf1);
  unpack25519(r[1], p);
  S(num, r[1]); M(den, num, D); Z(num, num, r[2]); A(den, r[2], den);
  S(den2, den); S(den4, den2); M(den6, den4, den2);
  M(t, den6, num); M(t, t, den);
  pow2523(t, t); M(t, t, num); M(t, t, den); M(t, t, den); M(r[0], t, den);
  S(chk, r[0]); M(chk, chk, den);
  if (neq25519(chk, num)) M(r[0], r[0], I);
  S(chk, r[0]); M(chk, chk, den);
  if (neq25519(chk, num)) return -1;
  if (par25519(r[0]) == (p[31] >> 7)) Z(r[0], gf0, r[0]);
  M(r[3], r[0], r[1]);
  return 0;
}

bool ed25519Verify(const uint8_t sig[64], const uint8_t* msg, size_t len, const uint8_t pub[32]) {
  // S must be canonical (< l): reject the high bits that TweetNaCl tolerates.
  if (sig[63] & 0xe0) return false;
  gf p[4], q[4];
  if (unpackneg(q, pub)) return false;
  // h = sha512(R || A || M) mod l
  u8* m = new u8[len + 64];
  memcpy(m, sig, 32); memcpy(m + 32, pub, 32); if (len) memcpy(m + 64, msg, len);
  u8 h[64]; sha512(m, len + 64, h); delete[] m;
  reduce(h);
  scalarmult(p, q, h);        // h * (-A)
  scalarbase(q, sig + 32);    // S * B
  add(p, q);                  // S*B - h*A == R ?
  u8 t[32]; pack(t, p);
  return vn(sig, t, 32) == 0;
}
}
