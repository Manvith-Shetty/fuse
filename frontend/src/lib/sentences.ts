// Turns the bridge log into plain-language sentences. Entries are paired by tx hash so a refusal knows its amount
// (from the `proposed` entry) and its onchain receipt (from the `executed record_refusal` entry).
import { codeName } from './codes';
import { formatAmount } from './format';
import type { LogEntry } from './types';

export type Tone = 'allow' | 'block' | 'warn' | 'neutral';
export interface Sentence { key: string; ts: string; text: string; tone: Tone; href?: string; mode: string }

interface PayArgs { receiver?: string; token?: string; amount?: string }
const payArgs = (e: LogEntry | undefined): PayArgs => (e?.args && typeof e.args === 'object' ? (e.args as PayArgs) : {});
const money = (a: PayArgs) => (a.amount ? formatAmount(a.amount, a.token ?? 'near') : undefined);

/** "pay 1000000000000000000000 near -> api.x.testnet" -> "0.001 NEAR to api.x.testnet" */
export function humanizeSummary(summary?: string): string | undefined {
  if (!summary) return undefined;
  const pay = /^pay (\d+) (\S+) -> (\S+)$/.exec(summary);
  if (pay) return `${formatAmount(pay[1], pay[2])} to ${pay[3]}`;
  const rr = /^record refusal #(\d+)$/.exec(summary);
  if (rr) return `refusal receipt #${rr[1]}`;
  const cs = /^chain_sig (\S+) (\d+) -> (\S+)$/.exec(summary);
  if (cs) return `a ${cs[1]} signature for ${cs[3]}`;
  return summary;
}

/**
 * Newest first. Shows what matters (payments executed, refusals with their receipts, the button, the cable) and folds the
 * bookkeeping entries (proposed, nonce_retry, record_refusal plumbing, signed-then-executed duplicates) into those sentences.
 */
export function sentences(log: LogEntry[], limit = 8): Sentence[] {
  const byHash = new Map<string, LogEntry[]>();
  for (const e of log) if (typeof e.hash === 'string') byHash.set(e.hash, [...(byHash.get(e.hash) ?? []), e]);
  const find = (hash: string | undefined, type: string, method?: string) => (hash ? byHash.get(hash)?.find(x => x.type === type && (!method || x.method === method)) : undefined);
  // refusal counter -> explorer link of the executed record_refusal
  const receiptLink = new Map<number, string>();
  for (const e of log) {
    if (e.type === 'proposed' && e.method === 'record_refusal' && e.args && typeof e.args === 'object') {
      const c = (e.args as { counter?: number }).counter;
      const ex = find(e.hash, 'executed', 'record_refusal');
      if (typeof c === 'number' && ex) receiptLink.set(c, typeof ex.explorer === 'string' ? ex.explorer : '');
    }
  }
  const out: Sentence[] = [];
  for (let i = log.length - 1; i >= 0 && out.length < limit; i--) {
    const e = log[i]!;
    const key = `${e.ts}|${e.type}|${e.hash ?? ''}`;
    const args = payArgs(find(e.hash, 'proposed'));
    const what = humanizeSummary(e.summary) ?? (money(args) && args.receiver ? `${money(args)} to ${args.receiver}` : undefined);
    switch (e.type) {
      case 'executed': {
        if (e.method === 'record_refusal') break; // folded into the refusal sentence
        const signed = find(e.hash, 'signed');
        const w = humanizeSummary(signed?.summary) ?? what ?? e.method ?? 'a transaction';
        out.push({ key, ts: e.ts, mode: String(signed?.mode ?? e.mode), tone: 'allow', href: typeof e.explorer === 'string' ? e.explorer : undefined, text: `Paid ${w}${signed?.button ? ' after your thumb' : ''}` });
        break;
      }
      case 'failed_onchain': {
        if (e.method === 'record_refusal') { out.push({ key, ts: e.ts, mode: String(e.mode), tone: 'warn', text: `Refusal receipt could not be recorded onchain${e.error ? `: ${String(e.error).slice(0, 80)}` : ''}` }); break; }
        out.push({ key, ts: e.ts, mode: String(e.mode), tone: 'warn', href: typeof e.explorer === 'string' ? e.explorer : undefined, text: `Chip signed ${what ?? e.method ?? 'it'} but the chain rejected it${e.error ? `: ${String(e.error).slice(0, 80)}` : ''}` });
        break;
      }
      case 'refused': {
        if (e.method === 'record_refusal') break; // plumbing
        const code = codeName(e.code);
        const counter = typeof e.counter === 'number' ? e.counter : undefined;
        const link = counter !== undefined ? receiptLink.get(counter) : undefined;
        const target = what ?? (e.detail ? String(e.detail) : e.method ?? 'the request');
        const receipt = counter !== undefined ? ` · receipt #${counter}${link !== undefined ? ' onchain' : ''}` : '';
        out.push({ key, ts: e.ts, mode: String(e.mode), tone: 'block', href: link || undefined, text: `Refused ${target} · ${code}${receipt}` });
        break;
      }
      case 'signed': {
        if (e.method === 'record_refusal') break;
        if (find(e.hash, 'executed') || find(e.hash, 'failed_onchain')) break; // the outcome sentence covers it
        out.push({ key, ts: e.ts, mode: String(e.mode), tone: 'allow', text: `Chip signed ${humanizeSummary(e.summary) ?? what ?? e.method ?? 'it'}${e.button ? ' after your thumb' : ''} · broadcasting` });
        break;
      }
      case 'button_required':
        out.push({ key, ts: e.ts, mode: String(e.mode), tone: 'warn', text: `Waiting for your thumb${what ? `: ${what}` : ''}${e.timeout_ms ? ` · ${Math.round(e.timeout_ms / 1000)} s` : ''}` });
        break;
      case 'AGENT_REVOKED':
        out.push({ key, ts: e.ts, mode: String(e.mode), tone: 'block', text: 'Chip unplugged · agent revoked, nothing can be signed' });
        break;
      case 'chip_connected':
        out.push({ key, ts: e.ts, mode: String(e.mode), tone: 'neutral', text: `Chip connected${e.mode === 'SIMULATED' ? ' (simulated)' : ''}` });
        break;
      default:
        break;
    }
  }
  return out;
}
