// Fuse demo seller: a pay-per-call API. The agent pays through the chip, then presents the NEAR transaction hash.
// This service verifies, from the chain alone, that the wallet contract executed `pay` to this seller for at least the
// catalog price in that transaction, that the transfer succeeded, and that the hash has not been used before. Then it
// serves the data. No account, no API key, no trust in the agent or the bridge: the receipt is the payment.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const RPC = process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com';
const SELLER = process.env.SELLER_ACCOUNT ?? 'api.fuse-hack-2026.testnet';
const WALLET = process.env.WALLET_CONTRACT ?? '';            // if set, only pay events emitted by this contract count
const PORT = Number(process.env.SELLER_PORT ?? 7779);
const catalog = JSON.parse(fs.readFileSync(path.resolve(here, '../../agent/fixtures/catalog.json'), 'utf8'));
const usedFile = path.resolve(here, '../data/used.json'); fs.mkdirSync(path.dirname(usedFile), { recursive: true });
const used = new Set<string>(fs.existsSync(usedFile) ? JSON.parse(fs.readFileSync(usedFile, 'utf8')) : []);
const saveUsed = () => fs.writeFileSync(usedFile, JSON.stringify([...used]));

async function rpc(method: string, params: unknown) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j: any = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result;
}

type Verified = { ok: true; payer: string; amount: string; memo: string | null; contract: string } | { ok: false; reason: string };
// Reads the transaction's receipts and looks for the wallet contract's `EVENT_JSON` pay event to this seller.
export async function verifyPayment(txHash: string, sender: string, minAmount: bigint): Promise<Verified> {
  let tx: any;
  try { tx = await rpc('tx', { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' }); } catch (e: any) { return { ok: false, reason: `tx lookup failed: ${e.message}` }; }
  const st = tx?.status; if (!st || !('SuccessValue' in st)) return { ok: false, reason: 'transaction did not succeed' };
  let payEvent: any = null, contract = '', resultOk = false;
  for (const ro of tx.receipts_outcome ?? []) {
    const exec = ro.outcome?.executor_id ?? '';
    for (const line of ro.outcome?.logs ?? []) {
      if (!line.startsWith('EVENT_JSON:')) continue;
      let ev: any; try { ev = JSON.parse(line.slice('EVENT_JSON:'.length)); } catch { continue; }
      if (ev.standard !== 'fuse') continue;
      if (ev.event === 'pay' && ev.data?.[0]?.receiver === SELLER) { payEvent = ev.data[0]; contract = exec; }
      if (ev.event === 'pay_result' && ev.data?.[0]?.ok === true) resultOk = true;
    }
  }
  if (!payEvent) return { ok: false, reason: `no fuse pay event to ${SELLER} in this transaction` };
  if (WALLET && contract !== WALLET) return { ok: false, reason: `pay event emitted by ${contract}, expected ${WALLET}` };
  if (!resultOk) return { ok: false, reason: 'transfer not confirmed (pay_result ok=true missing)' };
  if (BigInt(String(payEvent.amount)) < minAmount) return { ok: false, reason: `paid ${payEvent.amount} < price ${minAmount}` };
  return { ok: true, payer: tx.transaction?.signer_id, amount: String(payEvent.amount), memo: payEvent.memo ?? null, contract };
}

// Demo data: deterministic, clearly labelled. A real seller would put its product here.
function product(id: string, q: URLSearchParams) {
  const city = q.get('city') ?? 'Bengaluru'; const day = new Date().toISOString().slice(0, 10);
  const seed = [...(id + city + day)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  if (id === 'weather') return { city, date: day, temp_c: 18 + (seed % 15), humidity: 40 + (seed % 50), sky: ['clear', 'cloudy', 'rain', 'haze'][seed % 4], note: 'DEMO DATA, generated deterministically; the payment check above is real' };
  if (id === 'fx') return { base: 'USD', quote: 'INR', rate: (83 + (seed % 300) / 100).toFixed(2), date: day, note: 'DEMO DATA' };
  if (id === 'summarize') return { summary: 'DEMO DATA: one-paragraph summary would go here.', words: 42 };
  if (id === 'bulk-export') return { rows: 1000, url: 'DEMO DATA: signed download link would go here' };
  return { error: 'unknown service' };
}
const json = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/') return json(res, 200, { seller: SELLER, services: catalog.services.map((s: any) => ({ id: s.id, price: s.price, token: s.token, url: `/service/${s.id}?tx=<near tx hash>&payer=<agent account>` })), how: 'pay through Fuse, then call the service with the transaction hash; one payment = one call' });
  const m = url.pathname.match(/^\/service\/([a-z-]+)$/);
  if (!m) return json(res, 404, { error: 'not found' });
  const svc = catalog.services.find((s: any) => s.id === m[1]); if (!svc) return json(res, 404, { error: 'unknown service' });
  const tx = url.searchParams.get('tx') ?? '', payer = url.searchParams.get('payer') ?? '';
  if (!tx || !payer) return json(res, 402, { error: 'payment required', pay: { receiver: SELLER, token: svc.token, amount: svc.price }, then: `GET ${url.pathname}?tx=<hash>&payer=<account>` });
  if (used.has(tx)) return json(res, 409, { error: 'this payment was already redeemed' });
  const v = await verifyPayment(tx, payer, BigInt(svc.price));
  if (!v.ok) return json(res, 402, { error: 'payment not verified', reason: v.reason });
  used.add(tx); saveUsed();
  json(res, 200, { paid: { tx, payer: v.payer, amount: v.amount, memo: v.memo, contract: v.contract, explorer: `https://testnet.nearblocks.io/txns/${tx}` }, service: svc.id, data: product(svc.id, url.searchParams) });
}).listen(PORT, '127.0.0.1', () => console.error(`[fuse-seller] ${SELLER} on http://127.0.0.1:${PORT}  rpc=${RPC}${WALLET ? `  wallet=${WALLET}` : ''}`));
