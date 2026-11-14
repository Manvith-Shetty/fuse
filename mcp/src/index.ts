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

// ---- protocol v2 tools: counterparty check, quorum approvals, audit export ----
server.registerTool('fuse_check_counterparty', {
  title: 'Check a receiver against the shared refusal registry',
  description: 'Before paying an account you have not paid before, ask the shared Fuse refusal registry about it. Other Fuse chips post signed refusal receipts there; the answer is allow, warn or block with evidence counts (distinct chips and reporters that refused payments to this account). Advisory: the chip still decides.',
  inputSchema: { receiver: z.string().describe('NEAR account id to check') },
}, async ({ receiver }) => {
  try {
    const r = await bridge(`/check?receiver=${encodeURIComponent(receiver)}`);
    const lines = [`${receiver}: ${String(r.verdict ?? 'allow').toUpperCase()}`];
    if (r.registry) lines.push(`registry: ${r.registry}`); else lines.push('no registry configured on this bridge (REGISTRY_CONTRACT); verdict defaults to allow');
    if (r.reports !== undefined) lines.push(`reports: ${r.reports} (bound ${r.bound_reports ?? 0}, trusted ${r.trusted_reports ?? 0}), distinct chips: ${r.distinct_chips ?? 0}, distinct reporters: ${r.distinct_reporters ?? 0}`);
    if (r.manual) lines.push(`curated block entry: ${r.manual}`);
    if (r.top_codes?.length) lines.push(`top refusal codes: ${r.top_codes.map((c: any) => `${c[0]}x${c[1]}`).join(', ')}`);
    if (r.error) lines.push(`registry error: ${r.error}`);
    return text(lines.join('\n'));
  } catch (e) { return toolError(e); }
});

server.registerTool('fuse_pending', {
  title: 'Payments waiting for a second chip',
  description: 'Payments above the wallet contract quorum threshold are stored as pending until a second Fuse chip (an approver account) approves them. Lists them.',
  inputSchema: {},
}, async () => {
  try { const oc = await bridge('/onchain'); return json({ pending: oc.pending ?? [], config: oc.config ?? null }); } catch (e) { return toolError(e); }
});

server.registerTool('fuse_approve', {
  title: 'Approve a pending payment (approver chip only)',
  description: 'Only meaningful when this bridge\'s chip is enrolled as an approver account. Asks the chip to sign approve_payment for a pending payment id; the chip requires its own button press. The money moves only after this.',
  inputSchema: { id: z.number().int().min(0).describe('pending payment id from fuse_pending') },
}, async ({ id }) => {
  try {
    const r = await bridge('/approve', { method: 'POST', body: JSON.stringify({ id }) });
    return r.ok ? text(`APPROVED [${r.mode}] payment #${id}${r.button ? ' (button pressed)' : ''}\ntx: ${r.hash}\nexplorer: ${r.explorer}`) : text(`NOT APPROVED [${r.mode}] payment #${id}: ${r.code ?? ''} ${r.detail ?? r.error ?? ''}`);
  } catch (e) { return toolError(e); }
});

server.registerTool('fuse_audit', {
  title: 'Audit export',
  description: 'The verifiable spending history: every payment, every refusal receipt re-verified against the chip key, chain signature requests, pending approvals, contract config, firmware and policy hashes seen. JSON by default, or Markdown.',
  inputSchema: { format: z.enum(['json', 'markdown']).default('markdown') },
}, async ({ format }) => {
  try {
    if (format === 'markdown') { const res = await fetch(`${BRIDGE}/audit?format=md`); return text(await res.text()); }
    return json(await bridge('/audit'));
  } catch (e) { return toolError(e); }
});

// ---- the product loop: budget, and pay-per-call fetch (HTTP 402) ----
server.registerTool('fuse_budget', {
  title: 'What you may spend',
  description: 'Your budget in plain terms: which vendors you may pay, the per-call cap, the amount that needs a human thumb on the chip, how much of today\'s daily budget is left, and whether the chip is connected. Call this before buying anything.',
  inputSchema: {},
}, async () => {
  try {
    const [s, oc] = await Promise.all([bridge('/status'), bridge('/onchain')]);
    const p = s.policy ?? {}; const cp = oc.policy ?? {};
    const spent = typeof oc.daily_spent === 'string' ? BigInt(oc.daily_spent) : 0n; const cap = cp.daily_cap ? BigInt(cp.daily_cap) : 0n;
    const left = cap > spent ? cap - spent : 0n;
    const lines = [
      `chip: ${s.heartbeat?.alive ? 'connected' : 'UNPLUGGED: nothing can be paid'} (${s.mode})`,
      `vendors you may pay: ${p.receivers?.length ? p.receivers.join(', ') : 'none'}`,
      `tokens: ${(p.tokens ?? []).join(', ')}`,
      `per call: up to ${yoctoToNear(p.per_tx_cap ?? '0')} NEAR; above ${yoctoToNear(p.button_threshold ?? '0')} NEAR the human must press the button on the chip within 30 s`,
      cap ? `today: ${yoctoToNear(spent.toString())} NEAR spent of ${yoctoToNear(cap.toString())} NEAR; ${yoctoToNear(left.toString())} NEAR left` : 'daily cap: not available',
      oc.config?.quorum_threshold && oc.config.quorum_threshold !== '0' ? `above ${yoctoToNear(oc.config.quorum_threshold)} NEAR a second chip must approve (approvers: ${(oc.config.approvers ?? []).join(', ') || 'none set'})` : '',
      'Anything outside this is refused by the chip and the refusal is recorded onchain. Do not try to work around it.',
    ].filter(Boolean);
    return text(lines.join('\n'));
  } catch (e) { return toolError(e); }
});

