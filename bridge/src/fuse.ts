import { Near, outcomeStatus } from './near.js';
import type { Chip, SignResult, DecisionEnvelope, HelloResult } from './chip.js';
import { Log } from './log.js';
import { explorerTx, type Config } from './config.js';

export interface PayRequest { receiver: string; token: string; amount: string; memo?: string }
export interface Counterparty { verdict: 'allow' | 'warn' | 'block'; reports?: number; distinct_reporters?: number; distinct_chips?: number; bound_reports?: number; trusted_reports?: number; last_ts?: string; manual?: string | null; top_codes?: [number, number][]; registry?: string; error?: string }
export interface PayResult {
  ok: boolean; mode: string; hash: string; explorer?: string; summary?: string; button?: boolean; code?: string; detail?: string;
  refusal?: { counter: number; recorded?: boolean; hash?: string; explorer?: string; error?: string; receipt_v?: number; receiver?: string };
  error?: string;
  // v2
  pending?: boolean;                 // quorum: stored onchain, waits for approve_payment by a second chip
  decision?: 'none' | 'envelope' | 'bound';
  counterparty?: Counterparty;       // shared-registry verdict shown to humans and models; the chip still decides
}

// The whole Fuse flow: build -> chip decides -> broadcast; on refusal, record the chip's receipt onchain.
export class Fuse {
  constructor(public cfg: Config, public chip: Chip, public near: Near, public log: Log) {}

  async chipPubkey(): Promise<string> { return (await this.chip.hello()).pubkey; }

  // fw attestation argument (spec 2.4): on when the env says so, else only for a chip that speaks protocol v2.
  private fwArg(hello: HelloResult): string | undefined {
    if (!hello.fw_sha256) return undefined;
    if (this.cfg.FUSE_FW_ARG === '1') return hello.fw_sha256;
    if (this.cfg.FUSE_FW_ARG === '0') return undefined;
    return (hello.proto ?? 1) >= 2 ? hello.fw_sha256 : undefined;
  }

