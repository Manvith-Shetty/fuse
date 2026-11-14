// Fuse as a tool for other agent frameworks. No framework dependency: these are plain async functions with JSON-schema
// descriptions, which LangChain (`tool()`/`DynamicStructuredTool`), the OpenAI Agents SDK (`tool`) and Vercel AI (`tool`)
// all accept with a one-line wrapper. The agent proposes; the chip decides; refusals land onchain.
//
// LangChain example:
//   import { tool } from '@langchain/core/tools'; import { z } from 'zod'; import { fusePay, fuseCheck, FUSE_PAY_SCHEMA } from './tools/langchain.js';
//   const pay = tool(async (a) => JSON.stringify(await fusePay(a)), { name: 'fuse_pay', description: FUSE_PAY_SCHEMA.description, schema: z.object({ receiver: z.string(), token: z.string(), amount: z.string(), memo: z.string().optional() }) });
import { BridgeClient } from '../bridge.js';

const bridge = () => new BridgeClient(process.env.FUSE_BRIDGE_URL ?? 'http://127.0.0.1:7777');

export const FUSE_PAY_SCHEMA = {
  name: 'fuse_pay',
  description: 'Propose a payment from the agent\'s NEAR wallet. The agent holds no key: a hardware chip (Fuse) decodes the transaction, applies its policy and signs or refuses. Refusals are recorded onchain. Amounts above the threshold wait for a human button press.',
  parameters: { type: 'object', properties: { receiver: { type: 'string' }, token: { type: 'string' }, amount: { type: 'string', description: 'atomic units, decimal string' }, memo: { type: 'string' } }, required: ['receiver', 'token', 'amount'] },
} as const;
export const FUSE_CHECK_SCHEMA = {
  name: 'fuse_check_counterparty',
  description: 'Ask the shared Fuse refusal registry whether other chips have refused payments to this account: allow, warn or block with evidence counts.',
  parameters: { type: 'object', properties: { receiver: { type: 'string' } }, required: ['receiver'] },
} as const;

export async function fusePay(a: { receiver: string; token: string; amount: string; memo?: string }) {
  const r = await bridge().pay({ receiver: a.receiver, token: a.token, amount: String(a.amount), memo: a.memo });
  // Compact, model-friendly summary. The full result (explorer links, receipt) is kept for logs.
  if (r.http) return { outcome: 'ERROR', http: r.http, error: r.error ?? r.raw };
  if (r.ok) return { outcome: r.pending ? 'PENDING_APPROVAL' : 'PAID', tx: r.hash, explorer: r.explorer, button_pressed: !!r.button, counterparty: r.counterparty?.verdict };
  return { outcome: 'REFUSED', code: r.code, detail: r.detail, refusal_recorded: r.refusal?.recorded, refusal_tx: r.refusal?.hash, counterparty: r.counterparty?.verdict };
}
export async function fuseCheck(a: { receiver: string }) { return bridge().check(a.receiver); }
