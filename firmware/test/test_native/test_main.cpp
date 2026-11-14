// Native unit tests for the Fuse core. Run: pio test -e native
#include <unity.h>
#include <string>
#include <vector>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include "borsh.h"
#include "policy.h"
#include "util.h"
#include "crypto_iface.h"
using namespace fuse;

// Vector produced by near-api-js 7.5.3 (bridge/scripts/borsh-vector.mjs, 2026-11-13):
// agent.alice.testnet -> fuse.alice.testnet, nonce 42, pay(...), 30 Tgas, deposit 0.
static const char* VEC_HEX =
"130000006167656e742e616c6963652e746573746e657400563298983af5691517bda3169243e32d9da657a594c2ce394b7c04156802dcfc2a0000000000000012000000667573652e616c6963652e746573746e657407070707070707070707070707070707070707070707070707070707070707070100000002030000007061794f0000007b227265636569766572223a226170692e746573746e6574222c22746f6b656e223a22757364632e746573746e6574222c22616d6f756e74223a2232303030303030222c226d656d6f223a226d227d00e057eb481b000000000000000000000000000000000000";
static const char* PUB_HEX = "563298983af5691517bda3169243e32d9da657a594c2ce394b7c04156802dcfc";
// This chip's pretend firmware hash for the fw-argument tests (spec 2.4).
static const char* FW_HEX = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

// Deterministic ed25519 test vectors (generated with python-cryptography from fixed seeds; see the firmware report).
// Decision signer: seed = sha256("fuse-decision-test-signer"). The text is "<model>:<sha256(request)>:<sha256(resp)>",
// resp = {"receiver":"api.testnet","amount":"2000000"} and the signature is ed25519 over sha256(text).
static const char* DEC_SIGNER = "ed25519:FMxFC7wbkwqNCsgpzXNRPbqzqhKwCeEwrXF4dEwtiQPu";
static const char* DEC_SIGNER_HEX = "d561b2d1dbbc3ea6a72e35f93bf96ee6df6e3186fb1cb1932c4dc5a3a77ca804";
static const char* DEC_TEXT = "fuse-test-model:1f58b9145b24d108d7ac38887338b3ea3229833b9c1e418250343f907bfd1047:a75cf475eae9eb13d051d33b901688ffc69cb4df94ea5b9bd816cd03408eb9a3";
static const char* DEC_SIG = "whuSC4t7DV6O73ZWH9NVniH0eJv26GIxzO2zoCqswqr4mONGzruEP5AEt35JKNg8+Ktsif094z8/DYrBAF/IAA==";
static const char* DEC_RESP = "eyJyZWNlaXZlciI6ImFwaS50ZXN0bmV0IiwiYW1vdW50IjoiMjAwMDAwMCJ9";
// Owner: seed = sha256("fuse-owner-test"); signs sha256("FUSE_POLICY_V1" || sha256(OWNER_POLICY) || seq=3 LE).
static const char* OWNER_PUB = "ed25519:G7qZoG55gG8SEHMbtFeKJHN6ZTzUSL8itaWbXWq2f5DG";
static const char* OWNER_POLICY = "{\"agent\":\"agent.alice.testnet\",\"wallet\":\"fuse.alice.testnet\",\"methods\":[\"pay\"],\"receivers\":[\"api.testnet\"],\"tokens\":[\"near\"],\"per_tx_cap\":\"5000000\",\"button_threshold\":\"1000000\",\"chain_value_cap\":\"0\",\"chain_dests\":[],\"gas_cap\":100000000000000,\"velocity_cap\":20,\"velocity_window_ms\":600000}";
static const char* OWNER_POLICY_SHA256 = "4c27cb469ff311d40b7bbeaab6269934a586aeb75034b7c88f5e271e33d3118e";
static const char* OWNER_DIGEST_SEQ3 = "95ea6fce8e2c7d90702eb98b5872f2e002188fc3e35a0b270b9b360aee3a9d29";
static const char* OWNER_SIG_SEQ3 = "fHiOq18PS5p/OgiQDtDSMTyHfHbtktzspIecKgNrYMV3ssi4np8ez0kIluSU+e4+1MpHHpqGrtRdbP0jYgGoDg==";

static std::vector<uint8_t> fromHex(const char* h) {
  std::vector<uint8_t> v; for (size_t i = 0; h[i] && h[i+1]; i += 2) { char b[3] = {h[i], h[i+1], 0}; v.push_back((uint8_t)strtol(b, nullptr, 16)); } return v;
}
static Policy testPolicy() {
  Policy p = defaultPolicy();
  p.agent = "agent.alice.testnet"; p.wallet = "fuse.alice.testnet";
  p.receivers = {"api.testnet"}; p.tokens = {"usdc.testnet", "near"};
  p.perTxCap = "5000000"; p.buttonThreshold = "1000000"; return p;
}
static EvalContext ctx(const std::vector<uint8_t>& pub, uint64_t lastNonce = 0, uint32_t recent = 0, const std::vector<RefusalRecord>* r = nullptr, const char* fw = FW_HEX) {
  EvalContext c; c.chipPub = pub.data(); c.lastNonce = lastNonce; c.recentSigns = recent; c.refusals = r; c.fwSha256 = fw; return c;
}
static DecodedTx vecTx() { auto v = fromHex(VEC_HEX); DecodedTx tx; decodeTransaction(v.data(), v.size(), tx); return tx; }
static DecisionFields goodDecision(bool withResp) {
  DecisionFields d; d.present = true; d.text = DEC_TEXT; d.sigB64 = DEC_SIG; d.signer = DEC_SIGNER;
  if (withResp) { d.hasResp = true; d.respB64 = DEC_RESP; }
  return d;
}

