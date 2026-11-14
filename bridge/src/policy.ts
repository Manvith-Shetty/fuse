// Policy engine, a port of firmware/lib/fusecore/policy.cpp. Used by the simulated chip and by tests.
import type { DecodedTx } from './borsh.js';
import type { CodeName } from './codes.js';
import type { DecisionEnvelope } from './chip.js';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

export interface Policy {
  agent: string; wallet: string; methods: string[]; receivers: string[]; tokens: string[];
  per_tx_cap: string; button_threshold: string; chain_value_cap: string;
  chain_dests: { chain: string; to: string }[]; gas_cap: number; velocity_cap: number; velocity_window_ms: number;
  // v2 (docs/v2-spec.md 2.1), all optional and permissive by default
  require_fw_arg?: boolean;      // pay / request_chain_sig args must carry fw == this chip's fw_sha256
  decision_signers?: string[];   // non-empty: pay needs an attested decision signed by one of these ed25519 keys
  approve_button?: boolean;      // approve_payment needs the button (default true)
}
export interface RefusalRecord { hash: Uint8Array; code: number; counter: number }
export type Verdict = 'SIGN' | 'SIGN_WITH_BUTTON' | 'REFUSE';
export interface Decision { verdict: Verdict; code: CodeName; detail: string; summary: string }
export interface EvalContext { chipPub: Uint8Array; lastNonce: bigint; recentSigns: number; refusals: RefusalRecord[]; fwSha256?: string }

export function defaultPolicy(agent: string, wallet: string): Policy {
  return {
    agent, wallet, methods: ['pay', 'record_refusal', 'request_chain_sig'], receivers: [], tokens: ['near'],
    per_tx_cap: '1000000000000000000000000', button_threshold: '500000000000000000000000', chain_value_cap: '0',
    chain_dests: [], gas_cap: 100_000_000_000_000, velocity_cap: 20, velocity_window_ms: 600_000,
  };
}
const isDecimal = (s: unknown): s is string => typeof s === 'string' && /^[0-9]{1,40}$/.test(s);
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const refuse = (code: CodeName, detail: string): Decision => ({ verdict: 'REFUSE', code, detail, summary: '' });
export const parseKey32 = (s: string): Uint8Array | null => { try { const k = bs58.decode(s.replace(/^ed25519:/, '')); return k.length === 32 ? k : null; } catch { return null; } };

// fw attestation argument (spec 2.4): present → must match; absent → fine unless the policy requires it.
function fwCheck(p: Policy, a: any, ctx: EvalContext): Decision | null {
  if (a.fw !== undefined) {
    if (typeof a.fw !== 'string' || !ctx.fwSha256 || a.fw.toLowerCase() !== ctx.fwSha256.toLowerCase()) return refuse('FW_MISMATCH', `fw ${String(a.fw).slice(0, 16)} is not this chip`);
  } else if (p.require_fw_arg) return refuse('FW_MISMATCH', 'policy requires the fw argument');
  return null;
}

