// Protocol v2 (docs/v2-spec.md): receipt v2, owner-signed policy, fw attestation, attested decisions, approve_payment.
import { describe, it, expect } from 'vitest';
import * as n from 'near-api-js';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { SimChip, SIM_FW_SHA256 } from '../src/chip-sim.js';
import { defaultPolicy, evaluate, refusalDigestV2, policyAuthDigest, policyAuthMessage, nep413Hash, checkDecision, type Policy } from '../src/policy.js';
import { signPolicyAuth, signPolicyAuthNep413, DevDecisionSigner } from '../src/keychain.js';
import { decodeTransaction } from '../src/borsh.js';
import { CODES } from '../src/codes.js';

const AGENT = 'agent.alice.testnet', WALLET = 'fuse.alice.testnet';
const owner = n.KeyPairEd25519.fromRandom();
const base = (): Policy => ({ ...defaultPolicy(AGENT, WALLET), receivers: ['api.testnet'], tokens: ['near'], per_tx_cap: '5000000', button_threshold: '9000000' });
const payTx = (pk: n.PublicKey, nonce: bigint, args: Record<string, unknown>, method = 'pay') =>
  n.encodeTransaction(n.createTransaction(AGENT, pk, WALLET, nonce, [n.actions.functionCall(method, new TextEncoder().encode(JSON.stringify(args)), 30n * 10n ** 12n, 0n)], new Uint8Array(32)));
let nonce = 100n; const next = () => ++nonce;
const mkChip = async (button: 'press' | 'deny' = 'press') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuse-v2-'));
  return new SimChip({ dataDir: dir, agent: AGENT, wallet: WALLET, button, buttonDelayMs: 5 }).init();
};
const setPolicy = async (chip: SimChip, p: Policy, seq: number, kp = owner) => chip.policySet(p, signPolicyAuth(p, seq, kp));

describe('codes v2', () => {
  it('appends the five v2 codes at 23..27', () => {
    expect(CODES[23]).toBe('FW_MISMATCH'); expect(CODES[24]).toBe('DECISION_REQUIRED'); expect(CODES[25]).toBe('DECISION_INVALID');
    expect(CODES[26]).toBe('OWNER_SIG_INVALID'); expect(CODES[27]).toBe('APPROVAL_NOT_ALLOWED'); expect(CODES.length).toBe(28);
  });
});

describe('receipt v2 digest', () => {
  // Shared test vector for the firmware and contract streams.
  const txHash = new Uint8Array(32).map((_, i) => i + 1);
  it('is deterministic and binds the receiver', () => {
    const a = Buffer.from(refusalDigestV2(txHash, 13, 7, 'attacker.testnet')).toString('hex');
    const b = Buffer.from(refusalDigestV2(txHash, 13, 7, 'attacker.testnet')).toString('hex');
    const c = Buffer.from(refusalDigestV2(txHash, 13, 7, 'other.testnet')).toString('hex');
    const z = Buffer.from(refusalDigestV2(txHash, 13, 7, '')).toString('hex');
    expect(a).toBe(b); expect(a).not.toBe(c); expect(a).not.toBe(z);
    // explicit recomputation: sha256("FUSE_REFUSAL_V2" || hash || 13 || 7 LE || sha256("attacker.testnet"))
    const buf = Buffer.concat([Buffer.from('FUSE_REFUSAL_V2'), Buffer.from(txHash), Buffer.from([13]), Buffer.from([7, 0, 0, 0]), Buffer.from(sha256(Buffer.from('attacker.testnet')))]);
    expect(a).toBe(Buffer.from(sha256(buf)).toString('hex'));
    console.log('VECTOR receipt v2: tx_hash=0102..20 code=13 counter=7 receiver=attacker.testnet digest=' + a + ' ; empty receiver digest=' + z);
  });
  it('the simulator issues v2 receipts that verify with the receiver, and not without it', async () => {
    const chip = await mkChip(); const h = await chip.hello(); const pk = n.PublicKey.fromString(h.pubkey);
    expect(h.proto).toBe(2); expect(h.receipt_v).toBe(2);
    expect((await setPolicy(chip, base(), 1)).ok).toBe(true);
    const bytes = payTx(pk, next(), { receiver: 'attacker.testnet', token: 'near', amount: '1' });
    const r = await chip.sign(bytes, 'evil'); expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.code).toBe('RECEIVER_NOT_ALLOWED'); expect(r.receipt_v).toBe(2); expect(r.receiver).toBe('attacker.testnet');
    const sig = Buffer.from(r.receipt!, 'base64');
    expect(await ed.verifyAsync(sig, refusalDigestV2(sha256(bytes), r.code_num!, r.counter!, 'attacker.testnet'), pk.data)).toBe(true);
    expect(await ed.verifyAsync(sig, refusalDigestV2(sha256(bytes), r.code_num!, r.counter!, ''), pk.data)).toBe(false);
  });
});