void test_decode_vector() {
  auto v = fromHex(VEC_HEX); DecodedTx tx;
  TEST_ASSERT_EQUAL(CODE_OK, decodeTransaction(v.data(), v.size(), tx));
  TEST_ASSERT_EQUAL_STRING("agent.alice.testnet", tx.signer.c_str());
  TEST_ASSERT_EQUAL_STRING("fuse.alice.testnet", tx.receiver.c_str());
  TEST_ASSERT_EQUAL_UINT64(42, tx.nonce);
  TEST_ASSERT_EQUAL(2, tx.actionTag);
  TEST_ASSERT_EQUAL_STRING("pay", tx.method.c_str());
  TEST_ASSERT_EQUAL_UINT64(30000000000000ULL, tx.gas);
  TEST_ASSERT_EQUAL_UINT64(0, tx.depositLo); TEST_ASSERT_EQUAL_UINT64(0, tx.depositHi);
  TEST_ASSERT_EQUAL_STRING(PUB_HEX, hexEncode(tx.pubkey, 32).c_str());
  TEST_ASSERT_EQUAL_STRING("{\"receiver\":\"api.testnet\",\"token\":\"usdc.testnet\",\"amount\":\"2000000\",\"memo\":\"m\"}", tx.args.c_str());
}
void test_trailing_bytes() { auto v = fromHex(VEC_HEX); v.push_back(0); DecodedTx tx; TEST_ASSERT_EQUAL(TRAILING_BYTES, decodeTransaction(v.data(), v.size(), tx)); }
void test_truncated() { auto v = fromHex(VEC_HEX); v.resize(v.size() - 5); DecodedTx tx; TEST_ASSERT_EQUAL(BAD_BORSH, decodeTransaction(v.data(), v.size(), tx)); }
void test_multi_action() {
  auto v = fromHex(VEC_HEX); // actions count is at offset: 4+19 +1+32 +8 +4+18 +32 = 118
  TEST_ASSERT_EQUAL(1, v[118]); v[118] = 2; DecodedTx tx; TEST_ASSERT_EQUAL(MULTI_ACTION, decodeTransaction(v.data(), v.size(), tx));
}
void test_transfer_action_refused() {
  auto v = fromHex(VEC_HEX); TEST_ASSERT_EQUAL(2, v[122]); v[122] = 3; DecodedTx tx;
  TEST_ASSERT_EQUAL(NOT_FUNCTION_CALL, decodeTransaction(v.data(), v.size(), tx));
}
void test_policy_sign() {
  DecodedTx tx = vecTx();
  auto pub = fromHex(PUB_HEX); Decision d = evaluate(testPolicy(), tx, ctx(pub));
  TEST_ASSERT_EQUAL((int)Verdict::SIGN_WITH_BUTTON, (int)d.verdict); // 2,000,000 > threshold 1,000,000
  Policy p = testPolicy(); p.buttonThreshold = "3000000"; d = evaluate(p, tx, ctx(pub));
  TEST_ASSERT_EQUAL((int)Verdict::SIGN, (int)d.verdict); TEST_ASSERT_EQUAL(CODE_OK, d.code);
}
void test_policy_refusals() {
  DecodedTx tx = vecTx();
  auto pub = fromHex(PUB_HEX); Policy p = testPolicy();
  { Policy q = p; q.receivers = {"other.testnet"}; TEST_ASSERT_EQUAL(RECEIVER_NOT_ALLOWED, evaluate(q, tx, ctx(pub)).code); }
  { Policy q = p; q.tokens = {"near"}; TEST_ASSERT_EQUAL(TOKEN_NOT_ALLOWED, evaluate(q, tx, ctx(pub)).code); }
  { Policy q = p; q.perTxCap = "1999999"; TEST_ASSERT_EQUAL(AMOUNT_OVER_CAP, evaluate(q, tx, ctx(pub)).code); }
  { Policy q = p; q.agent = "evil.testnet"; TEST_ASSERT_EQUAL(WRONG_SIGNER, evaluate(q, tx, ctx(pub)).code); }
  { Policy q = p; q.wallet = "other.testnet"; TEST_ASSERT_EQUAL(WRONG_RECEIVER, evaluate(q, tx, ctx(pub)).code); }
  { Policy q = p; q.methods = {"record_refusal"}; TEST_ASSERT_EQUAL(METHOD_NOT_ALLOWED, evaluate(q, tx, ctx(pub)).code); }
  { Policy q = p; q.gasCap = 1; TEST_ASSERT_EQUAL(GAS_TOO_HIGH, evaluate(q, tx, ctx(pub)).code); }
  { TEST_ASSERT_EQUAL(NONCE_REPLAY, evaluate(p, tx, ctx(pub, 42)).code); }
  { TEST_ASSERT_EQUAL(VELOCITY_CAP, evaluate(p, tx, ctx(pub, 0, 20)).code); }
  { std::vector<uint8_t> other(32, 9); TEST_ASSERT_EQUAL(WRONG_KEY, evaluate(p, tx, ctx(other)).code); }
  { DecodedTx t2 = tx; t2.depositLo = 1; TEST_ASSERT_EQUAL(DEPOSIT_NOT_ZERO, evaluate(p, t2, ctx(pub)).code); }
  { DecodedTx t2 = tx; t2.args = "not json"; TEST_ASSERT_EQUAL(BAD_ARGS, evaluate(p, t2, ctx(pub)).code); }
}
void test_record_refusal_matching() {
  DecodedTx tx = vecTx();
  auto pub = fromHex(PUB_HEX); Policy p = testPolicy();
  std::vector<uint8_t> h(32, 0xab); std::string hb58 = base58Encode(h.data(), 32);
  RefusalRecord r; memcpy(r.hash, h.data(), 32); r.code = RECEIVER_NOT_ALLOWED; r.counter = 7;
  std::vector<RefusalRecord> log = {r};
  tx.method = "record_refusal"; tx.args = "{\"tx_hash\":\"" + hb58 + "\",\"code\":13,\"counter\":7,\"receipt_sig\":\"x\"}";
  TEST_ASSERT_EQUAL(CODE_OK, evaluate(p, tx, ctx(pub, 0, 0, &log)).code);
  tx.args = "{\"tx_hash\":\"" + hb58 + "\",\"code\":13,\"counter\":8,\"receipt_sig\":\"x\"}";
  TEST_ASSERT_EQUAL(REFUSAL_MISMATCH, evaluate(p, tx, ctx(pub, 0, 0, &log)).code);
}
void test_chain_sig_rules() {
  DecodedTx tx = vecTx();
  auto pub = fromHex(PUB_HEX); Policy p = testPolicy(); p.chainDests = {{"sepolia", "0xabc"}}; p.chainValueCap = "1000";
  tx.method = "request_chain_sig"; tx.args = "{\"chain\":\"sepolia\",\"to\":\"0xabc\",\"value\":\"999\",\"path\":\"ethereum-1\",\"payload\":\"AA==\",\"domain_id\":0}";
  Decision d = evaluate(p, tx, ctx(pub)); TEST_ASSERT_EQUAL(CODE_OK, d.code); TEST_ASSERT_EQUAL((int)Verdict::SIGN_WITH_BUTTON, (int)d.verdict);
  tx.args = "{\"chain\":\"sepolia\",\"to\":\"0xdead\",\"value\":\"1\"}"; TEST_ASSERT_EQUAL(CHAIN_DEST_NOT_ALLOWED, evaluate(p, tx, ctx(pub)).code);
  tx.args = "{\"chain\":\"sepolia\",\"to\":\"0xabc\",\"value\":\"1001\"}"; TEST_ASSERT_EQUAL(CHAIN_VALUE_OVER_CAP, evaluate(p, tx, ctx(pub)).code);
}
void test_policy_json_roundtrip() {
  Policy p = testPolicy(); p.chainDests = {{"sepolia", "0xabc"}}; std::string j = policyToJson(p);
  Policy q; std::string err; TEST_ASSERT_TRUE_MESSAGE(policyFromJson(j, q, err), err.c_str());
  TEST_ASSERT_EQUAL_STRING(p.agent.c_str(), q.agent.c_str()); TEST_ASSERT_EQUAL(1, q.chainDests.size());
  TEST_ASSERT_EQUAL_STRING("5000000", q.perTxCap.c_str()); TEST_ASSERT_EQUAL(2, q.tokens.size());
  TEST_ASSERT_FALSE(policyFromJson("{\"agent\":\"a\"}", q, err));
  TEST_ASSERT_FALSE(policyFromJson("{\"agent\":\"a\",\"wallet\":\"w\",\"methods\":[\"pay\"],\"per_tx_cap\":\"12x\"}", q, err));
}
void test_encodings() {
  std::vector<uint8_t> pub = fromHex(PUB_HEX);
  std::string b58 = base58Encode(pub.data(), 32); std::vector<uint8_t> back; TEST_ASSERT_TRUE(base58Decode(b58, back));
  TEST_ASSERT_EQUAL(32, back.size()); TEST_ASSERT_EQUAL_MEMORY(pub.data(), back.data(), 32);
  uint8_t zeros[3] = {0, 0, 1}; TEST_ASSERT_EQUAL_STRING("112", base58Encode(zeros, 3).c_str());
  std::string b64 = base64Encode(pub.data(), 32); TEST_ASSERT_TRUE(base64Decode(b64, back)); TEST_ASSERT_EQUAL_MEMORY(pub.data(), back.data(), 32);
  const uint8_t hi[5] = {'h','e','l','l','o'}; TEST_ASSERT_EQUAL_STRING("aGVsbG8=", base64Encode(hi, 5).c_str());
  bool ok; TEST_ASSERT_TRUE(cmpDecimal("0010", "9", ok) > 0 && ok); TEST_ASSERT_TRUE(cmpDecimal("10", "10", ok) == 0);
  TEST_ASSERT_TRUE(cmpDecimal("999999999999999999999999", "1000000000000000000000000", ok) < 0); cmpDecimal("1a", "2", ok); TEST_ASSERT_FALSE(ok);
}

