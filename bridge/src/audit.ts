// Audit export: everything an auditor needs to re-verify an agent's spending history from public data.
// Every refusal receipt is re-verified here against the chip key the contract stores; nothing is taken on trust.
import fs from 'node:fs';
import path from 'node:path';
import * as ed from '@noble/ed25519';
import bs58 from 'bs58';
import type { Fuse } from './fuse.js';
import { refusalDigestV1, refusalDigestV2 } from './policy.js';
import { codeName } from './codes.js';
import { explorerAccount } from './config.js';

export interface Audit {
  generated_at: string; network: string; wallet: string; agent: string; registry: string | null;
  state: any; policy: any; config: any; counts: any; daily_spent: any; agent_keys: any;
  payments: any[]; pending: any[]; refusals: Array<any & { code_name: string; receipt_verified: boolean | null; digest_version: 1 | 2 }>; chain_sigs: any[];
  local: { log_entries: number; refusals_logged: number; signed_logged: number; button_presses: number; firmware_hashes_seen: string[]; policy_hashes_seen: string[]; first_entry?: string; last_entry?: string };
  summary: { payments_ok: number; payments_failed: number; refusals: number; receipts_verified: number; receipts_failed: number; chain_sigs_ok: number };
}

// v1 views page with `from_index`; the v2 `get_pending` view pages with `from`.
async function pageAll(fuse: Fuse, method: string, pageSize = 50, fromKey: 'from_index' | 'from' = 'from_index'): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += pageSize) {
    let page: any[]; try { page = await fuse.near.view(fuse.cfg.WALLET_CONTRACT, method, { [fromKey]: from, limit: pageSize }); } catch { break; }
    if (!Array.isArray(page) || page.length === 0) break; out.push(...page); if (page.length < pageSize) break;
  }
  return out;
}

// `extraKeys`: previous chip keys (base58, optional ed25519: prefix). The contract stores only the current key, so receipts
// issued before a `set_chip_key` rotation verify only against the key that issued them; the report says which key matched.
export async function buildAudit(fuse: Fuse, logFile?: string, extraKeys: string[] = []): Promise<Audit> {
  const w = fuse.cfg.WALLET_CONTRACT;
  const v = (m: string, a: Record<string, unknown> = {}) => fuse.near.view(w, m, a).catch((e: any) => ({ error: e.message }));
  const [state, policy, config, counts, daily_spent, agent_keys] = await Promise.all([v('get_state'), v('get_policy'), v('get_config'), v('get_counts'), v('get_daily_spent'), fuse.near.accessKeys(fuse.cfg.AGENT_ACCOUNT).catch((e: any) => ({ error: e.message }))]);
  const [payments, refusalsRaw, pending] = await Promise.all([pageAll(fuse, 'get_payments'), pageAll(fuse, 'get_refusals'), pageAll(fuse, 'get_pending', 50, 'from')]);
  const chain_sigs: any[] = [];
  for (let id = 0; id < Number(counts?.chain_sigs ?? 0) && id < 200; id++) { try { const r = await fuse.near.view(w, 'get_chain_sig_result', { id }); if (r) chain_sigs.push(r); } catch { break; } }

  const keys: Array<{ label: string; pk: Uint8Array }> = [];
  if (state?.chip_pubkey_hex) keys.push({ label: 'current chip key', pk: new Uint8Array(Buffer.from(state.chip_pubkey_hex, 'hex')) });
  for (const k of extraKeys) { try { const pk = bs58.decode(k.replace(/^ed25519:/, '')); if (pk.length === 32) keys.push({ label: `previous key ${k.slice(0, 16)}…`, pk }); } catch { /* skip bad key */ } }
  const refusals = [];
  for (const r of refusalsRaw) {
    let verified: boolean | null = null; let verifiedWith: string | undefined; const version: 1 | 2 = r.version === 2 || r.receiver ? 2 : 1;
    if (keys.length && r.tx_hash_hex && r.receipt_sig_b64) {
      try {
        const h = new Uint8Array(Buffer.from(r.tx_hash_hex, 'hex')); const sig = new Uint8Array(Buffer.from(r.receipt_sig_b64, 'base64'));
        const digest = version === 2 ? refusalDigestV2(h, r.code, r.counter, r.receiver ?? '') : refusalDigestV1(h, r.code, r.counter);
        verified = false;
        for (const k of keys) { if (await ed.verifyAsync(sig, digest, k.pk).catch(() => false)) { verified = true; verifiedWith = k.label; break; } }
      } catch { verified = false; }
    }
    refusals.push({ ...r, code_name: codeName(r.code), tx_hash_b58: r.tx_hash_hex ? bs58.encode(Buffer.from(r.tx_hash_hex, 'hex')) : undefined, receipt_verified: verified, verified_with: verifiedWith, digest_version: version });
  }

  const local: Audit['local'] = { log_entries: 0, refusals_logged: 0, signed_logged: 0, button_presses: 0, firmware_hashes_seen: [], policy_hashes_seen: [] };
  const file = logFile ?? path.join(fuse.cfg.DATA_DIR, 'log.jsonl');
  if (fs.existsSync(file)) {
    const fw = new Set<string>(), ph = new Set<string>();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue; let e: any; try { e = JSON.parse(line); } catch { continue; }
      local.log_entries++; local.first_entry ??= e.ts; local.last_entry = e.ts;
      if (e.type === 'refused') local.refusals_logged++; if (e.type === 'signed') { local.signed_logged++; if (e.button) local.button_presses++; }
      if (e.fw_sha256) fw.add(e.fw_sha256); if (e.policy_hash) ph.add(e.policy_hash);
    }
    local.firmware_hashes_seen = [...fw]; local.policy_hashes_seen = [...ph];
  }
  const summary = {
    payments_ok: payments.filter(p => p.status === 'ok').length, payments_failed: payments.filter(p => p.status === 'failed').length,
    refusals: refusals.length, receipts_verified: refusals.filter(r => r.receipt_verified === true).length, receipts_failed: refusals.filter(r => r.receipt_verified === false).length,
    chain_sigs_ok: chain_sigs.filter(c => c.status === 'ok').length,
  };
  return { generated_at: new Date().toISOString(), network: fuse.cfg.NEAR_NETWORK, wallet: w, agent: fuse.cfg.AGENT_ACCOUNT, registry: fuse.cfg.REGISTRY_CONTRACT || null, state, policy, config, counts, daily_spent, agent_keys, payments, pending, refusals, chain_sigs, local, summary };
}

