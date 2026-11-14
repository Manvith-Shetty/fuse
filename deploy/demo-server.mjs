#!/usr/bin/env node
// One process for a hosted, simulator-only demo of Fuse: it starts the bridge (SIMULATE_CHIP=1), the pay-per-call
// seller and the red-team agent on localhost, then listens on $PORT and serves the built frontend in front of them.
// The same paths the Vite dev proxy uses (/api/bridge, /api/agent) are forwarded, so the frontend needs no changes.
// Anything that would reconfigure the hosted bridge (config, policy, approvals, chain signatures) answers 403: a
// judge can pay, attack and read, not re-point the deployment. The real chip never runs here; every screen says so.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8080);
const BRIDGE_PORT = Number(process.env.FUSE_DEMO_BRIDGE_PORT ?? 7777);
const AGENT_PORT = Number(process.env.FUSE_DEMO_AGENT_PORT ?? 7778);
const SELLER_PORT = Number(process.env.FUSE_DEMO_SELLER_PORT ?? 7779);
const DATA_DIR = process.env.DATA_DIR || path.join(root, 'bridge', 'data-demo');
const DIST = path.join(root, 'frontend', 'dist');

// The simulator deployment on testnet (docs/v2-deploy.md). Override through env for another deployment.
const acct = {
  NEAR_NETWORK: process.env.NEAR_NETWORK ?? 'testnet',
  NEAR_RPC_URL: process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com',
  OWNER_ACCOUNT: process.env.OWNER_ACCOUNT ?? 'fuse-sim-5607.testnet',
  WALLET_CONTRACT: process.env.WALLET_CONTRACT ?? 'fuse.fuse-sim-5607.testnet',
  AGENT_ACCOUNT: process.env.AGENT_ACCOUNT ?? 'agent.fuse-sim-5607.testnet',
  REGISTRY_CONTRACT: process.env.REGISTRY_CONTRACT ?? 'registry.fuse-v2-sdgt.testnet',
  SELLER_ACCOUNT: process.env.SELLER_ACCOUNT ?? 'api.fuse-sim-5607.testnet',
};

// Seed the simulator's files from env so a fresh container has the same software chip every boot. The chip state
// carries the simulated chip's key (a function-call key scoped to the wallet contract on testnet), so it is an env
// secret, not a file in the repository. The policy is public and has a committed default.
fs.mkdirSync(DATA_DIR, { recursive: true });
const seed = (envName, file, fallback) => {
  const target = path.join(DATA_DIR, file);
  let raw = process.env[envName];
  if (raw && !raw.trim().startsWith('{')) { try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch {} }
  if (raw) { JSON.parse(raw); fs.writeFileSync(target, raw); return 'env'; }
  if (fs.existsSync(target)) return 'existing';
  if (fallback && fs.existsSync(fallback)) { fs.copyFileSync(fallback, target); return 'default'; }
  return 'missing';
};
const chipSeed = seed('SIM_CHIP_STATE_JSON', 'sim-chip-state.json');
const policySeed = seed('SIM_POLICY_JSON', 'sim-policy.json', path.join(root, 'deploy', 'sim-policy.json'));
console.error(`[demo] data dir ${DATA_DIR}  chip state: ${chipSeed}  policy: ${policySeed}`);
if (chipSeed === 'missing') console.error('[demo] WARNING: no SIM_CHIP_STATE_JSON; the simulator will mint a fresh key that is not enrolled on the wallet, so payments will fail onchain');