// ---------------------------------------------------------------- protocol v2

void test_codes_v2() {
  TEST_ASSERT_EQUAL(23, FW_MISMATCH); TEST_ASSERT_EQUAL(24, DECISION_REQUIRED); TEST_ASSERT_EQUAL(25, DECISION_INVALID);
  TEST_ASSERT_EQUAL(26, OWNER_SIG_INVALID); TEST_ASSERT_EQUAL(27, APPROVAL_NOT_ALLOWED);
  TEST_ASSERT_EQUAL_STRING("FW_MISMATCH", codeName(23)); TEST_ASSERT_EQUAL_STRING("DECISION_REQUIRED", codeName(24));
  TEST_ASSERT_EQUAL_STRING("DECISION_INVALID", codeName(25)); TEST_ASSERT_EQUAL_STRING("OWNER_SIG_INVALID", codeName(26));
  TEST_ASSERT_EQUAL_STRING("APPROVAL_NOT_ALLOWED", codeName(27)); TEST_ASSERT_EQUAL_STRING("TX_TOO_LARGE", codeName(22));
  TEST_ASSERT_EQUAL_STRING("UNKNOWN", codeName(28));
}
void test_host_crypto_vectors() {
  uint8_t h[32]; sha256((const uint8_t*)"abc", 3, h);
  TEST_ASSERT_EQUAL_STRING("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", hexEncode(h, 32).c_str());
  sha256(nullptr, 0, h); TEST_ASSERT_EQUAL_STRING("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", hexEncode(h, 32).c_str());
  std::string s56(56, 'a'); sha256((const uint8_t*)s56.data(), 56, h);   // two-block padding edge
  TEST_ASSERT_EQUAL_STRING("b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a", hexEncode(h, 32).c_str());
  uint8_t pub[32]; TEST_ASSERT_TRUE(parseKey32(DEC_SIGNER, pub)); TEST_ASSERT_EQUAL_STRING(DEC_SIGNER_HEX, hexEncode(pub, 32).c_str());
  TEST_ASSERT_TRUE(parseKey32(DEC_SIGNER + 8, pub));                     // bare base58 accepted too
  TEST_ASSERT_FALSE(parseKey32("ed25519:abc", pub)); TEST_ASSERT_FALSE(parseKey32("", pub)); TEST_ASSERT_FALSE(parseKey32("ed25519:0OIl", pub));
  std::vector<uint8_t> sig; TEST_ASSERT_TRUE(base64Decode(DEC_SIG, sig)); TEST_ASSERT_EQUAL(64, sig.size());
  uint8_t th[32]; sha256((const uint8_t*)DEC_TEXT, strlen(DEC_TEXT), th);
  TEST_ASSERT_TRUE(ed25519Verify(sig.data(), th, 32, pub));
  uint8_t bad[64]; memcpy(bad, sig.data(), 64); bad[5] ^= 1; TEST_ASSERT_FALSE(ed25519Verify(bad, th, 32, pub));
  th[0] ^= 1; TEST_ASSERT_FALSE(ed25519Verify(sig.data(), th, 32, pub)); th[0] ^= 1;
  std::vector<uint8_t> other(32, 9); TEST_ASSERT_FALSE(ed25519Verify(sig.data(), th, 32, other.data()));
}

