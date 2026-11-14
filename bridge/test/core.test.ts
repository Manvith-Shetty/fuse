import { describe, it, expect } from 'vitest';
import * as n from 'near-api-js';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { decodeTransaction } from '../src/borsh.js';
import { evaluate, defaultPolicy, refusalDigestV2 } from '../src/policy.js';
import { SimChip } from '../src/chip-sim.js';
import { signPolicyAuth } from '../src/keychain.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const VEC_HEX = '130000006167656e742e616c6963652e746573746e657400563298983af5691517bda3169243e32d9da657a594c2ce394b7c04156802dcfc2a0000000000000012000000667573652e616c6963652e746573746e657407070707070707070707070707070707070707070707070707070707070707070100000002030000007061794f0000007b227265636569766572223a226170692e746573746e6574222c22746f6b656e223a22757364632e746573746e6574222c22616d6f756e74223a2232303030303030222c226d656d6f223a226d227d00e057eb481b000000000000000000000000000000000000';
const vec = () => new Uint8Array(Buffer.from(VEC_HEX, 'hex'));

describe('strict borsh decoder (mirror of firmware)', () => {
  it('decodes the near-api-js vector', () => {
    const r = decodeTransaction(vec()); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.tx.signer).toBe('agent.alice.testnet'); expect(r.tx.receiver).toBe('fuse.alice.testnet'); expect(r.tx.nonce).toBe(42n);
    expect(r.tx.method).toBe('pay'); expect(r.tx.gas).toBe(30_000_000_000_000n); expect(r.tx.deposit).toBe(0n);
    expect(Buffer.from(r.tx.pubkey).toString('hex')).toBe('563298983af5691517bda3169243e32d9da657a594c2ce394b7c04156802dcfc');
  });
  it('matches what near-api-js encodes for a fresh random transaction', () => {
    const kp = n.KeyPairEd25519.fromRandom();
    const act = n.actions.functionCall('pay', new TextEncoder().encode('{"a":1}'), 5n, 7n);
    const tx = n.createTransaction('x.testnet', kp.getPublicKey(), 'y.testnet', 99n, [act], new Uint8Array(32));
    const r = decodeTransaction(n.encodeTransaction(tx)); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.tx.nonce).toBe(99n); expect(r.tx.gas).toBe(5n); expect(r.tx.deposit).toBe(7n); expect(Buffer.from(r.tx.pubkey)).toEqual(Buffer.from(kp.getPublicKey().data));
  });
  it('rejects trailing bytes, multiple actions, transfers', () => {
    const t = vec(); expect(decodeTransaction(new Uint8Array([...t, 0]))).toEqual({ ok: false, code: 'TRAILING_BYTES' });
    const m = vec(); m[118] = 2; expect(decodeTransaction(m)).toEqual({ ok: false, code: 'MULTI_ACTION' });
    const x = vec(); x[122] = 3; expect(decodeTransaction(x)).toEqual({ ok: false, code: 'NOT_FUNCTION_CALL' });
    const kp = n.KeyPairEd25519.fromRandom();
    const two = n.createTransaction('x.testnet', kp.getPublicKey(), 'y.testnet', 1n, [n.actions.functionCall('a', new Uint8Array(), 1n, 0n), n.actions.transfer(1n)], new Uint8Array(32));
    expect(decodeTransaction(n.encodeTransaction(two))).toEqual({ ok: false, code: 'MULTI_ACTION' });
  });
});

describe('policy', () => {
  const pub = new Uint8Array(Buffer.from('563298983af5691517bda3169243e32d9da657a594c2ce394b7c04156802dcfc', 'hex'));
  const base = () => ({ ...defaultPolicy('agent.alice.testnet', 'fuse.alice.testnet'), receivers: ['api.testnet'], tokens: ['usdc.testnet'], per_tx_cap: '5000000', button_threshold: '1000000' });
  const ctx = (o: Partial<{ lastNonce: bigint; recentSigns: number }> = {}) => ({ chipPub: pub, lastNonce: 0n, recentSigns: 0, refusals: [], ...o });
  const tx = () => { const r = decodeTransaction(vec()); if (!r.ok) throw new Error(); return r.tx; };
  it('signs with button above threshold, plain below', () => {
    expect(evaluate(base(), tx(), ctx()).verdict).toBe('SIGN_WITH_BUTTON');
    expect(evaluate({ ...base(), button_threshold: '3000000' }, tx(), ctx()).verdict).toBe('SIGN');
  });
  it('refuses with the right codes', () => {
    expect(evaluate({ ...base(), receivers: ['other'] }, tx(), ctx()).code).toBe('RECEIVER_NOT_ALLOWED');
    expect(evaluate({ ...base(), tokens: ['near'] }, tx(), ctx()).code).toBe('TOKEN_NOT_ALLOWED');
    expect(evaluate({ ...base(), per_tx_cap: '1999999' }, tx(), ctx()).code).toBe('AMOUNT_OVER_CAP');
    expect(evaluate({ ...base(), agent: 'evil' }, tx(), ctx()).code).toBe('WRONG_SIGNER');
    expect(evaluate({ ...base(), wallet: 'evil' }, tx(), ctx()).code).toBe('WRONG_RECEIVER');
    expect(evaluate({ ...base(), methods: ['x'] }, tx(), ctx()).code).toBe('METHOD_NOT_ALLOWED');
    expect(evaluate(base(), tx(), ctx({ lastNonce: 42n })).code).toBe('NONCE_REPLAY');
    expect(evaluate(base(), tx(), ctx({ recentSigns: 20 })).code).toBe('VELOCITY_CAP');
    expect(evaluate(base(), { ...tx(), deposit: 1n }, ctx()).code).toBe('DEPOSIT_NOT_ZERO');
    expect(evaluate(base(), { ...tx(), gas: 10n ** 15n }, ctx()).code).toBe('GAS_TOO_HIGH');
    expect(evaluate(base(), tx(), { ...ctx(), chipPub: new Uint8Array(32) }).code).toBe('WRONG_KEY');
  });
});

