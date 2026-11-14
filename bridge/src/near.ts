import { JsonRpcProvider, PublicKey, createTransaction, encodeTransaction, actions, SignedTransaction, Signature, KeyType, baseDecode, baseEncode } from 'near-api-js';
import { sha256 } from '@noble/hashes/sha2.js';

export interface BuildArgs { signerId: string; publicKey: string; receiverId: string; method: string; args: Record<string, unknown>; gasTgas?: number; depositYocto?: bigint; minNonce?: bigint }
export interface Built { tx: any; bytes: Uint8Array; nonce: bigint; hash: string; blockHash: string }

// Builds unsigned transactions and broadcasts chip-signed ones. Holds no keys.
export class Near {
  readonly provider: JsonRpcProvider;
  constructor(public readonly rpcUrl: string) { this.provider = new JsonRpcProvider({ url: rpcUrl }); }

  async accessKeyNonce(accountId: string, publicKey: string): Promise<bigint> {
    // optimistic: includes transactions sent a block ago, so two proposers in a row do not reuse a nonce
    const r: any = await this.provider.query({ request_type: 'view_access_key', finality: 'optimistic', account_id: accountId, public_key: publicKey });
    return BigInt(r.nonce);
  }
  async accessKeys(accountId: string): Promise<any[]> {
    const r: any = await this.provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: accountId });
    return r.keys ?? [];
  }
  async latestBlockHash(): Promise<string> { const b: any = await this.provider.viewBlock({ finality: 'final' }); return b.header.hash; }

  async build(a: BuildArgs): Promise<Built> {
    const pk = PublicKey.fromString(a.publicKey);
    // The chip refuses any nonce not above the last one it signed, including signatures that were never broadcast
    // (smoke tests, dropped txs), so take the larger of the chain's next nonce and the chip's. NEAR accepts gaps.
    const chainNext = (await this.accessKeyNonce(a.signerId, a.publicKey)) + 1n;
    const nonce = a.minNonce !== undefined && a.minNonce > chainNext ? a.minNonce : chainNext;
    const blockHash = await this.latestBlockHash();
    const argsBytes = new TextEncoder().encode(JSON.stringify(a.args));
    const gas = BigInt(a.gasTgas ?? 30) * 1_000_000_000_000n;
    const action = actions.functionCall(a.method, argsBytes, gas, a.depositYocto ?? 0n);
    const tx = createTransaction(a.signerId, pk, a.receiverId, nonce, [action], baseDecode(blockHash));
    const bytes = encodeTransaction(tx);
    return { tx, bytes, nonce, hash: baseEncode(sha256(bytes)), blockHash };
  }
  assemble(tx: any, sigBase64: string): SignedTransaction {
    const data = new Uint8Array(Buffer.from(sigBase64, 'base64'));
    if (data.length !== 64) throw new Error('signature must be 64 bytes');
    return new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: KeyType.ED25519, data }) });
  }
  async send(signed: SignedTransaction): Promise<any> { return this.provider.sendTransaction(signed); }
  async view(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } } as any);
  }
}
export function outcomeStatus(outcome: any): { ok: boolean; error?: string } {
  const st = outcome?.status;
  if (st && typeof st === 'object' && 'SuccessValue' in st) return { ok: true };
  if (st && typeof st === 'object' && 'Failure' in st) return { ok: false, error: JSON.stringify(st.Failure) };
  return { ok: !!st, error: st ? undefined : 'no status' };
}