// Shared vector with the bridge and contract streams (docs/protocol.md, Protocol v2):
// tx_hash = 01 02 .. 20, code 13, counter 7, receiver "attacker.testnet".
void test_refusal_digest_v2_vector() {
  uint8_t h[32]; for (int i = 0; i < 32; i++) h[i] = (uint8_t)(i + 1);
  uint8_t d[32];
  refusalDigestV2(h, 13, 7, "attacker.testnet", d);
  TEST_ASSERT_EQUAL_STRING("3091912debd71ecc48be63e3b950242d42d9f9312bf742ab25a0cfb4b972eae3", hexEncode(d, 32).c_str());
  refusalDigestV2(h, 13, 7, "", d);
  TEST_ASSERT_EQUAL_STRING("0fcda75ba09d9b7c9279548dc9a5b6691a2b311457f98b0534e1e2f0a3e2ef9e", hexEncode(d, 32).c_str());
  // second vector (tx_hash = 10 11 .. 2f, receiver api.testnet)
  for (int i = 0; i < 32; i++) h[i] = (uint8_t)(0x10 + i);
  refusalDigestV2(h, 13, 7, "api.testnet", d);
  TEST_ASSERT_EQUAL_STRING("b64f94e092b747cef16960ff118cc455f16d6292acfbad09efd6ac5b686c6c4e", hexEncode(d, 32).c_str());
  // receiver extraction for the receipt: pay with a string receiver, else ""
  DecodedTx tx = vecTx(); TEST_ASSERT_EQUAL_STRING("api.testnet", payReceiver(tx).c_str());
  tx.method = "record_refusal"; TEST_ASSERT_EQUAL_STRING("", payReceiver(tx).c_str());
  tx.method = "pay"; tx.args = "{\"receiver\":7}"; TEST_ASSERT_EQUAL_STRING("", payReceiver(tx).c_str());
  tx.args = "garbage"; TEST_ASSERT_EQUAL_STRING("", payReceiver(tx).c_str());
}