describe('owner-signed policy', () => {
  it('rejects unsigned, wrong-key and replayed policy_set; accepts the owner with increasing seq', async () => {
    const chip = await mkChip(); const p = base();
    expect((await chip.policySet(p)).code).toBe('OWNER_SIG_INVALID');
    expect((await chip.policySet(p, { seq: 1, owner_pubkey: owner.getPublicKey().toString(), owner_sig: Buffer.alloc(64).toString('base64') })).code).toBe('OWNER_SIG_INVALID'); // bad signature
    const ok = await setPolicy(chip, p, 1); // first valid set binds the owner key expect(ok.ok).toBe(true); expect(ok.policy_seq).toBe(1); expect(ok.owner_pubkey).toBe(owner.getPublicKey().toString());
    expect((await setPolicy(chip, p, 1)).code).toBe('OWNER_SIG_INVALID');                              // replayed seq
    expect((await setPolicy(chip, p, 2, n.KeyPairEd25519.fromRandom())).code).toBe('OWNER_SIG_INVALID'); // not the owner any more
    const tampered = signPolicyAuth(p, 2, owner); expect((await chip.policySet({ ...p, per_tx_cap: '999999999' }, tampered)).code).toBe('OWNER_SIG_INVALID'); // policy changed after signing
    expect((await setPolicy(chip, { ...p, per_tx_cap: '7000000' }, 2)).ok).toBe(true);
    expect((await chip.hello()).policy_seq).toBe(2);
  });
  it('digest covers policy bytes and seq', () => {
    const p = base(); const d1 = policyAuthDigest(p, 1), d2 = policyAuthDigest(p, 2), d3 = policyAuthDigest({ ...p, per_tx_cap: '1' }, 1);
    expect(Buffer.from(d1).equals(Buffer.from(d2))).toBe(false); expect(Buffer.from(d1).equals(Buffer.from(d3))).toBe(false);
  });
});

describe('owner-signed policy, NEP-413 scheme (browser wallets)', () => {
  it('accepts a wallet-style NEP-413 signature and rejects a tampered nonce or recipient', async () => {
    const chip = await mkChip(); const p = base();
    const auth = signPolicyAuthNep413(p, 1, owner, 'fuse');
    expect((await chip.policySet(p, { ...auth, recipient: 'other' })).code).toBe('OWNER_SIG_INVALID');
    expect((await chip.policySet(p, { ...auth, nonce: Buffer.alloc(32, 7).toString('base64') })).code).toBe('OWNER_SIG_INVALID');
    const ok = await chip.policySet(p, auth); expect(ok.ok).toBe(true); expect(ok.policy_seq).toBe(1);
    expect((await chip.policySet(p, signPolicyAuthNep413(p, 1, owner))).code).toBe('OWNER_SIG_INVALID'); // replayed seq
    expect((await chip.policySet(p, signPolicyAuthNep413(p, 2, owner))).ok).toBe(true);
  });
  it('prints a fixed vector for the firmware', async () => {
    // seed sha256("fuse-owner-test") = the firmware stream's owner test key; nonce = 0x01..0x20; recipient "fuse"; seq 3
    const seed = sha256(new TextEncoder().encode('fuse-owner-test')); const pub = await ed.getPublicKeyAsync(seed);
    const pol = JSON.parse('{"agent":"agent.alice.testnet","wallet":"fuse.alice.testnet","methods":["pay"],"receivers":["api.testnet"],"tokens":["near"],"per_tx_cap":"5000000","button_threshold":"1000000","chain_value_cap":"0","chain_dests":[],"gas_cap":100000000000000,"velocity_cap":20,"velocity_window_ms":600000}');
    const nonce = new Uint8Array(32).map((_, i) => i + 1); const message = policyAuthMessage(pol, 3);
    const hash = nep413Hash({ message, nonce, recipient: 'fuse' }); const sig = await ed.signAsync(hash, seed);
    expect(message).toBe('FUSE_POLICY_V1:4c27cb469ff311d40b7bbeaab6269934a586aeb75034b7c88f5e271e33d3118e:3');
    expect(await ed.verifyAsync(sig, hash, pub)).toBe(true);
    console.log(`VECTOR nep413: pubkey=ed25519:${bs58.encode(pub)} message=${message} nonce=0102..20 recipient=fuse hash=${Buffer.from(hash).toString('hex')} sig_b64=${Buffer.from(sig).toString('base64')}`);
  });
});

