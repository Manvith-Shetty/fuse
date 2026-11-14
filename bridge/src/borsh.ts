// Strict NEAR Transaction decoder, a line-for-line port of firmware/lib/fusecore/borsh.cpp.
// Used by the simulated chip and by tests. Layout verified against near-api-js 7.5.3.
import type { CodeName } from './codes.js';

export interface DecodedTx {
  signer: string; keyType: number; pubkey: Uint8Array; nonce: bigint; receiver: string; blockHash: Uint8Array;
  nActions: number; actionTag: number; method: string; args: Uint8Array; gas: bigint; deposit: bigint;
}
export type DecodeResult = { ok: true; tx: DecodedTx } | { ok: false; code: CodeName };

export function decodeTransaction(buf: Uint8Array): DecodeResult {
  if (buf.length === 0 || buf.length > 8192) return { ok: false, code: 'TX_TOO_LARGE' };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const bad = (): DecodeResult => ({ ok: false, code: 'BAD_BORSH' });
  const need = (n: number) => o + n <= buf.length;
  const u8 = () => buf[o++];
  const u32 = () => { const v = dv.getUint32(o, true); o += 4; return v; };
  const u64 = () => { const v = dv.getBigUint64(o, true); o += 8; return v; };
  const str = (max: number): string | null => {
    if (!need(4)) return null; const l = u32(); if (l > max || !need(l)) return null;
    const s = new TextDecoder().decode(buf.subarray(o, o + l)); o += l; return s;
  };
  const bytes = (n: number): Uint8Array | null => { if (!need(n)) return null; const b = buf.slice(o, o + n); o += n; return b; };

  const signer = str(64); if (signer === null) return bad();
  if (!need(1)) return bad(); const keyType = u8(); if (keyType !== 0) return bad();
  const pubkey = bytes(32); if (!pubkey) return bad();
  if (!need(8)) return bad(); const nonce = u64();
  const receiver = str(64); if (receiver === null) return bad();
  const blockHash = bytes(32); if (!blockHash) return bad();
  if (!need(4)) return bad(); const nActions = u32();
  if (nActions === 0) return bad(); if (nActions !== 1) return { ok: false, code: 'MULTI_ACTION' };
  if (!need(1)) return bad(); const actionTag = u8(); if (actionTag !== 2) return { ok: false, code: 'NOT_FUNCTION_CALL' };
  const method = str(64); if (method === null) return bad();
  if (!need(4)) return bad(); const al = u32(); if (al > 4096) return bad(); const args = bytes(al); if (!args) return bad();
  if (!need(8)) return bad(); const gas = u64();
  if (!need(16)) return bad(); const lo = u64(); const hi = u64(); const deposit = (hi << 64n) | lo;
  if (o !== buf.length) return { ok: false, code: 'TRAILING_BYTES' };
  return { ok: true, tx: { signer, keyType, pubkey, nonce, receiver, blockHash, nActions, actionTag, method, args, gas, deposit } };
}