describe('simulated chip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuse-sim-'));
  const mk = () => new SimChip({ dataDir: dir, agent: 'agent.alice.testnet', wallet: 'fuse.alice.testnet', button: 'press', buttonDelayMs: 10 }).init();
  const owner = n.KeyPairEd25519.fromRandom(); // protocol v2: policy_set is signed by the owner key
  it('signs a policy-passing tx with a verifiable signature and labels itself SIMULATED', async () => {
    const chip = await mk(); const h = await chip.hello(); expect(h.mode).toBe('SIMULATED');
    const pol = { ...defaultPolicy('agent.alice.testnet', 'fuse.alice.testnet'), receivers: ['api.testnet'], tokens: ['usdc.testnet'], per_tx_cap: '5000000', button_threshold: '9000000' };
    expect((await chip.policySet(pol, signPolicyAuth(pol, 1, owner))).ok).toBe(true);
    const pk = n.PublicKey.fromString(h.pubkey);
    const act = n.actions.functionCall('pay', new TextEncoder().encode(JSON.stringify({ receiver: 'api.testnet', token: 'usdc.testnet', amount: '2000000' })), 30n * 10n ** 12n, 0n);
    const tx = n.createTransaction('agent.alice.testnet', pk, 'fuse.alice.testnet', 5n, [act], new Uint8Array(32));
    const bytes = n.encodeTransaction(tx); const r = await chip.sign(bytes, 'test');
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(await ed.verifyAsync(Buffer.from(r.sig, 'base64'), sha256(bytes), pk.data)).toBe(true);
    expect(r.hash).toBe(bs58.encode(sha256(bytes)));
    const replay = await chip.sign(bytes, 'replay'); expect(replay.ok).toBe(false); if (!replay.ok) expect(replay.code).toBe('NONCE_REPLAY');
  });
  it('refuses an out-of-policy tx with a verifiable refusal receipt, then signs the matching record_refusal', async () => {
    const chip = await mk(); const h = await chip.hello(); const pk = n.PublicKey.fromString(h.pubkey);
    const bad = n.actions.functionCall('pay', new TextEncoder().encode(JSON.stringify({ receiver: 'attacker.testnet', token: 'usdc.testnet', amount: '1' })), 30n * 10n ** 12n, 0n);
    const tx = n.createTransaction('agent.alice.testnet', pk, 'fuse.alice.testnet', 50n, [bad], new Uint8Array(32)); const bytes = n.encodeTransaction(tx);
    const r = await chip.sign(bytes, 'evil'); expect(r.ok).toBe(false); if (r.ok) return;
    expect(r.code).toBe('RECEIVER_NOT_ALLOWED'); expect(r.receipt).toBeTruthy();
    // receipt v2 (docs/v2-spec.md 2.6): the refused receiver is bound into the digest
    expect(r.receipt_v).toBe(2); expect(r.receiver).toBe('attacker.testnet');
    expect(await ed.verifyAsync(Buffer.from(r.receipt!, 'base64'), refusalDigestV2(sha256(bytes), r.code_num!, r.counter!, 'attacker.testnet'), pk.data)).toBe(true);
    const rec = n.actions.functionCall('record_refusal', new TextEncoder().encode(JSON.stringify({ tx_hash: r.hash, code: r.code_num, counter: r.counter, receipt_sig: r.receipt })), 30n * 10n ** 12n, 0n);
    const tx2 = n.createTransaction('agent.alice.testnet', pk, 'fuse.alice.testnet', 51n, [rec], new Uint8Array(32));
    const r2 = await chip.sign(n.encodeTransaction(tx2), 'record'); expect(r2.ok).toBe(true);
    const forged = n.actions.functionCall('record_refusal', new TextEncoder().encode(JSON.stringify({ tx_hash: r.hash, code: r.code_num, counter: 999, receipt_sig: r.receipt })), 30n * 10n ** 12n, 0n);
    const r3 = await chip.sign(n.encodeTransaction(n.createTransaction('agent.alice.testnet', pk, 'fuse.alice.testnet', 52n, [forged], new Uint8Array(32))), 'forged');
    expect(r3.ok).toBe(false); if (!r3.ok) expect(r3.code).toBe('REFUSAL_MISMATCH');
  });
});