describe('fw attestation argument', () => {
  it('refuses a mismatching fw, requires it when the policy says so, accepts the chip\'s own hash', async () => {
    const chip = await mkChip(); const h = await chip.hello(); const pk = n.PublicKey.fromString(h.pubkey);
    expect(h.fw_sha256).toBe(SIM_FW_SHA256);
    await setPolicy(chip, base(), 1);
    const bad = await chip.sign(payTx(pk, next(), { receiver: 'api.testnet', token: 'near', amount: '1', fw: 'ab'.repeat(32) }), 'x'); expect(bad.ok).toBe(false); if (!bad.ok) expect(bad.code).toBe('FW_MISMATCH');
    const good = await chip.sign(payTx(pk, next(), { receiver: 'api.testnet', token: 'near', amount: '1', fw: SIM_FW_SHA256 }), 'x'); expect(good.ok).toBe(true);
    await setPolicy(chip, { ...base(), require_fw_arg: true }, 2);
    const missing = await chip.sign(payTx(pk, next(), { receiver: 'api.testnet', token: 'near', amount: '1' }), 'x'); expect(missing.ok).toBe(false); if (!missing.ok) expect(missing.code).toBe('FW_MISMATCH');
  });
});

describe('attested decisions', () => {
  const tee = DevDecisionSigner.fromHex('11'.repeat(32)); const other = DevDecisionSigner.fromHex('22'.repeat(32));
  const req = new TextEncoder().encode('{"messages":[...]}');
  const resp = (receiver: string, amount: string) => new TextEncoder().encode(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'pay', arguments: JSON.stringify({ receiver, token: 'near', amount }) } }] } }] }));
  it('requires, verifies and binds the decision when the policy names signers', async () => {
    const chip = await mkChip(); const h = await chip.hello(); const pk = n.PublicKey.fromString(h.pubkey);
    await setPolicy(chip, { ...base(), decision_signers: [await tee.pubkey()] }, 1);
    const args = { receiver: 'api.testnet', token: 'near', amount: '1' };
    const none = await chip.sign(payTx(pk, next(), args), 'x'); expect(none.ok).toBe(false); if (!none.ok) expect(none.code).toBe('DECISION_REQUIRED');
    const wrong = await chip.sign(payTx(pk, next(), args), 'x', await other.sign('m', req, resp('api.testnet', '1'))); expect(wrong.ok).toBe(false); if (!wrong.ok) expect(wrong.code).toBe('DECISION_INVALID');
    const env = await chip.sign(payTx(pk, next(), args), 'x', await tee.sign('m', req, resp('api.testnet', '1'), false)); expect(env.ok).toBe(true); if (env.ok) expect(env.decision).toBe('envelope');
    const bound = await chip.sign(payTx(pk, next(), args), 'x', await tee.sign('m', req, resp('api.testnet', '1'))); expect(bound.ok).toBe(true); if (bound.ok) expect(bound.decision).toBe('bound');
    const mismatch = await chip.sign(payTx(pk, next(), args), 'x', await tee.sign('m', req, resp('attacker.testnet', '1'))); expect(mismatch.ok).toBe(false); if (!mismatch.ok) expect(mismatch.code).toBe('DECISION_INVALID');
    const forged = await tee.sign('m', req, resp('api.testnet', '1')); forged.sig = Buffer.from(new Uint8Array(64)).toString('base64');
    const bad = await chip.sign(payTx(pk, next(), args), 'x', forged); expect(bad.ok).toBe(false); if (!bad.ok) expect(bad.code).toBe('DECISION_INVALID');
  });
  it('is a no-op without decision_signers', async () => {
    expect((await checkDecision(base(), { receiver: 'a', amount: '1' })).code).toBe('OK');
  });
});