export function evaluate(p: Policy, tx: DecodedTx, ctx: EvalContext): Decision {
  if (tx.signer !== p.agent) return refuse('WRONG_SIGNER', `signer ${tx.signer}`);
  if (!eq(tx.pubkey, ctx.chipPub)) return refuse('WRONG_KEY', 'public key is not this chip');
  if (tx.receiver !== p.wallet) return refuse('WRONG_RECEIVER', `receiver ${tx.receiver}`);
  if (!p.methods.includes(tx.method)) return refuse('METHOD_NOT_ALLOWED', `method ${tx.method}`);
  if (tx.deposit !== 0n) return refuse('DEPOSIT_NOT_ZERO', 'deposit attached');
  if (tx.gas > BigInt(p.gas_cap)) return refuse('GAS_TOO_HIGH', 'gas over cap');
  if (tx.nonce <= ctx.lastNonce) return refuse('NONCE_REPLAY', 'nonce not increasing');
  if (ctx.recentSigns >= p.velocity_cap) return refuse('VELOCITY_CAP', 'too many signatures in window');
  let a: any;
  try { a = JSON.parse(new TextDecoder().decode(tx.args)); } catch { return refuse('BAD_ARGS', 'args not JSON'); }
  if (!a || typeof a !== 'object' || Array.isArray(a)) return refuse('BAD_ARGS', 'args not an object');

  if (tx.method === 'pay') {
    const { receiver, token, amount } = a;
    if (!receiver || !token || !isDecimal(amount)) return refuse('BAD_ARGS', 'pay needs receiver, token, decimal amount');
    if (!p.receivers.includes(receiver)) return refuse('RECEIVER_NOT_ALLOWED', `receiver ${receiver}`);
    if (!p.tokens.includes(token)) return refuse('TOKEN_NOT_ALLOWED', `token ${token}`);
    if (BigInt(amount) > BigInt(p.per_tx_cap)) return refuse('AMOUNT_OVER_CAP', `amount ${amount} > cap ${p.per_tx_cap}`);
    const fw = fwCheck(p, a, ctx); if (fw) return fw;
    const verdict: Verdict = BigInt(amount) > BigInt(p.button_threshold) ? 'SIGN_WITH_BUTTON' : 'SIGN';
    return { verdict, code: 'OK', detail: '', summary: `pay ${amount} ${token} -> ${receiver}` };
  }
  if (tx.method === 'record_refusal') {
    let h: Uint8Array; try { h = bs58.decode(String(a.tx_hash ?? '')); } catch { h = new Uint8Array(); }
    if (h.length !== 32) return refuse('BAD_ARGS', 'tx_hash must be base58 32 bytes');
    const found = ctx.refusals.some(r => r.counter === a.counter && r.code === a.code && eq(r.hash, h));
    if (!found) return refuse('REFUSAL_MISMATCH', 'no such refusal issued by this chip');
    return { verdict: 'SIGN', code: 'OK', detail: '', summary: `record refusal #${a.counter}` };
  }
  if (tx.method === 'request_chain_sig') {
    const { chain, to, value } = a;
    if (!chain || !to || !isDecimal(value)) return refuse('BAD_ARGS', 'chain, to, decimal value required');
    if (!p.chain_dests.some(d => d.chain === chain && d.to === to)) return refuse('CHAIN_DEST_NOT_ALLOWED', `${chain}:${to}`);
    if (BigInt(value) > BigInt(p.chain_value_cap)) return refuse('CHAIN_VALUE_OVER_CAP', `value ${value}`);
    const fw = fwCheck(p, a, ctx); if (fw) return fw;
    return { verdict: 'SIGN_WITH_BUTTON', code: 'OK', detail: '', summary: `chain_sig ${chain} ${value} -> ${to}` };
  }
  if (tx.method === 'approve_payment') {
    // Second-chip approval of a pending payment (spec 2.5). The id is the only argument; the button is the policy.
    const id = typeof a.id === 'number' && Number.isInteger(a.id) && a.id >= 0 ? a.id : isDecimal(a.id) ? Number(a.id) : null;
    if (id === null) return refuse('APPROVAL_NOT_ALLOWED', 'approve_payment needs an integer id');
    return { verdict: p.approve_button === false ? 'SIGN' : 'SIGN_WITH_BUTTON', code: 'OK', detail: '', summary: `approve payment #${id}` };
  }
  return refuse('METHOD_NOT_ALLOWED', `no rule for ${tx.method}`);
}

// Attested decision check (spec 2.3). Only for `pay`, only when the policy names decision signers.
// Returns the refusal code or OK, plus how strongly the decision is bound to this payment.
export async function checkDecision(p: Policy, pay: { receiver: string; amount: string }, d?: DecisionEnvelope): Promise<{ code: CodeName; detail: string; binding: 'none' | 'envelope' | 'bound' }> {
  const signers = (p.decision_signers ?? []).map(parseKey32).filter((k): k is Uint8Array => !!k);
  if (!(p.decision_signers ?? []).length) return { code: 'OK', detail: '', binding: 'none' };
  if (!d || typeof d.text !== 'string' || typeof d.sig !== 'string' || typeof d.signer !== 'string') return { code: 'DECISION_REQUIRED', detail: 'policy requires an attested decision', binding: 'none' };
  const signer = parseKey32(d.signer);
  if (!signer || !signers.some(k => eq(k, signer))) return { code: 'DECISION_INVALID', detail: 'signer not in decision_signers', binding: 'none' };
  let sig: Uint8Array; try { sig = new Uint8Array(Buffer.from(d.sig, 'base64')); } catch { sig = new Uint8Array(); }
  if (sig.length !== 64) return { code: 'DECISION_INVALID', detail: 'signature must be 64 bytes', binding: 'none' };
  const okSig = await ed.verifyAsync(sig, sha256(new TextEncoder().encode(d.text)), signer).catch(() => false);
  if (!okSig) return { code: 'DECISION_INVALID', detail: 'signature does not verify', binding: 'none' };
  if (d.resp === undefined) return { code: 'OK', detail: '', binding: 'envelope' };
  const resp = Buffer.from(d.resp, 'base64');
  if (resp.length > 8192) return { code: 'DECISION_INVALID', detail: 'response over 8 KiB', binding: 'none' };
  const respHash = Buffer.from(sha256(resp)).toString('hex');
  const segs = d.text.split(':');
  if (segs.length < 3 || segs[segs.length - 1].toLowerCase() !== respHash) return { code: 'DECISION_INVALID', detail: 'response hash does not match the signed text', binding: 'none' };
  const s = resp.toString('utf8');
  if (!s.includes(pay.receiver) || !s.includes(pay.amount)) return { code: 'DECISION_INVALID', detail: 'response does not mention this receiver and amount', binding: 'none' };
  return { code: 'OK', detail: '', binding: 'bound' };
}