const fmtNear = (atomic: string | number, token?: string) => { if (token && token !== 'near') return `${atomic} ${token}`; try { const v = BigInt(String(atomic)); return `${v / 10n ** 24n}.${(v % 10n ** 24n).toString().padStart(24, '0').slice(0, 4)} NEAR`; } catch { return String(atomic); } };
const ts = (ns?: string) => ns ? new Date(Number(BigInt(ns) / 1000000n)).toISOString() : '';

export function auditMarkdown(a: Audit): string {
  const ex = (h: string) => a.network === 'mainnet' ? `https://nearblocks.io/txns/${h}` : `https://testnet.nearblocks.io/txns/${h}`;
  const L: string[] = [];
  L.push(`# Fuse audit: ${a.agent}`, '', `Generated ${a.generated_at}. Network ${a.network}. Wallet contract \`${a.wallet}\` (${explorerAccount(a as any, a.wallet)}).`, '');
  L.push('## Summary', '', '| Metric | Value |', '| --- | --- |');
  for (const [k, val] of Object.entries(a.summary)) L.push(`| ${k.replace(/_/g, ' ')} | ${val} |`);
  L.push(`| chip key | \`${a.state?.chip_pubkey_b58 ?? 'n/a'}\` |`, `| agent keys onchain | ${Array.isArray(a.agent_keys) ? a.agent_keys.length : 'n/a'} |`, `| firmware hashes seen locally | ${a.local.firmware_hashes_seen.join(', ') || 'none logged'} |`, `| policy hashes seen locally | ${a.local.policy_hashes_seen.join(', ') || 'none logged'} |`, '');
  L.push('## Payments', '', '| # | time (UTC) | receiver | amount | memo | status |', '| --- | --- | --- | --- | --- | --- |');
  for (const p of a.payments) L.push(`| ${p.id} | ${ts(p.timestamp_ns)} | \`${p.receiver}\` | ${fmtNear(p.amount, p.token)} | ${p.memo ?? ''} | ${p.status} |`);
  if (a.pending.length) { L.push('', '## Pending (quorum)', '', '| # | receiver | amount | memo |', '| --- | --- | --- | --- |'); for (const p of a.pending) L.push(`| ${p.id} | \`${p.receiver}\` | ${fmtNear(p.amount, p.token)} | ${p.memo ?? ''} |`); }
  L.push('', '## Refusal receipts (re-verified against the chip key)', '', '| # | time (UTC) | code | receiver | digest | verified |', '| --- | --- | --- | --- | --- | --- |');
  for (const r of a.refusals) L.push(`| ${r.counter} | ${ts(r.timestamp_ns)} | ${r.code_name} | ${r.receiver ? `\`${r.receiver}\`` : '(v1, unbound)'} | v${r.digest_version} | ${r.receipt_verified === null ? 'n/a' : r.receipt_verified ? `yes (${r.verified_with})` : '**NO** (not signed by any known chip key: a receipt from before a key rotation needs that key via --also-key, anything else is a forgery the contract would have rejected)'} |`);
  if (a.chain_sigs.length) { L.push('', '## Chain Signatures', '', '| # | chain | to | value | status |', '| --- | --- | --- | --- | --- |'); for (const c of a.chain_sigs) L.push(`| ${c.id} | ${c.chain} | \`${c.to}\` | ${c.value} | ${c.status} |`); }
  L.push('', '## How to re-verify', '', `Every row above is a contract view on \`${a.wallet}\`; receipts verify as ed25519 over the digest in docs/protocol.md with the chip key in \`get_state\`. Explorer: ${ex('<tx>')}.`, '');
  return L.join('\n');
}