// Vectors produced independently by the firmware stream (python-cryptography); the bridge must accept exactly the same bytes.
describe('cross-stream vectors (firmware)', () => {
  it('receipt v2 second vector', () => {
    const h = new Uint8Array(32).map((_, i) => 0x10 + i);
    expect(Buffer.from(refusalDigestV2(h, 13, 7, 'api.testnet')).toString('hex')).toBe('b64f94e092b747cef16960ff118cc455f16d6292acfbad09efd6ac5b686c6c4e');
  });
  it('decision envelope signed by the firmware test signer verifies and binds', async () => {
    const p = { ...base(), decision_signers: ['ed25519:FMxFC7wbkwqNCsgpzXNRPbqzqhKwCeEwrXF4dEwtiQPu'] };
    const d = { text: 'fuse-test-model:1f58b9145b24d108d7ac38887338b3ea3229833b9c1e418250343f907bfd1047:a75cf475eae9eb13d051d33b901688ffc69cb4df94ea5b9bd816cd03408eb9a3', sig: 'whuSC4t7DV6O73ZWH9NVniH0eJv26GIxzO2zoCqswqr4mONGzruEP5AEt35JKNg8+Ktsif094z8/DYrBAF/IAA==', signer: 'ed25519:FMxFC7wbkwqNCsgpzXNRPbqzqhKwCeEwrXF4dEwtiQPu', resp: 'eyJyZWNlaXZlciI6ImFwaS50ZXN0bmV0IiwiYW1vdW50IjoiMjAwMDAwMCJ9' };
    const ok = await checkDecision(p, { receiver: 'api.testnet', amount: '2000000' }, d); expect(ok.code).toBe('OK'); expect(ok.binding).toBe('bound');
    const other = await checkDecision(p, { receiver: 'attacker.testnet', amount: '2000000' }, d); expect(other.code).toBe('DECISION_INVALID');
  });
  it('owner policy_set digest and signature from the firmware vector', async () => {
    const pol = JSON.parse('{"agent":"agent.alice.testnet","wallet":"fuse.alice.testnet","methods":["pay"],"receivers":["api.testnet"],"tokens":["near"],"per_tx_cap":"5000000","button_threshold":"1000000","chain_value_cap":"0","chain_dests":[],"gas_cap":100000000000000,"velocity_cap":20,"velocity_window_ms":600000}');
    expect(Buffer.from(sha256(new TextEncoder().encode(JSON.stringify(pol)))).toString('hex')).toBe('4c27cb469ff311d40b7bbeaab6269934a586aeb75034b7c88f5e271e33d3118e');
    expect(Buffer.from(policyAuthDigest(pol, 3)).toString('hex')).toBe('95ea6fce8e2c7d90702eb98b5872f2e002188fc3e35a0b270b9b360aee3a9d29');
    const pk = bs58.decode('G7qZoG55gG8SEHMbtFeKJHN6ZTzUSL8itaWbXWq2f5DG');
    expect(await ed.verifyAsync(Buffer.from('fHiOq18PS5p/OgiQDtDSMTyHfHbtktzspIecKgNrYMV3ssi4np8ez0kIluSU+e4+1MpHHpqGrtRdbP0jYgGoDg==', 'base64'), policyAuthDigest(pol, 3), pk)).toBe(true);
  });
});

describe('approve_payment', () => {
  const pub = new Uint8Array(32); const ctx = { chipPub: pub, lastNonce: 0n, recentSigns: 0, refusals: [] };
  const tx = (args: unknown) => { const r = decodeTransaction(payTx(new n.PublicKey({ keyType: n.KeyType.ED25519, data: pub }), 9n, args as any, 'approve_payment')); if (!r.ok) throw new Error(r.code); return r.tx; };
  it('needs the method in the policy, an integer id, and the button by default', () => {
    expect(evaluate(base(), tx({ id: 3 }), ctx).code).toBe('METHOD_NOT_ALLOWED');
    const p = { ...base(), methods: [...base().methods, 'approve_payment'] };
    expect(evaluate(p, tx({ id: 3 }), ctx).verdict).toBe('SIGN_WITH_BUTTON');
    expect(evaluate(p, tx({ id: '3' }), ctx).summary).toBe('approve payment #3');
    expect(evaluate({ ...p, approve_button: false }, tx({ id: 3 }), ctx).verdict).toBe('SIGN');
    expect(evaluate(p, tx({}), ctx).code).toBe('APPROVAL_NOT_ALLOWED');
    expect(evaluate(p, tx({ id: -1 }), ctx).code).toBe('APPROVAL_NOT_ALLOWED');
  });
});
