#!/usr/bin/env node
// fuse-mcp: exposes the Fuse chip (through the local bridge) as wallet tools for Claude Code / Claude Desktop.
// The model never sees a key. The chip decides; the bridge relays; this server only speaks HTTP to the bridge.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BRIDGE = (process.env.FUSE_BRIDGE_URL ?? 'http://127.0.0.1:7777').replace(/\/$/, '');
const YOCTO = 10n ** 24n;

class BridgeError extends Error { constructor(msg: string, public status?: number) { super(msg); } }

async function bridge<T = any>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try { res = await fetch(BRIDGE + path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } }); }
  catch (e: any) { throw new BridgeError(`Fuse bridge is not reachable at ${BRIDGE} (${e?.cause?.code ?? e?.message}). Start it with: cd bridge && npm run fuse -- serve`); }
  const text = await res.text();
  let body: any; try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (res.status === 503 && typeof body?.error === 'string' && body.error.startsWith('AGENT_REVOKED')) {
    throw new BridgeError('AGENT_REVOKED: the Fuse chip is unplugged or unreachable. The agent has no key and cannot spend until the chip is reconnected.', 503);
  }
  if (!res.ok) throw new BridgeError(`bridge ${path} -> ${res.status}: ${body?.error ?? text}`, res.status);
  return body as T;
}

function nearToYocto(s: string): string {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(s.trim());
  if (!m) throw new Error(`amount_near must be a decimal NEAR amount, got "${s}"`);
  const whole = BigInt(m[1]); const frac = (m[2] ?? '').padEnd(24, '0');
  return (whole * YOCTO + BigInt(frac)).toString();
}
function yoctoToNear(y: string): string {
  const v = BigInt(y); const whole = v / YOCTO; const frac = (v % YOCTO).toString().padStart(24, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
const fmtAmount = (amount: string, token: string) => token === 'near' ? `${yoctoToNear(amount)} NEAR (${amount} yocto)` : `${amount} atomic units of ${token}`;

function policySummary(p: any): string {
  if (!p) return 'chip policy unavailable';
  const lines = [
    `agent account: ${p.agent}`, `wallet contract (only receiver the key can call): ${p.wallet}`,
    `methods: ${(p.methods ?? []).join(', ')}`,
    `payment receivers allowed: ${p.receivers?.length ? p.receivers.join(', ') : 'NONE (every payment will be refused until the owner allowlists one)'}`,
    `tokens allowed: ${(p.tokens ?? []).join(', ')}`,
    `per-transaction cap: ${p.per_tx_cap} atomic units${p.tokens?.includes('near') ? ` (${yoctoToNear(p.per_tx_cap)} NEAR if token is near)` : ''}`,
    `button threshold: amounts above ${p.button_threshold} need a physical button press on the chip (30 s timeout)`,
    `velocity: at most ${p.velocity_cap} signatures per ${Math.round((p.velocity_window_ms ?? 0) / 60000)} min`,
    `cross-chain destinations allowed: ${p.chain_dests?.length ? p.chain_dests.map((d: any) => `${d.chain}:${d.to}`).join(', ') : 'none'}`,
  ];
  return lines.join('\n');
}
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));
const toolError = (e: any) => ({ content: [{ type: 'text' as const, text: `ERROR: ${e?.message ?? String(e)}` }], isError: true });

const server = new McpServer({ name: 'fuse-mcp', version: '0.1.0' });

server.registerTool('fuse_status', {
  title: 'Fuse wallet status',
  description: 'Status of your Fuse wallet. You do not hold a key. A hardware chip (or its labelled simulator) holds the only key of your NEAR agent account and decides whether to sign each payment. Payments outside policy will be refused and the refusal is recorded onchain. Returns chip identity, HARDWARE/SIMULATED mode, heartbeat (whether the chip is plugged in), accounts with explorer links, and a plain-language summary of what you are allowed to pay.',
  inputSchema: {},
}, async () => {
  try {
    const s = await bridge('/status');
    const hb = s.heartbeat ?? {};
    const summary = [
      `mode: ${s.mode}${s.mode === 'SIMULATED' ? ' (software stand-in for the ESP32; same decoder and policy, labelled in every output)' : ''}`,
      `chip: ${s.chip?.pubkey ?? s.chip?.error} fw=${s.chip?.fw ?? '?'} board=${s.chip?.board ?? '?'} policy_hash=${s.chip?.policy_hash ?? '?'} refusals_issued=${s.chip?.counter ?? '?'}`,
      `heartbeat: ${hb.alive ? 'chip connected' : 'AGENT REVOKED: chip unreachable, nothing can be signed'}${hb.lastOk ? ` (last ok ${new Date(hb.lastOk).toISOString()})` : ''}`,
      `network: ${s.network}`,
      `agent account: ${s.accounts?.agent}  ${s.accounts?.agent_explorer}`,
      `wallet contract: ${s.accounts?.wallet}  ${s.accounts?.wallet_explorer}`,
      '', 'POLICY (enforced by the chip, then again by the contract):', policySummary(s.policy),
    ].join('\n');
    return text(summary);
  } catch (e) { return toolError(e); }
});

