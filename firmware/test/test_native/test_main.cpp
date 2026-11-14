// Native unit tests for the Fuse core. Run: pio test -e native
#include <unity.h>
#include <string>
#include <vector>
#include "borsh.h"
#include "policy.h"
#include "util.h"
using namespace fuse;

// Vector produced by near-api-js 7.5.3 (bridge/scripts/borsh-vector.mjs, 2026-11-13):
// agent.alice.testnet -> fuse.alice.testnet, nonce 42, pay(...), 30 Tgas, deposit 0.
static const char* VEC_HEX =
"130000006167656e742e616c6963652e746573746e657400563298983af5691517bda3169243e32d9da657a594c2ce394b7c04156802dcfc2a0000000000000012000000667573652e616c6963652e746573746e657407070707070707070707070707070707070707070707070707070707070707070100000002030000007061794f0000007b227265636569766572223a226170692e746573746e6574222c22746f6b656e223a22757364632e746573746e6574222c22616d6f756e74223a2232303030303030222c226d656d6f223a226d227d00e057eb481b000000000000000000000000000000000000";
static const char* PUB_HEX = "563298983af5691517bda3169243e32d9da657a594c2ce394b7c04156802dcfc";

static std::vector<uint8_t> fromHex(const char* h) {
  std::vector<uint8_t> v; for (size_t i = 0; h[i] && h[i+1]; i += 2) { char b[3] = {h[i], h[i+1], 0}; v.push_back((uint8_t)strtol(b, nullptr, 16)); } return v;
}
static Policy testPolicy() {
  Policy p = defaultPolicy();
  p.agent = "agent.alice.testnet"; p.wallet = "fuse.alice.testnet";
  p.receivers = {"api.testnet"}; p.tokens = {"usdc.testnet", "near"};
  p.perTxCap = "5000000"; p.buttonThreshold = "1000000"; return p;
}
static EvalContext ctx(const std::vector<uint8_t>& pub, uint64_t lastNonce = 0, uint32_t recent = 0, const std::vector<RefusalRecord>* r = nullptr) {
  EvalContext c; c.chipPub = pub.data(); c.lastNonce = lastNonce; c.recentSigns = recent; c.refusals = r; return c;
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
  auto v = fromHex(VEC_HEX); DecodedTx tx; decodeTransaction(v.data(), v.size(), tx);
  auto pub = fromHex(PUB_HEX); Decision d = evaluate(testPolicy(), tx, ctx(pub));
  TEST_ASSERT_EQUAL((int)Verdict::SIGN_WITH_BUTTON, (int)d.verdict); // 2,000,000 > threshold 1,000,000
  Policy p = testPolicy(); p.buttonThreshold = "3000000"; d = evaluate(p, tx, ctx(pub));
  TEST_ASSERT_EQUAL((int)Verdict::SIGN, (int)d.verdict); TEST_ASSERT_EQUAL(CODE_OK, d.code);
}
void test_policy_refusals() {
  auto v = fromHex(VEC_HEX); DecodedTx tx; decodeTransaction(v.data(), v.size(), tx);
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
  auto v = fromHex(VEC_HEX); DecodedTx tx; decodeTransaction(v.data(), v.size(), tx);
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
  auto v = fromHex(VEC_HEX); DecodedTx tx; decodeTransaction(v.data(), v.size(), tx);
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
int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_decode_vector); RUN_TEST(test_trailing_bytes); RUN_TEST(test_truncated); RUN_TEST(test_multi_action);
  RUN_TEST(test_transfer_action_refused); RUN_TEST(test_policy_sign); RUN_TEST(test_policy_refusals);
  RUN_TEST(test_record_refusal_matching); RUN_TEST(test_chain_sig_rules); RUN_TEST(test_policy_json_roundtrip); RUN_TEST(test_encodings);
  return UNITY_END();
}