void test_fw_arg() {
  DecodedTx tx = vecTx(); auto pub = fromHex(PUB_HEX); Policy p = testPolicy();
  const std::string base = "{\"receiver\":\"api.testnet\",\"token\":\"usdc.testnet\",\"amount\":\"2000000\",\"memo\":\"m\"";
  // absent: fine unless required
  TEST_ASSERT_EQUAL(CODE_OK, evaluate(p, tx, ctx(pub)).code);
  Policy req = p; req.requireFwArg = true;
  Decision d = evaluate(req, tx, ctx(pub)); TEST_ASSERT_EQUAL(FW_MISMATCH, d.code); TEST_ASSERT_EQUAL((int)Verdict::REFUSE, (int)d.verdict);
  // present and equal (any case): fine, also when required
  tx.args = base + ",\"fw\":\"" + FW_HEX + "\"}";
  TEST_ASSERT_EQUAL(CODE_OK, evaluate(p, tx, ctx(pub)).code); TEST_ASSERT_EQUAL(CODE_OK, evaluate(req, tx, ctx(pub)).code);
  std::string upper = FW_HEX; for (auto& ch : upper) if (ch >= 'a' && ch <= 'f') ch -= 32;
  tx.args = base + ",\"fw\":\"" + upper + "\"}"; TEST_ASSERT_EQUAL(CODE_OK, evaluate(req, tx, ctx(pub)).code);
  // present and different: FW_MISMATCH even when not required
  tx.args = base + ",\"fw\":\"deadbeef\"}"; TEST_ASSERT_EQUAL(FW_MISMATCH, evaluate(p, tx, ctx(pub)).code);
  tx.args = base + ",\"fw\":null}"; TEST_ASSERT_EQUAL(FW_MISMATCH, evaluate(p, tx, ctx(pub)).code);
  tx.args = base + ",\"fw\":123}"; TEST_ASSERT_EQUAL(FW_MISMATCH, evaluate(p, tx, ctx(pub)).code);
  // the chip does not know its own hash: a present fw can never match
  tx.args = base + ",\"fw\":\"" + FW_HEX + "\"}"; TEST_ASSERT_EQUAL(FW_MISMATCH, evaluate(p, tx, ctx(pub, 0, 0, nullptr, nullptr)).code);
  // allowlist and cap checks come first (same order as bridge/src/policy.ts)
  Policy q = p; q.receivers = {"other.testnet"}; tx.args = base + ",\"fw\":\"deadbeef\"}";
  TEST_ASSERT_EQUAL(RECEIVER_NOT_ALLOWED, evaluate(q, tx, ctx(pub)).code);
  // request_chain_sig has the same rule
  Policy c = p; c.chainDests = {{"sepolia", "0xabc"}}; c.chainValueCap = "1000"; c.requireFwArg = true;
  tx.method = "request_chain_sig"; tx.args = "{\"chain\":\"sepolia\",\"to\":\"0xabc\",\"value\":\"9\"}";
  TEST_ASSERT_EQUAL(FW_MISMATCH, evaluate(c, tx, ctx(pub)).code);
  tx.args = "{\"chain\":\"sepolia\",\"to\":\"0xabc\",\"value\":\"9\",\"fw\":\"" + std::string(FW_HEX) + "\"}";
  TEST_ASSERT_EQUAL(CODE_OK, evaluate(c, tx, ctx(pub)).code);
  tx.args = "{\"chain\":\"sepolia\",\"to\":\"0xabc\",\"value\":\"9\",\"fw\":\"00\"}";
  c.requireFwArg = false; TEST_ASSERT_EQUAL(FW_MISMATCH, evaluate(c, tx, ctx(pub)).code);
}

void test_approve_payment() {
  DecodedTx tx = vecTx(); auto pub = fromHex(PUB_HEX); Policy p = testPolicy();
  tx.method = "approve_payment"; tx.args = "{\"id\":42}";
  TEST_ASSERT_EQUAL(METHOD_NOT_ALLOWED, evaluate(p, tx, ctx(pub)).code);             // must be in policy.methods
  p.methods.push_back("approve_payment");
  Decision d = evaluate(p, tx, ctx(pub));
  TEST_ASSERT_EQUAL(CODE_OK, d.code); TEST_ASSERT_EQUAL((int)Verdict::SIGN_WITH_BUTTON, (int)d.verdict);
  TEST_ASSERT_EQUAL_STRING("approve payment #42", d.summary.c_str());
  tx.args = "{\"id\":\"007\"}"; d = evaluate(p, tx, ctx(pub));
  TEST_ASSERT_EQUAL(CODE_OK, d.code); TEST_ASSERT_EQUAL_STRING("approve payment #7", d.summary.c_str());
  tx.args = "{\"id\":\"18446744073709551615\"}"; d = evaluate(p, tx, ctx(pub)); TEST_ASSERT_EQUAL(CODE_OK, d.code);
  TEST_ASSERT_EQUAL_STRING("approve payment #18446744073709551615", d.summary.c_str());
  tx.args = "{\"id\":0}"; TEST_ASSERT_EQUAL_STRING("approve payment #0", evaluate(p, tx, ctx(pub)).summary.c_str());
  p.approveButton = false; d = evaluate(p, tx, ctx(pub)); TEST_ASSERT_EQUAL((int)Verdict::SIGN, (int)d.verdict);
  p.approveButton = true;
  const char* bad[] = {"{}", "{\"id\":-1}", "{\"id\":1.5}", "{\"id\":\"x1\"}", "{\"id\":\"\"}", "{\"id\":null}", "{\"id\":true}", "{\"id\":[1]}", "{\"id\":\"1 \"}"};
  for (auto a : bad) { tx.args = a; d = evaluate(p, tx, ctx(pub)); TEST_ASSERT_EQUAL_MESSAGE(APPROVAL_NOT_ALLOWED, d.code, a); TEST_ASSERT_EQUAL((int)Verdict::REFUSE, (int)d.verdict); }
  tx.args = "[1]"; TEST_ASSERT_EQUAL(BAD_ARGS, evaluate(p, tx, ctx(pub)).code);
  // approve_payment ignores the fw argument rule (spec 2.4 names pay and request_chain_sig only)
  p.requireFwArg = true; tx.args = "{\"id\":3}"; TEST_ASSERT_EQUAL(CODE_OK, evaluate(p, tx, ctx(pub)).code);
}