server.registerTool('fuse_pay', {
  title: 'Pay through the Fuse chip',
  description: 'Propose a payment from the agent wallet. The bridge builds the NEAR transaction, the Fuse chip decodes the raw bytes, checks its policy (receiver and token allowlists, per-tx cap, velocity, nonce) and signs only if everything passes; amounts above the button threshold wait up to 30 s for a physical button press. If refused, nothing is signed and the chip issues a signed refusal receipt that is recorded onchain. Give either amount (atomic units, yocto for NEAR) or amount_near (decimal NEAR).',
  inputSchema: {
    receiver: z.string().describe('NEAR account to pay, e.g. api.example.testnet'),
    amount: z.string().regex(/^\d+$/).optional().describe('amount in atomic units (yoctoNEAR for token "near"); omit if amount_near is given'),
    amount_near: z.string().optional().describe('amount in decimal NEAR, e.g. "0.1"; converted to yocto when amount is omitted'),
    token: z.string().default('near').describe('"near" for native NEAR, else a NEP-141 token contract id'),
    memo: z.string().max(200).optional().describe('free-text memo recorded onchain'),
  },
}, async ({ receiver, amount, amount_near, token, memo }) => {
  try {
    let amt = amount;
    if (!amt) { if (!amount_near) throw new Error('give amount (atomic units) or amount_near (decimal NEAR)'); if (token !== 'near') throw new Error('amount_near only applies to token "near"'); amt = nearToYocto(amount_near); }
    const r = await bridge('/pay', { method: 'POST', body: JSON.stringify({ receiver, token, amount: amt, memo }) });
    if (r.ok) {
      return text([`PAID [${r.mode}] ${fmtAmount(amt!, token)} -> ${receiver}`, r.button ? 'The chip required and received a button press.' : 'Signed without a button press (below threshold).', `tx: ${r.hash}`, `explorer: ${r.explorer}`].join('\n'));
    }
    const lines = [`REFUSED [${r.mode}] ${fmtAmount(amt!, token)} -> ${receiver}`, `code: ${r.code}`, `detail: ${r.detail ?? ''}`, `proposed tx hash (never signed): ${r.hash}`];
    if (r.refusal) lines.push(r.refusal.recorded ? `refusal receipt #${r.refusal.counter} recorded onchain: ${r.refusal.explorer}` : `refusal receipt #${r.refusal.counter} issued but not recorded: ${r.refusal.error ?? ''}`);
    if (r.error) lines.push(`onchain error: ${r.error}`);
    lines.push('Do not retry with a different receiver or split the amount to evade policy; the chip and the contract both count and refuse that. Ask the owner to change the policy instead.');
    return { ...text(lines.join('\n')), isError: false };
  } catch (e) { return toolError(e); }
});

server.registerTool('fuse_policy', {
  title: 'Fuse policy (chip and contract)',
  description: 'The chip policy and the onchain wallet-contract policy side by side, plus the agent account access keys as seen onchain (expect exactly one function-call key: the chip).',
  inputSchema: {},
}, async () => {
  try {
    const [s, oc] = await Promise.all([bridge('/status'), bridge('/onchain')]);
    return json({ mode: s.mode, chip_policy: s.policy ?? null, chip_policy_summary: policySummary(s.policy), contract_policy: oc.policy, contract_state: oc.state, daily_spent: oc.daily_spent, agent_access_keys: oc.agent_keys });
  } catch (e) { return toolError(e); }
});

server.registerTool('fuse_refusals', {
  title: 'Recent refusals',
  description: 'Refusals the chip issued: the onchain records (verified ed25519 receipts in the wallet contract) and the bridge log entries.',
  inputSchema: { limit: z.number().int().min(1).max(200).default(20) },
}, async ({ limit }) => {
  try {
    const [oc, log] = await Promise.all([bridge('/onchain'), bridge<any[]>(`/log?limit=500`)]);
    const onchain = Array.isArray(oc.refusals) ? oc.refusals.slice(-limit) : oc.refusals;
    const fromLog = log.filter((e) => e.type === 'refused').slice(-limit);
    return json({ onchain_refusals: onchain, bridge_log_refusals: fromLog, counts: oc.counts });
  } catch (e) { return toolError(e); }
});

server.registerTool('fuse_log', {
  title: 'Bridge event log',
  description: 'Last N bridge events: proposed, signed, refused, executed, button_required, chip_connected, AGENT_REVOKED.',
  inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
}, async ({ limit }) => {
  try { return json(await bridge(`/log?limit=${limit}`)); } catch (e) { return toolError(e); }
});

server.registerResource('status', 'fuse://status', { title: 'Fuse status', description: 'Live bridge /status JSON', mimeType: 'application/json' }, async (uri) => {
  const s = await bridge('/status');
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(s, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
