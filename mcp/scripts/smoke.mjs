// Drives dist/index.js over stdio with raw JSON-RPC: initialize, tools/list, fuse_status, fuse_policy, fuse_budget.
// `node scripts/smoke.mjs --buy http://127.0.0.1:7779/service/weather?city=Bengaluru` also runs the pay-per-call loop
// (fuse_fetch): this moves real testnet money through the chip, so it is opt-in.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const buyIdx = process.argv.indexOf('--buy'); const buyUrl = buyIdx >= 0 ? process.argv[buyIdx + 1] : null;
const child = spawn('node', [path.join(here, '..', 'dist', 'index.js')], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
let buf = ''; const pending = new Map();
child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
let id = 0;
const call = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
console.log('initialize ->', init.result?.serverInfo, 'capabilities:', Object.keys(init.result?.capabilities ?? {}));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const tools = await call('tools/list', {});
console.log('tools/list ->', tools.result?.tools?.map((t) => t.name));
for (const name of ['fuse_status', 'fuse_budget', 'fuse_policy']) {
  const r = await call('tools/call', { name, arguments: {} });
  console.log(`\n=== tools/call ${name} (isError=${r.result?.isError ?? false})`);
  console.log(r.result?.content?.[0]?.text?.slice(0, 1800));
}
if (buyUrl) {
  const r = await call('tools/call', { name: 'fuse_fetch', arguments: { url: buyUrl } });
  console.log(`\n=== tools/call fuse_fetch ${buyUrl} (isError=${r.result?.isError ?? false})`);
  console.log(r.result?.content?.[0]?.text?.slice(0, 2500));
}
child.kill(); process.exit(0);