void test_decision_check() {
  DecodedTx tx = vecTx(); Policy p = testPolicy(); std::string detail; Binding b;
  // no signers configured: nothing is checked, even with no decision attached
  DecisionFields none; TEST_ASSERT_EQUAL(CODE_OK, checkDecision(p, tx, none, detail, b)); TEST_ASSERT_EQUAL((int)Binding::NONE, (int)b);
  std::array<uint8_t, 32> k{}; TEST_ASSERT_TRUE(parseKey32(DEC_SIGNER, k.data())); p.decisionSigners.push_back(k);
  TEST_ASSERT_EQUAL(DECISION_REQUIRED, checkDecision(p, tx, none, detail, b));
  // envelope only
  TEST_ASSERT_EQUAL(CODE_OK, checkDecision(p, tx, goodDecision(false), detail, b)); TEST_ASSERT_EQUAL((int)Binding::ENVELOPE, (int)b);
  TEST_ASSERT_EQUAL_STRING("envelope", bindingName(b));
  // bound to the response, which names the receiver and amount of this pay
  TEST_ASSERT_EQUAL(CODE_OK, checkDecision(p, tx, goodDecision(true), detail, b)); TEST_ASSERT_EQUAL((int)Binding::BOUND, (int)b);
  // bare base58 signer accepted
  { DecisionFields d = goodDecision(true); d.signer = DEC_SIGNER + 8; TEST_ASSERT_EQUAL(CODE_OK, checkDecision(p, tx, d, detail, b)); }
  // unknown signer
  { DecisionFields d = goodDecision(false); d.signer = "ed25519:" + base58Encode(std::vector<uint8_t>(32, 1).data(), 32);
    TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, tx, d, detail, b)); TEST_ASSERT_EQUAL((int)Binding::NONE, (int)b); }
  { DecisionFields d = goodDecision(false); d.signer = "garbage"; TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, tx, d, detail, b)); }
  // tampered text, tampered or malformed signature
  { DecisionFields d = goodDecision(false); d.text[0] = 'F'; TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, tx, d, detail, b)); }
  { DecisionFields d = goodDecision(false); d.sigB64[10] = (d.sigB64[10] == 'A') ? 'B' : 'A'; TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, tx, d, detail, b)); }
  { DecisionFields d = goodDecision(false); d.sigB64 = "AAAA"; TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, tx, d, detail, b)); }
  { DecisionFields d = goodDecision(false); d.sigB64 = "**"; TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, tx, d, detail, b)); }
  // response that does not hash to the third segment
  { DecisionFields d = goodDecision(true); d.respB64 = base64Encode((const uint8_t*)"{\"receiver\":\"api.testnet\",\"amount\":\"2000000\"} ", 47);
    TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, tx, d, detail, b)); }
  { DecisionFields d = goodDecision(true); d.respB64 = "!!"; TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, tx, d, detail, b)); }
  // a correctly hashed response that is about a different payment: re-sign is impossible here, so check through the
  // decoded tx instead (same signed text and resp, but the chip's pay says another receiver / amount)
  { DecodedTx other = tx; other.args = "{\"receiver\":\"evil.testnet\",\"token\":\"usdc.testnet\",\"amount\":\"2000000\"}";
    TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, other, goodDecision(true), detail, b));
    TEST_ASSERT_EQUAL(CODE_OK, checkDecision(p, other, goodDecision(false), detail, b)); }   // envelope does not bind
  { DecodedTx other = tx; other.args = "{\"receiver\":\"api.testnet\",\"token\":\"usdc.testnet\",\"amount\":\"2000001\"}";
    TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, other, goodDecision(true), detail, b)); }
  // text without the three segments cannot bind a response
  { DecisionFields d = goodDecision(true); d.text = "no-colons"; TEST_ASSERT_EQUAL(DECISION_INVALID, checkDecision(p, tx, d, detail, b)); }
  // several signers: any of them may sign
  { Policy q = p; std::array<uint8_t, 32> z{}; q.decisionSigners.insert(q.decisionSigners.begin(), z);
    TEST_ASSERT_EQUAL(CODE_OK, checkDecision(q, tx, goodDecision(true), detail, b)); }
}

void test_policy_auth_digest() {
  uint8_t ph[32]; sha256((const uint8_t*)OWNER_POLICY, strlen(OWNER_POLICY), ph);
  TEST_ASSERT_EQUAL_STRING(OWNER_POLICY_SHA256, hexEncode(ph, 32).c_str());
  uint8_t d[32]; policyAuthDigest(OWNER_POLICY, 3, d);
  TEST_ASSERT_EQUAL_STRING(OWNER_DIGEST_SEQ3, hexEncode(d, 32).c_str());
  uint8_t owner[32]; TEST_ASSERT_TRUE(parseKey32(OWNER_PUB, owner));
  std::vector<uint8_t> sig; TEST_ASSERT_TRUE(base64Decode(OWNER_SIG_SEQ3, sig)); TEST_ASSERT_EQUAL(64, sig.size());
  TEST_ASSERT_TRUE(ed25519Verify(sig.data(), d, 32, owner));
  policyAuthDigest(OWNER_POLICY, 4, d); TEST_ASSERT_FALSE(ed25519Verify(sig.data(), d, 32, owner));     // seq is bound
  std::string p2 = OWNER_POLICY; p2[p2.size() - 2] = '1'; policyAuthDigest(p2, 3, d); TEST_ASSERT_FALSE(ed25519Verify(sig.data(), d, 32, owner));
  // The policy string the owner signed parses and re-serialises byte for byte (ArduinoJson compact == JSON.stringify here).
  Policy pol; std::string err; TEST_ASSERT_TRUE_MESSAGE(policyFromJson(OWNER_POLICY, pol, err), err.c_str());
}

