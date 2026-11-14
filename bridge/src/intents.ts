// NEAR Intents (1Click API) dry quotes. Mainnet only (Q-007 in HACKATHON.md: no testnet exists), so this module never
// moves funds: it asks for a `dry: true` quote so a Fuse-guarded agent can price a cross-chain purchase. Executing a
// quote (deposit to the quote's address) would be a `pay` through the chip to an allowlisted deposit receiver, which
// is deliberately not wired here: mainnet spending needs the human's explicit yes.
// API shape per https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api [VERIFY on first use].
const BASE = process.env.ONECLICK_URL ?? 'https://1click.chaindefuser.com';

export interface QuoteRequest { originAsset: string; destinationAsset: string; amount: string; recipient: string; refundTo: string; slippageBps?: number; deadlineMinutes?: number }
export async function tokens(): Promise<any[]> {
  const r = await fetch(`${BASE}/v0/tokens`); if (!r.ok) throw new Error(`1click tokens: HTTP ${r.status}`); return r.json() as Promise<any[]>;
}
export async function dryQuote(q: QuoteRequest) {
  // Schema checked against docs.near-intents.org/api-reference/oneclick/request-a-swap-quote on 2026-11-13.
  const body = {
    dry: true, swapType: 'EXACT_INPUT', slippageTolerance: q.slippageBps ?? 100,
    originAsset: q.originAsset, depositType: 'ORIGIN_CHAIN', destinationAsset: q.destinationAsset, amount: q.amount,
    refundTo: q.refundTo, refundType: 'ORIGIN_CHAIN', recipient: q.recipient, recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(Date.now() + (q.deadlineMinutes ?? 10) * 60_000).toISOString(), depositMode: 'SIMPLE',
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.ONECLICK_API_KEY) headers['x-api-key'] = process.env.ONECLICK_API_KEY;   // partner key (recommended by 1Click)
  if (process.env.ONECLICK_JWT) headers.authorization = `Bearer ${process.env.ONECLICK_JWT}`; // optional; without it 1Click charges 0.2%
  let r: Response;
  try { r = await fetch(`${BASE}/v0/quote`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) }); }
  catch (e: any) { return { ok: false, error: `network: ${e?.cause?.message ?? e?.message ?? String(e)} (1Click at ${BASE} unreachable from here; nothing to do with the chip)`, request: body }; }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, http: r.status, error: j.message ?? j.error ?? JSON.stringify(j).slice(0, 300), request: body };
  return { ok: true, dry: true, request: body, quote: j.quote ?? j, note: 'dry quote only: no deposit address is funded, nothing moves' };
}