// Owner-signed policy (spec 2.2): sha256("FUSE_POLICY_V1" || sha256(compact policy JSON) || seq_u32_le).
export function policyBytes(policy: Policy): Uint8Array { return new TextEncoder().encode(JSON.stringify(policy)); }
export function policyHashHex(policy: Policy): string { return Buffer.from(sha256(policyBytes(policy))).toString('hex').slice(0, 16); }
export function policyAuthDigest(policy: Policy, seq: number): Uint8Array {
  const dom = new TextEncoder().encode('FUSE_POLICY_V1'); const ph = sha256(policyBytes(policy));
  const buf = new Uint8Array(dom.length + 32 + 4); buf.set(dom, 0); buf.set(ph, dom.length); new DataView(buf.buffer).setUint32(dom.length + 32, seq, true);
  return sha256(buf);
}

// NEP-413 (wallet signMessage) variant of the owner authorisation: the wallet signs a human-readable message that commits
// to the policy hash and the sequence. hash = sha256(borsh(u32 2^31+413) || borsh(message) || nonce[32] || borsh(recipient) || borsh(Option<callbackUrl>)).
export const NEP413_TAG = 2147484061;
export function policyAuthMessage(policy: Policy, seq: number): string { return `FUSE_POLICY_V1:${Buffer.from(sha256(policyBytes(policy))).toString('hex')}:${seq}`; }
export function nep413Hash(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }): Uint8Array {
  if (p.nonce.length !== 32) throw new Error('nep413 nonce must be 32 bytes');
  const str = (s: string) => { const b = new TextEncoder().encode(s); const out = new Uint8Array(4 + b.length); new DataView(out.buffer).setUint32(0, b.length, true); out.set(b, 4); return out; };
  const tag = new Uint8Array(4); new DataView(tag.buffer).setUint32(0, NEP413_TAG, true);
  const cb = p.callbackUrl === undefined ? new Uint8Array([0]) : Buffer.concat([new Uint8Array([1]), str(p.callbackUrl)]);
  return sha256(Buffer.concat([tag, str(p.message), p.nonce, str(p.recipient), cb]));
}
// Which bytes the owner signature must verify against, for either scheme. Returns null when the auth is malformed.
export function policyAuthHash(policy: Policy, auth: { seq: number; scheme?: string; nonce?: string; recipient?: string; callback_url?: string }): Uint8Array | null {
  if (!auth.scheme || auth.scheme === 'raw') return policyAuthDigest(policy, auth.seq);
  if (auth.scheme !== 'nep413' || !auth.nonce || !auth.recipient) return null;
  let nonce: Uint8Array; try { nonce = new Uint8Array(Buffer.from(auth.nonce, 'base64')); } catch { return null; }
  if (nonce.length !== 32) return null;
  return nep413Hash({ message: policyAuthMessage(policy, auth.seq), nonce, recipient: auth.recipient, callbackUrl: auth.callback_url });
}

// Refusal receipt digests. v1: tx_hash || code || counter. v2 adds sha256(receiver) or 32 zero bytes (spec 2.6).
export function refusalDigestV1(txHash: Uint8Array, code: number, counter: number): Uint8Array {
  const buf = new Uint8Array(15 + 32 + 1 + 4); buf.set(new TextEncoder().encode('FUSE_REFUSAL_V1'), 0); buf.set(txHash, 15); buf[47] = code;
  new DataView(buf.buffer).setUint32(48, counter, true); return sha256(buf);
}
export function refusalDigestV2(txHash: Uint8Array, code: number, counter: number, receiver: string): Uint8Array {
  const buf = new Uint8Array(15 + 32 + 1 + 4 + 32); buf.set(new TextEncoder().encode('FUSE_REFUSAL_V2'), 0); buf.set(txHash, 15); buf[47] = code;
  new DataView(buf.buffer).setUint32(48, counter, true);
  if (receiver) buf.set(sha256(new TextEncoder().encode(receiver)), 52);
  return sha256(buf);
}