  async callThroughChip(method: string, args: Record<string, unknown>, hint: string, gasTgas = 30, decision?: DecisionEnvelope): Promise<{ sign: SignResult; outcome?: any; built: any }> {
    const hello = await this.chip.hello(); const pubkey = hello.pubkey;
    const minNonce = BigInt(hello.last_nonce ?? 0) + 1n; // the chip's own floor; see Near.build
    const fw = (method === 'pay' || method === 'request_chain_sig') ? this.fwArg(hello) : undefined;
    if (fw) args = { ...args, fw };
    let attempt = 0; let built!: Awaited<ReturnType<Near['build']>>; let sign!: SignResult; let outcome: any;
    for (;;) {
      built = await this.near.build({ signerId: this.cfg.AGENT_ACCOUNT, publicKey: pubkey, receiverId: this.cfg.WALLET_CONTRACT, method, args, gasTgas, minNonce });
      this.log.add({ type: 'proposed', mode: 'BRIDGE', method, args, hint, nonce: built.nonce.toString(), hash: built.hash, decision: decision ? (decision.resp ? 'bound' : 'envelope') : undefined });
      sign = await this.chip.sign(built.bytes, hint, decision);
      if (!sign.ok) { this.log.add({ type: 'refused', mode: this.chip.mode, method, hash: sign.hash, code: sign.code, detail: sign.detail, counter: sign.counter, receiver: sign.receiver, receipt_v: sign.receipt_v }); return { sign, built }; }
      this.log.add({ type: 'signed', mode: this.chip.mode, method, hash: sign.hash, summary: sign.summary, button: sign.button, decision: sign.decision });
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

  // v2 `pay` returns false (no transfer yet) when the amount is above the quorum threshold and waits for an approver.
  private static pendingFromOutcome(outcome: any): boolean {
    const sv = outcome?.status?.SuccessValue; if (typeof sv !== 'string' || !sv) return false;
    try { return Buffer.from(sv, 'base64').toString('utf8').trim() === 'false'; } catch { return false; }
  }

  async pay(req: PayRequest, decision?: DecisionEnvelope): Promise<PayResult> {
    const args = { receiver: req.receiver, token: req.token, amount: req.amount, memo: req.memo ?? null };
    const hint = `pay ${req.amount} ${req.token} -> ${req.receiver}`;
    const counterparty = await this.check(req.receiver);
    if (counterparty) this.log.add({ type: 'counterparty', mode: 'BRIDGE', receiver: req.receiver, verdict: counterparty.verdict, reports: counterparty.reports });
    const { sign, outcome } = await this.callThroughChip('pay', args, hint, 60, decision);
    if (sign.ok) {
      const st = outcomeStatus(outcome); const pending = st.ok && Fuse.pendingFromOutcome(outcome);
      if (pending) this.log.add({ type: 'pay_pending', mode: 'BRIDGE', hash: sign.hash, summary: sign.summary, detail: 'above the quorum threshold: waits for a second chip to approve' });
      return { ok: st.ok, mode: this.chip.mode, hash: sign.hash, explorer: explorerTx(this.cfg, sign.hash), summary: sign.summary, button: sign.button, error: st.error, pending, decision: sign.decision, counterparty: counterparty ?? undefined };
    }
    const res: PayResult = { ok: false, mode: this.chip.mode, hash: sign.hash, code: sign.code, detail: sign.detail, counterparty: counterparty ?? undefined };
    if (sign.receipt && sign.counter !== undefined && sign.code_num !== undefined) res.refusal = await this.recordRefusal(sign.hash, sign.code_num, sign.counter, sign.receipt, sign.receiver, sign.receipt_v);
    return res;
  }

  // The refusal receipt is itself posted through the chip: the chip only signs record_refusal for refusals it issued.
  // Receipt v2 carries the refused receiver so the wallet contract can forward evidence to the shared registry.
  async recordRefusal(txHash: string, code: number, counter: number, receipt: string, receiver?: string, version?: number) {
    const v2 = version === 2;
    const args: Record<string, unknown> = { tx_hash: txHash, code, counter, receipt_sig: receipt };
    if (v2) { args.version = 2; if (receiver) args.receiver = receiver; }
    try {
      const { sign, outcome } = await this.callThroughChip('record_refusal', args, `record refusal #${counter}`, 60);
      if (!sign.ok) return { counter, recorded: false, error: `${sign.code}: ${sign.detail}`, receipt_v: version, receiver };
      const st = outcomeStatus(outcome);
      return { counter, recorded: st.ok, hash: sign.hash, explorer: explorerTx(this.cfg, sign.hash), error: st.error, receipt_v: version, receiver };
    } catch (e: any) { return { counter, recorded: false, error: e?.message ?? String(e), receipt_v: version, receiver }; }
  }

  // Second chip: approve a pending (quorum) payment. This bridge's chip must be enrolled as an approver account.
  async approve(id: number) {
    const { sign, outcome } = await this.callThroughChip('approve_payment', { id }, `approve payment #${id}`, 60);
    if (!sign.ok) return { ok: false, mode: this.chip.mode, hash: sign.hash, code: sign.code, detail: sign.detail, id };
    const st = outcomeStatus(outcome);
    return { ok: st.ok, mode: this.chip.mode, hash: sign.hash, explorer: explorerTx(this.cfg, sign.hash), button: sign.button, error: st.error, id };
  }

  // Shared refusal registry verdict (allow / warn / block). Advisory for humans and models; the chip decides regardless.
  async check(receiver: string): Promise<Counterparty | null> {
    if (!this.cfg.REGISTRY_CONTRACT) return null;
    try { const v = await this.near.view(this.cfg.REGISTRY_CONTRACT, 'check', { receiver }); return { ...v, registry: this.cfg.REGISTRY_CONTRACT }; }
    catch (e: any) { return { verdict: 'allow', registry: this.cfg.REGISTRY_CONTRACT, error: e?.message ?? String(e) }; }
  }

  async requestChainSig(a: { chain: string; to: string; value: string; path: string; payloadBase64: string; domainId: number }) {
    const args = { chain: a.chain, to: a.to, value: a.value, path: a.path, payload: a.payloadBase64, domain_id: a.domainId };
    const { sign, outcome } = await this.callThroughChip('request_chain_sig', args, `chain_sig ${a.chain} ${a.value} -> ${a.to}`, 300);
    if (!sign.ok) return { ok: false, mode: this.chip.mode, hash: sign.hash, code: sign.code, detail: sign.detail };
    const st = outcomeStatus(outcome); return { ok: st.ok, mode: this.chip.mode, hash: sign.hash, explorer: explorerTx(this.cfg, sign.hash), error: st.error, outcome };
  }
}