// NEP-413 owner scheme (browser wallets). Vector from the bridge (@noble), same owner key: nonce 0x01..0x20, recipient "fuse", no callback.
static const char* NEP413_SIG_SEQ3 = "ViwqijYJQscNadIHMpJRhqYWCRc1YXztOtdbFs6c/dR6UMClSFvd8VKURT17dHAlo1SbPVrkRt3zCnvWZfVnAw==";
void test_policy_auth_nep413() {
  TEST_ASSERT_EQUAL_STRING("FUSE_POLICY_V1:4c27cb469ff311d40b7bbeaab6269934a586aeb75034b7c88f5e271e33d3118e:3", policyAuthMessage(OWNER_POLICY, 3).c_str());
  uint8_t nonce[32]; for (int i = 0; i < 32; i++) nonce[i] = (uint8_t)(i + 1);
  uint8_t d[32]; policyAuthDigestNep413(OWNER_POLICY, 3, nonce, "fuse", nullptr, d);
  TEST_ASSERT_EQUAL_STRING("7b9bb2069af44c1881b713ba999c280f4303cb20752eee8bb2a5c522f8b00107", hexEncode(d, 32).c_str());
  uint8_t owner[32]; TEST_ASSERT_TRUE(parseKey32(OWNER_PUB, owner));
  std::vector<uint8_t> sig; TEST_ASSERT_TRUE(base64Decode(NEP413_SIG_SEQ3, sig)); TEST_ASSERT_EQUAL(64, sig.size());
  TEST_ASSERT_TRUE(ed25519Verify(sig.data(), d, 32, owner));
  policyAuthDigestNep413(OWNER_POLICY, 3, nonce, "fuse.testnet", nullptr, d); TEST_ASSERT_FALSE(ed25519Verify(sig.data(), d, 32, owner));   // recipient bound
  nonce[0] = 9; policyAuthDigestNep413(OWNER_POLICY, 3, nonce, "fuse", nullptr, d); TEST_ASSERT_FALSE(ed25519Verify(sig.data(), d, 32, owner)); nonce[0] = 1;
  policyAuthDigestNep413(OWNER_POLICY, 4, nonce, "fuse", nullptr, d); TEST_ASSERT_FALSE(ed25519Verify(sig.data(), d, 32, owner));          // seq bound
  std::string cb = ""; policyAuthDigestNep413(OWNER_POLICY, 3, nonce, "fuse", &cb, d); TEST_ASSERT_FALSE(ed25519Verify(sig.data(), d, 32, owner)); // callback flag bound
  std::vector<uint8_t> rawSig; base64Decode(OWNER_SIG_SEQ3, rawSig); policyAuthDigestNep413(OWNER_POLICY, 3, nonce, "fuse", nullptr, d);
  TEST_ASSERT_FALSE(ed25519Verify(rawSig.data(), d, 32, owner));                                                                        // raw sig is not a nep413 sig
}

void test_policy_json_v2_roundtrip() {
  Policy p = testPolicy(); p.requireFwArg = true; p.approveButton = false; p.methods.push_back("approve_payment");
  std::array<uint8_t, 32> k{}; parseKey32(DEC_SIGNER, k.data()); p.decisionSigners.push_back(k);
  std::array<uint8_t, 32> z{}; z[31] = 1; p.decisionSigners.push_back(z);
  std::string j = policyToJson(p);
  TEST_ASSERT_NOT_NULL(strstr(j.c_str(), "\"require_fw_arg\":true"));
  TEST_ASSERT_NOT_NULL(strstr(j.c_str(), "\"approve_button\":false"));
  TEST_ASSERT_NOT_NULL(strstr(j.c_str(), (std::string("\"decision_signers\":[\"") + DEC_SIGNER + "\",\"ed25519:").c_str()));
  Policy q; std::string err; TEST_ASSERT_TRUE_MESSAGE(policyFromJson(j, q, err), err.c_str());
  TEST_ASSERT_TRUE(q.requireFwArg); TEST_ASSERT_FALSE(q.approveButton); TEST_ASSERT_EQUAL(2, q.decisionSigners.size());
  TEST_ASSERT_EQUAL_MEMORY(k.data(), q.decisionSigners[0].data(), 32); TEST_ASSERT_EQUAL_MEMORY(z.data(), q.decisionSigners[1].data(), 32);
  TEST_ASSERT_EQUAL(4, q.methods.size()); TEST_ASSERT_EQUAL_STRING("approve_payment", q.methods[3].c_str());
  TEST_ASSERT_EQUAL_STRING(j.c_str(), policyToJson(q).c_str());                                     // stable
  // defaults when absent (v1 policy file): permissive
  Policy d; TEST_ASSERT_TRUE(policyFromJson(OWNER_POLICY, d, err));
  TEST_ASSERT_FALSE(d.requireFwArg); TEST_ASSERT_TRUE(d.approveButton); TEST_ASSERT_EQUAL(0, d.decisionSigners.size());
  std::string dj = policyToJson(d);
  TEST_ASSERT_NOT_NULL(strstr(dj.c_str(), "\"require_fw_arg\":false")); TEST_ASSERT_NOT_NULL(strstr(dj.c_str(), "\"decision_signers\":[]"));
  TEST_ASSERT_NOT_NULL(strstr(dj.c_str(), "\"approve_button\":true"));
  // bare base58 signer accepted on input, written back with the prefix; junk refused as BAD_POLICY material
  std::string bare = std::string("{\"agent\":\"a\",\"wallet\":\"w\",\"methods\":[\"pay\"],\"decision_signers\":[\"") + (DEC_SIGNER + 8) + "\"]}";
  TEST_ASSERT_TRUE(policyFromJson(bare, q, err)); TEST_ASSERT_EQUAL_MEMORY(k.data(), q.decisionSigners[0].data(), 32);
  TEST_ASSERT_NOT_NULL(strstr(policyToJson(q).c_str(), DEC_SIGNER));
  TEST_ASSERT_FALSE(policyFromJson("{\"agent\":\"a\",\"wallet\":\"w\",\"methods\":[\"pay\"],\"decision_signers\":[\"ed25519:abc\"]}", q, err));
  TEST_ASSERT_FALSE(policyFromJson("{\"agent\":\"a\",\"wallet\":\"w\",\"methods\":[\"pay\"],\"decision_signers\":[7]}", q, err));
}

