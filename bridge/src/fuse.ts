import { Near, outcomeStatus } from './near.js';
import type { Chip, SignResult } from './chip.js';
import { Log } from './log.js';
import { explorerTx, type Config } from './config.js';

export interface PayRequest { receiver: string; token: string; amount: string; memo?: string }
export interface PayResult { ok: boolean; mode: string; hash: string; explorer?: string; summary?: string; button?: boolean; code?: string; detail?: string; refusal?: { counter: number; recorded?: boolean; hash?: string; explorer?: string; error?: string }; error?: string }

// The whole Fuse flow: build -> chip decides -> broadcast; on refusal, record the chip's receipt onchain.
export class Fuse {
  constructor(public cfg: Config, public chip: Chip, public near: Near, public log: Log) {}

  async chipPubkey(): Promise<string> { return (await this.chip.hello()).pubkey; }

  async callThroughChip(method: string, args: Record<string, unknown>, hint: string, gasTgas = 30): Promise<{ sign: SignResult; outcome?: any; built: any }> {
    const hello = await this.chip.hello(); const pubkey = hello.pubkey;
    const minNonce = BigInt(hello.last_nonce ?? 0) + 1n; // the chip's own floor; see Near.build
    let attempt = 0; let built!: Awaited<ReturnType<Near['build']>>; let sign!: SignResult; let outcome: any;
    for (;;) {
      built = await this.near.build({ signerId: this.cfg.AGENT_ACCOUNT, publicKey: pubkey, receiverId: this.cfg.WALLET_CONTRACT, method, args, gasTgas, minNonce });
      this.log.add({ type: 'proposed', mode: 'BRIDGE', method, args, hint, nonce: built.nonce.toString(), hash: built.hash });
      sign = await this.chip.sign(built.bytes, hint);
      if (!sign.ok) { this.log.add({ type: 'refused', mode: this.chip.mode, method, hash: sign.hash, code: sign.code, detail: sign.detail, counter: sign.counter }); return { sign, built }; }
      this.log.add({ type: 'signed', mode: this.chip.mode, method, hash: sign.hash, summary: sign.summary, button: sign.button });
      try { outcome = await this.near.send(this.near.assemble(built.tx, sign.sig)); break; }
      catch (e: any) {
        // Another proposer used this nonce first (the chip refuses to re-sign the old bytes anyway). Rebuild once with a fresh nonce.
        if (attempt++ === 0 && /nonce/i.test(e?.message ?? '')) { this.log.add({ type: 'nonce_retry', mode: 'BRIDGE', method, detail: e.message }); continue; }
        throw e;
      }
    }
    const st = outcomeStatus(outcome);
    this.log.add({ type: st.ok ? 'executed' : 'failed_onchain', mode: 'BRIDGE', method, hash: sign.hash, explorer: explorerTx(this.cfg, sign.hash), error: st.error });
    return { sign, outcome, built };
  }

  async pay(req: PayRequest): Promise<PayResult> {
    const args = { receiver: req.receiver, token: req.token, amount: req.amount, memo: req.memo ?? null };
    const hint = `pay ${req.amount} ${req.token} -> ${req.receiver}`;
    const { sign, outcome } = await this.callThroughChip('pay', args, hint, 60);
    if (sign.ok) {
      const st = outcomeStatus(outcome);
      return { ok: st.ok, mode: this.chip.mode, hash: sign.hash, explorer: explorerTx(this.cfg, sign.hash), summary: sign.summary, button: sign.button, error: st.error };
    }
    const res: PayResult = { ok: false, mode: this.chip.mode, hash: sign.hash, code: sign.code, detail: sign.detail };
    if (sign.receipt && sign.counter !== undefined && sign.code_num !== undefined) res.refusal = await this.recordRefusal(sign.hash, sign.code_num, sign.counter, sign.receipt);
    return res;
  }

  // The refusal receipt is itself posted through the chip: the chip only signs record_refusal for refusals it issued.
  async recordRefusal(txHash: string, code: number, counter: number, receipt: string) {
    try {
      const { sign, outcome } = await this.callThroughChip('record_refusal', { tx_hash: txHash, code, counter, receipt_sig: receipt }, `record refusal #${counter}`);
      if (!sign.ok) return { counter, recorded: false, error: `${sign.code}: ${sign.detail}` };
      const st = outcomeStatus(outcome);
      return { counter, recorded: st.ok, hash: sign.hash, explorer: explorerTx(this.cfg, sign.hash), error: st.error };
    } catch (e: any) { return { counter, recorded: false, error: e?.message ?? String(e) }; }
  }

  async requestChainSig(a: { chain: string; to: string; value: string; path: string; payloadBase64: string; domainId: number }) {
    const args = { chain: a.chain, to: a.to, value: a.value, path: a.path, payload: a.payloadBase64, domain_id: a.domainId };
    const { sign, outcome } = await this.callThroughChip('request_chain_sig', args, `chain_sig ${a.chain} ${a.value} -> ${a.to}`, 300);
    if (!sign.ok) return { ok: false, mode: this.chip.mode, hash: sign.hash, code: sign.code, detail: sign.detail };
    const st = outcomeStatus(outcome); return { ok: st.ok, mode: this.chip.mode, hash: sign.hash, explorer: explorerTx(this.cfg, sign.hash), error: st.error, outcome };
  }
}
