// Policy engine, a port of firmware/lib/fusecore/policy.cpp. Used by the simulated chip and by tests.
import type { DecodedTx } from './borsh.js';
import type { CodeName } from './codes.js';
import bs58 from 'bs58';

export interface Policy {
  agent: string; wallet: string; methods: string[]; receivers: string[]; tokens: string[];
  per_tx_cap: string; button_threshold: string; chain_value_cap: string;
  chain_dests: { chain: string; to: string }[]; gas_cap: number; velocity_cap: number; velocity_window_ms: number;
}
export interface RefusalRecord { hash: Uint8Array; code: number; counter: number }
export type Verdict = 'SIGN' | 'SIGN_WITH_BUTTON' | 'REFUSE';
export interface Decision { verdict: Verdict; code: CodeName; detail: string; summary: string }
export interface EvalContext { chipPub: Uint8Array; lastNonce: bigint; recentSigns: number; refusals: RefusalRecord[] }

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
    return { verdict: 'SIGN_WITH_BUTTON', code: 'OK', detail: '', summary: `chain_sig ${chain} ${value} -> ${to}` };
  }
  return refuse('METHOD_NOT_ALLOWED', `no rule for ${tx.method}`);
}