// Child services. tsx is a devDependency of each package, so the build step installs it; run it through node so this
// works on Linux hosts and on Windows alike.
const tsx = (pkg) => path.join(root, pkg, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const children = [];
const run = (name, pkg, args, env) => {
  const start = () => {
    const child = spawn(process.execPath, [tsx(pkg), ...args], { cwd: path.join(root, pkg), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const tag = (line) => line.split('\n').filter(Boolean).forEach((l) => console.error(`[${name}] ${l}`));
    child.stdout.on('data', (d) => tag(String(d))); child.stderr.on('data', (d) => tag(String(d)));
    child.on('exit', (code) => { console.error(`[${name}] exited ${code}; restarting in 3 s`); setTimeout(start, 3000); });
    children.push(child);
  };
  start();
};
run('bridge', 'bridge', ['src/cli.ts', 'serve', '--port', String(BRIDGE_PORT)], {
  ...acct, SIMULATE_CHIP: '1', SERIAL_PORT: '', BRIDGE_PORT: String(BRIDGE_PORT), DATA_DIR,
  SIM_BUTTON: process.env.SIM_BUTTON ?? 'press', SIM_BUTTON_DELAY_MS: process.env.SIM_BUTTON_DELAY_MS ?? '1500',
});
run('seller', 'seller', ['src/index.ts'], { SELLER_PORT: String(SELLER_PORT), SELLER_ACCOUNT: acct.SELLER_ACCOUNT, WALLET_CONTRACT: acct.WALLET_CONTRACT, NEAR_RPC_URL: acct.NEAR_RPC_URL });
run('agent', 'agent', ['src/index.ts', 'serve'], {
  FUSE_AGENT_PORT: String(AGENT_PORT), FUSE_BRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`, SELLER_URL: `http://127.0.0.1:${SELLER_PORT}`,
  SELLER_ACCOUNT: acct.SELLER_ACCOUNT, FUSE_REDTEAM_COOLDOWN_MS: process.env.FUSE_REDTEAM_COOLDOWN_MS ?? '8000',
});

// Public surface. GET anywhere; POST only where a visitor is meant to act.
const WRITABLE = { bridge: new Set(['/pay']), agent: new Set(['/attempt']) };
const upstream = (url) => {
  if (url.startsWith('/api/bridge')) return { name: 'bridge', port: BRIDGE_PORT, path: url.slice('/api/bridge'.length) || '/' };
  if (url.startsWith('/api/agent')) return { name: 'agent', port: AGENT_PORT, path: url.slice('/api/agent'.length) || '/' };
  if (url.startsWith('/seller')) return { name: 'seller', port: SELLER_PORT, path: url.slice('/seller'.length) || '/' };
  return null;
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4' };

const server = http.createServer((req, res) => {
  const u = upstream(req.url ?? '/');
  if (u) {
    const pathname = u.path.split('?')[0];
    const method = req.method ?? 'GET';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !WRITABLE[u.name]?.has(pathname)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'read-only hosted demo', hint: 'this deployment accepts payments and red-team attempts only; configuration lives on the operator\'s machine' }));
    }
    const headers = { ...req.headers, host: `127.0.0.1:${u.port}`, 'x-forwarded-for': req.socket.remoteAddress ?? '', 'x-forwarded-proto': 'https' };
    const p = http.request({ host: '127.0.0.1', port: u.port, method, path: u.path, headers }, (pr) => { res.writeHead(pr.statusCode ?? 502, pr.headers); pr.pipe(res); });
    p.on('error', () => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `${u.name} is starting, try again in a few seconds` })); });
    req.pipe(p);
    return;
  }
  // static frontend with SPA fallback
  let file = path.join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]));
  if (!file.startsWith(DIST)) { res.writeHead(400); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
  fs.createReadStream(file).pipe(res);
});

// WebSocket: the live page's event stream (/api/bridge/events) is tunnelled byte for byte to the bridge.
server.on('upgrade', (req, socket, head) => {
  const u = upstream(req.url ?? '/');
  if (!u || u.name !== 'bridge') return socket.destroy();
  const target = net.connect(u.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${u.path} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${k === 'host' ? `127.0.0.1:${u.port}` : v}`);
    target.write(lines.join('\r\n') + '\r\n\r\n'); if (head.length) target.write(head);
    socket.pipe(target); target.pipe(socket);
  });
  target.on('error', () => socket.destroy()); socket.on('error', () => target.destroy());
});

server.listen(PORT, '0.0.0.0', () => console.error(`[demo] fuse hosted demo on :${PORT}  (bridge ${BRIDGE_PORT}, agent ${AGENT_PORT}, seller ${SELLER_PORT}, simulator only)`));
const stop = () => { for (const c of children) try { c.kill(); } catch {} process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