// A paid API answers 402 with {"pay": {"receiver","token","amount"}}; the agent pays through the chip and retries with the receipt.
// This is the whole agent-commerce loop in one tool: discover the price, check the counterparty, let the chip decide, redeem.
server.registerTool('fuse_fetch', {
  title: 'Fetch a pay-per-call API, paying through the chip if asked',
  description: 'GET a URL. If the server answers 402 Payment Required with a JSON body {"pay": {"receiver": "<near account>", "token": "near", "amount": "<yocto>"}}, this tool checks the counterparty in the shared refusal registry, proposes the payment to the Fuse chip (the chip decides, within your budget), then retries the request with ?tx=<hash>&payer=<agent account> so the seller can verify the payment onchain and serve the data. Returns the final response body. Never pays more than the 402 asks, never pays a receiver the chip policy does not allow.',
  inputSchema: { url: z.string().url().describe('http(s) URL of the API call, e.g. http://127.0.0.1:7779/service/weather?city=Bengaluru'), max_amount: z.string().regex(/^\d+$/).optional().describe('optional ceiling in atomic units; refuse to pay above it even if the chip would allow') },
}, async ({ url, max_amount }) => {
  try {
    const first = await fetch(url); const firstText = await first.text();
    if (first.status !== 402) return text(`HTTP ${first.status} (no payment required)\n${firstText.slice(0, 4000)}`);
    let quote: any; try { quote = JSON.parse(firstText); } catch { return text(`402 without a JSON price: ${firstText.slice(0, 500)}`); }
    const pay = quote.pay; if (!pay?.receiver || !pay?.amount) return text(`402 but no usable "pay" field: ${firstText.slice(0, 500)}`);
    if (max_amount && BigInt(pay.amount) > BigInt(max_amount)) return text(`NOT PAID: the API asks ${fmtAmount(pay.amount, pay.token ?? 'near')}, above your max_amount ${max_amount}.`);
    const check = await bridge(`/check?receiver=${encodeURIComponent(pay.receiver)}`).catch(() => ({ verdict: 'allow' }));
    if (check.verdict === 'block') return text(`NOT PAID: the shared refusal registry says BLOCK for ${pay.receiver} (${check.reports ?? 0} reports from ${check.distinct_chips ?? 0} chips). Ask the owner before paying this vendor.`);
    const status = await bridge('/status');
    const r = await bridge('/pay', { method: 'POST', body: JSON.stringify({ receiver: pay.receiver, token: pay.token ?? 'near', amount: String(pay.amount), memo: `fuse_fetch ${new URL(url).pathname}`.slice(0, 120) }) });
    if (!r.ok) {
      const why = [`REFUSED by the chip [${r.mode}]: ${r.code ?? ''} ${r.detail ?? r.error ?? ''}`.trim()];
      if (r.refusal?.recorded) why.push(`refusal receipt #${r.refusal.counter} recorded onchain: ${r.refusal.explorer}`);
      if (check.verdict === 'warn') why.push(`(registry had WARN for ${pay.receiver})`);
      return text(why.join('\n'));
    }
    const u = new URL(url); u.searchParams.set('tx', r.hash); u.searchParams.set('payer', status.accounts?.agent ?? '');
    const second = await fetch(u.toString()); const body = await second.text();
    return text([`PAID ${fmtAmount(String(pay.amount), pay.token ?? 'near')} -> ${pay.receiver} [${r.mode}]${r.button ? ' (button pressed)' : ''}`, `tx: ${r.hash}  ${r.explorer}`, `counterparty: ${check.verdict ?? 'allow'}`, `seller answered HTTP ${second.status}:`, body.slice(0, 4000)].join('\n'));
  } catch (e) { return toolError(e); }
});

server.registerResource('status', 'fuse://status', { title: 'Fuse status', description: 'Live bridge /status JSON', mimeType: 'application/json' }, async (uri) => {
  const s = await bridge('/status');
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(s, null, 2) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
