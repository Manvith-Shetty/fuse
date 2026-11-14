// SIMULATED chip: the same decoder and policy as the firmware, a software ed25519 key on disk.
// Exists so judges and the AI screeners can run the whole flow with no hardware. Every response says SIMULATED.
import fs from 'node:fs';
import path from 'node:path';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { Chip, type HelloResult, type SignResult } from './chip.js';
import { decodeTransaction } from './borsh.js';
import { evaluate, defaultPolicy, type Policy, type RefusalRecord } from './policy.js';
import { codeNum } from './codes.js';

export interface SimOptions {
  dataDir: string; agent: string; wallet: string; button: 'press' | 'deny'; buttonDelayMs: number;
  // ATTACK-SUITE ONLY. Skips decoding and policy and signs any bytes. Not reachable from .env or the CLI;
  // only attacks/src/run.ts constructs it, to show what the protocol and contract locks stop when the
  // chip lock is gone. A real Fuse chip has no such mode: its policy is compiled into the firmware.
  unsafeSignAnything?: boolean;
}

export class SimChip extends Chip {
  readonly mode = 'SIMULATED' as const;
  private seed!: Uint8Array; private pub!: Uint8Array; private policy!: Policy;
  private lastNonce = 0n; private counter = 0; private refusals: RefusalRecord[] = []; private signTimes: number[] = [];
  private stateFile: string; private policyFile: string; private seq = 0;
  constructor(private opts: SimOptions) {
    super();
    fs.mkdirSync(opts.dataDir, { recursive: true });
    this.stateFile = path.join(opts.dataDir, 'sim-chip-state.json');
    this.policyFile = path.join(opts.dataDir, 'sim-policy.json');
  }
  async init() {
    if (this.opts.unsafeSignAnything) console.error('\n[fuse-sim] !!! COMPROMISED CHIP MODE: signing without decode or policy. Attack suite only. !!!\n');
    let st: any = {};
    if (fs.existsSync(this.stateFile)) st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    this.seed = st.seed ? Buffer.from(st.seed, 'hex') : ed.utils.randomSecretKey();
    this.pub = await ed.getPublicKeyAsync(this.seed);
    this.lastNonce = BigInt(st.lastNonce ?? 0); this.counter = st.counter ?? 0;
    this.refusals = (st.refusals ?? []).map((r: any) => ({ hash: Buffer.from(r.hash, 'hex'), code: r.code, counter: r.counter }));
    if (fs.existsSync(this.policyFile)) this.policy = JSON.parse(fs.readFileSync(this.policyFile, 'utf8'));
    else { this.policy = defaultPolicy(this.opts.agent, this.opts.wallet); fs.writeFileSync(this.policyFile, JSON.stringify(this.policy, null, 2)); }
    this.save();
    return this;
  }
  // Several bridge processes (CLI, server, attack runner) may share one simulator state file. A real chip is one
  // device with one counter; the simulator approximates that by merging the on-disk state before every decision.
  private reload() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const n = BigInt(st.lastNonce ?? 0); if (n > this.lastNonce) this.lastNonce = n;
      if ((st.counter ?? 0) > this.counter) this.counter = st.counter;
      const seen = new Set(this.refusals.map(r => r.counter));
      for (const r of st.refusals ?? []) if (!seen.has(r.counter)) this.refusals.push({ hash: Buffer.from(r.hash, 'hex'), code: r.code, counter: r.counter });
      this.refusals.sort((a, b) => a.counter - b.counter); if (this.refusals.length > 16) this.refusals = this.refusals.slice(-16);
    } catch { /* keep in-memory state */ }
  }
  private save() {
    fs.writeFileSync(this.stateFile, JSON.stringify({
      seed: Buffer.from(this.seed).toString('hex'), lastNonce: this.lastNonce.toString(), counter: this.counter,
      refusals: this.refusals.slice(-16).map(r => ({ hash: Buffer.from(r.hash).toString('hex'), code: r.code, counter: r.counter })),
      note: 'SIMULATED chip state. A real Fuse chip never exposes its seed; this file exists only so the no-hardware demo is reproducible.',
    }, null, 2));
  }
  private policyHash() { return Buffer.from(sha256(new TextEncoder().encode(JSON.stringify(this.policy)))).toString('hex').slice(0, 16); }
  async hello(): Promise<HelloResult> {
    const h: HelloResult & { compromised?: boolean } = { pubkey: 'ed25519:' + bs58.encode(this.pub), pubkey_hex: Buffer.from(this.pub).toString('hex'), fw: 'sim-0.1.0', policy_hash: this.policyHash(), counter: this.counter, last_nonce: this.lastNonce.toString(), mode: 'SIMULATED', board: 'simulator' };
    if (this.opts.unsafeSignAnything) h.compromised = true;
    return h;
  }
  async ping() { return { pong: true as const, uptime_ms: Math.floor(process.uptime() * 1000) }; }
  async decode(txBytes: Uint8Array) {
    const r = decodeTransaction(txBytes);
    if (!r.ok) return { ok: false, code: r.code, mode: 'SIMULATED' };
    const t = r.tx; return { ok: true, code: 'OK', signer: t.signer, receiver: t.receiver, method: t.method, args: new TextDecoder().decode(t.args), nonce: t.nonce.toString(), gas: t.gas.toString(), pubkey_hex: Buffer.from(t.pubkey).toString('hex'), mode: 'SIMULATED' };
  }
  private async refusalReceipt(txHash: Uint8Array, code: number) {
    const counter = ++this.counter;
    const buf = new Uint8Array(15 + 32 + 1 + 4); buf.set(new TextEncoder().encode('FUSE_REFUSAL_V1'), 0); buf.set(txHash, 15); buf[47] = code;
    new DataView(buf.buffer).setUint32(48, counter, true);
    const sig = await ed.signAsync(sha256(buf), this.seed);
    this.refusals.push({ hash: txHash, code, counter }); if (this.refusals.length > 16) this.refusals.shift();
    this.save();
    return { receipt: Buffer.from(sig).toString('base64'), counter };
  }
  async sign(txBytes: Uint8Array, _hint: string): Promise<SignResult> {
    this.reload();
    const txHash = sha256(txBytes); const hash = bs58.encode(txHash);
    if (this.opts.unsafeSignAnything) {
      const sig = await ed.signAsync(txHash, this.seed);
      return { ok: true, hash, sig: Buffer.from(sig).toString('base64'), summary: 'COMPROMISED CHIP: signed without checks', button: false, compromised: true } as SignResult;
    }
    const now = Date.now(); this.signTimes = this.signTimes.filter(t => now - t < this.policy.velocity_window_ms);
    const dec = decodeTransaction(txBytes);
    let decision: { verdict: string; code: any; detail: string; summary: string };
    let decoded: any;
    if (!dec.ok) decision = { verdict: 'REFUSE', code: dec.code, detail: 'structural', summary: '' };
    else {
      decoded = { signer: dec.tx.signer, receiver: dec.tx.receiver, method: dec.tx.method, nonce: dec.tx.nonce.toString(), gas: dec.tx.gas.toString() };
      decision = evaluate(this.policy, dec.tx, { chipPub: this.pub, lastNonce: this.lastNonce, recentSigns: this.signTimes.length, refusals: this.refusals });
    }
    if (decision.verdict === 'SIGN_WITH_BUTTON') {
      const id = `s${++this.seq}`;
      this.emit('button_required', { id, summary: decision.summary, timeout_ms: 30000 });
      await new Promise(r => setTimeout(r, this.opts.buttonDelayMs));
      if (this.opts.button === 'deny') decision = { verdict: 'REFUSE', code: 'BUTTON_TIMEOUT', detail: 'SIMULATED button not pressed', summary: '' };
    }
    if (decision.verdict === 'REFUSE') {
      const { receipt, counter } = await this.refusalReceipt(txHash, codeNum(decision.code));
      return { ok: false, hash, code: decision.code, code_num: codeNum(decision.code), detail: decision.detail, receipt, counter, decoded };
    }
    const sig = await ed.signAsync(txHash, this.seed);
    this.lastNonce = dec.ok ? dec.tx.nonce : this.lastNonce; this.signTimes.push(now); this.save();
    return { ok: true, hash, sig: Buffer.from(sig).toString('base64'), summary: decision.summary, button: decision.verdict === 'SIGN_WITH_BUTTON', decoded };
  }
  async policyGet() { return { policy: this.policy, policy_hash: this.policyHash() }; }
  async policySet(policy: Policy) {
    if (!policy?.agent || !policy?.wallet || !Array.isArray(policy.methods)) return { ok: false, code: 'BAD_POLICY' as const, detail: 'agent, wallet, methods required' };
    await new Promise(r => setTimeout(r, this.opts.buttonDelayMs));
    if (this.opts.button === 'deny') return { ok: false, code: 'BUTTON_TIMEOUT' as const, detail: 'SIMULATED button not pressed' };
    this.policy = policy; fs.writeFileSync(this.policyFile, JSON.stringify(policy, null, 2)); return { ok: true, policy_hash: this.policyHash() };
  }
  async close() {}
}