// Deterministic mutation fuzz: 200,000 byte flips / truncations / insertions / deletions of the near-api-js vector.
// The decoder must return a code (never crash or read out of bounds), an OK decode must be self-consistent, and
// evaluate() must never sign a tx whose signer, key, receiver or method is not exactly the policy's.
static uint64_t rng_state = 0x9E3779B97F4A7C15ULL;
static uint32_t rnd() { rng_state ^= rng_state << 13; rng_state ^= rng_state >> 7; rng_state ^= rng_state << 17; return (uint32_t)(rng_state >> 11); }
void test_mutation_fuzz() {
  const auto orig = fromHex(VEC_HEX); const auto pub = fromHex(PUB_HEX); const Policy p = testPolicy();
  const DecodedTx ref = vecTx();
  const int N = 200000; int okDecodes = 0, signs = 0, badConsistency = 0, badSign = 0, badCode = 0; int firstBad = -1;
  std::vector<uint8_t> v; v.reserve(orig.size() + 8);
  for (int it = 0; it < N; it++) {
    v = orig;
    int nMut = 1 + (rnd() % 3);
    for (int m = 0; m < nMut && !v.empty(); m++) {
      switch (rnd() % 5) {
        case 0: v[rnd() % v.size()] ^= (uint8_t)(1u << (rnd() % 8)); break;                       // bit flip
        case 1: v[rnd() % v.size()] = (uint8_t)rnd(); break;                                      // byte overwrite
        case 2: v.resize(rnd() % (v.size() + 1)); break;                                          // truncate
        case 3: v.insert(v.begin() + (rnd() % (v.size() + 1)), (uint8_t)rnd()); break;            // insert
        default: v.erase(v.begin() + (rnd() % v.size())); break;                                  // delete
      }
    }
    DecodedTx tx; Code c = decodeTransaction(v.data(), v.size(), tx);
    if (c > TX_TOO_LARGE) { badCode++; if (firstBad < 0) firstBad = it; continue; }
    if (c != CODE_OK) continue;
    okDecodes++;
    bool consistent = tx.nActions == 1 && tx.actionTag == 2 && tx.keyType == 0 && tx.signer.size() <= 64 && tx.receiver.size() <= 64
                      && tx.method.size() <= 64 && tx.args.size() <= 4096 && v.size() <= 8192;
    if (!consistent) { badConsistency++; if (firstBad < 0) firstBad = it; }
    Decision d = evaluate(p, tx, ctx(pub));
    if (d.verdict != Verdict::REFUSE) {
      signs++;
      bool same = tx.signer == ref.signer && tx.receiver == ref.receiver && tx.method == ref.method && memcmp(tx.pubkey, ref.pubkey, 32) == 0
                  && tx.depositLo == 0 && tx.depositHi == 0 && tx.gas <= p.gasCap && tx.nonce > 0;
      if (!same) { badSign++; if (firstBad < 0) firstBad = it; }
    }
  }
  char msg[160]; snprintf(msg, sizeof(msg), "N=%d okDecodes=%d signs=%d badCode=%d badConsistency=%d badSign=%d firstBad=%d", N, okDecodes, signs, badCode, badConsistency, badSign, firstBad);
  TEST_MESSAGE(msg);
  TEST_ASSERT_EQUAL_MESSAGE(0, badCode, msg); TEST_ASSERT_EQUAL_MESSAGE(0, badConsistency, msg); TEST_ASSERT_EQUAL_MESSAGE(0, badSign, msg);
  TEST_ASSERT_TRUE_MESSAGE(okDecodes > 0, "mutations never produced a decodable tx: fuzz is not exercising the policy");
}

// Unity declares these; they are weak on ELF/Mach-O but MinGW needs real definitions.
extern "C" void setUp(void) {}
extern "C" void tearDown(void) {}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_decode_vector); RUN_TEST(test_trailing_bytes); RUN_TEST(test_truncated); RUN_TEST(test_multi_action);
  RUN_TEST(test_transfer_action_refused); RUN_TEST(test_policy_sign); RUN_TEST(test_policy_refusals);
  RUN_TEST(test_record_refusal_matching); RUN_TEST(test_chain_sig_rules); RUN_TEST(test_policy_json_roundtrip); RUN_TEST(test_encodings);
  // protocol v2
  RUN_TEST(test_codes_v2); RUN_TEST(test_host_crypto_vectors); RUN_TEST(test_refusal_digest_v2_vector); RUN_TEST(test_fw_arg); RUN_TEST(test_approve_payment);
  RUN_TEST(test_decision_check); RUN_TEST(test_policy_auth_digest); RUN_TEST(test_policy_auth_nep413); RUN_TEST(test_policy_json_v2_roundtrip); RUN_TEST(test_mutation_fuzz);
  return UNITY_END();
}
