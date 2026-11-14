import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeFuse } from './setup.js';
import { explorerAccount, loadConfig, writeConfigFile, readConfigFile, UI_KEYS, defaultRpc, type Config } from './config.js';
import { buildAudit, auditMarkdown } from './audit.js';
import { Near } from './near.js';
import { Fuse } from './fuse.js';
import { AGENT_METHODS } from './enroll.js';
import type { PolicyAuth } from './chip.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(here, '..', '..', 'contracts');
const ARTIFACT_FILES: Record<string, string> = { 'fuse_wallet_v2.wasm': 'fuse-wallet/res/fuse_wallet_v2.wasm', 'fuse_wallet.wasm': 'fuse-wallet/res/fuse_wallet.wasm', 'fuse_registry.wasm': 'fuse-registry/res/fuse_registry.wasm' };
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

// Local API for the dashboard, the agent and the MCP server. Binds to localhost only.
export async function serve(port: number) {
  const first = await makeFuse();
  const { chip, log } = first;
  // Accounts and network are reconfigurable at runtime from the setup UI (POST /config); the chip and the log persist.
  const ctx: { cfg: Config; fuse: Fuse } = { cfg: first.cfg, fuse: first.fuse };
  const reconfigure = () => { const cfg = loadConfig(); ctx.cfg = cfg; ctx.fuse = new Fuse(cfg, chip, new Near(cfg.NEAR_RPC_URL), log); log.add({ type: 'config_update', mode: 'BRIDGE', network: cfg.NEAR_NETWORK, wallet: cfg.WALLET_CONTRACT, agent: cfg.AGENT_ACCOUNT, registry: cfg.REGISTRY_CONTRACT || null }); return cfg; };
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const heartbeat = { alive: false, misses: 0, lastOk: 0, revokedSince: 0 as number | 0 };
  const tick = async () => {
    try {
      await chip.ping(); heartbeat.misses = 0; heartbeat.lastOk = Date.now();
      if (!heartbeat.alive) {
        heartbeat.alive = true; heartbeat.revokedSince = 0;
        // Record what connected: firmware and policy hashes end up in the audit trail.
        let h: any = {}; try { h = await chip.hello(); } catch {}
        log.add({ type: 'chip_connected', mode: chip.mode, fw: h.fw, fw_sha256: h.fw_sha256, policy_hash: h.policy_hash, proto: h.proto, pubkey: h.pubkey });
      }
    }
    catch { heartbeat.misses++; if (heartbeat.misses >= 3 && heartbeat.alive) { heartbeat.alive = false; heartbeat.revokedSince = Date.now(); log.add({ type: 'AGENT_REVOKED', mode: 'BRIDGE', detail: 'chip unreachable: no key, no signatures, no spending' }); } }
  };
  await tick(); const timer = setInterval(tick, 2000);
  chip.on('disconnected', () => { heartbeat.misses = 3; void tick(); });

  const accounts = (cfg: Config) => ({ owner: cfg.OWNER_ACCOUNT || null, agent: cfg.AGENT_ACCOUNT, wallet: cfg.WALLET_CONTRACT, registry: cfg.REGISTRY_CONTRACT || null, agent_explorer: explorerAccount(cfg, cfg.AGENT_ACCOUNT), wallet_explorer: explorerAccount(cfg, cfg.WALLET_CONTRACT) });

  app.get('/status', async () => {
    // When the heartbeat is dead, do not wait on chip timeouts (6 s): answer at once so the dashboard stays responsive.
    let hello: any = { error: 'chip not connected' }, policy: any = null;
    if (heartbeat.alive) {
      try { hello = await chip.hello(); } catch (e: any) { hello = { error: e.message }; }
      try { policy = (await chip.policyGet()).policy; } catch {}
    }
    const configured = !!(readConfigFile(ctx.cfg.DATA_DIR).WALLET_CONTRACT || process.env.WALLET_CONTRACT);
    return { mode: chip.mode, chip: hello, policy, heartbeat, accounts: accounts(ctx.cfg), network: ctx.cfg.NEAR_NETWORK, rpc: ctx.cfg.NEAR_RPC_URL, configured };
  });
  app.get('/log', async (req: any) => log.recent(Number(req.query?.limit ?? 100)));
  app.post('/pay', async (req: any, reply) => {
    const b = req.body ?? {};
    if (!b.receiver || !b.token || typeof b.amount !== 'string') return reply.code(400).send({ error: 'receiver, token, amount (decimal string) required' });
    if (!heartbeat.alive) return reply.code(503).send({ error: 'AGENT_REVOKED: chip not connected', mode: chip.mode });
    const decision = b.decision && typeof b.decision.text === 'string' ? { text: b.decision.text, sig: String(b.decision.sig ?? ''), signer: String(b.decision.signer ?? ''), ...(b.decision.resp ? { resp: String(b.decision.resp) } : {}) } : undefined;
    return ctx.fuse.pay({ receiver: b.receiver, token: b.token, amount: b.amount, memo: b.memo }, decision);
  });
  // Second-chip approval of a pending (quorum) payment.
  app.post('/approve', async (req: any, reply) => {
    const id = Number(req.body?.id); if (!Number.isInteger(id) || id < 0) return reply.code(400).send({ error: 'id (integer) required' });
    if (!heartbeat.alive) return reply.code(503).send({ error: 'AGENT_REVOKED: chip not connected', mode: chip.mode });
    return ctx.fuse.approve(id);
  });
  // Shared refusal registry: advisory verdict for a receiver.
  app.get('/check', async (req: any, reply) => {
    const receiver = String(req.query?.receiver ?? ''); if (!receiver) return reply.code(400).send({ error: 'receiver required' });
    const r = await ctx.fuse.check(receiver); return r ?? { verdict: 'allow', registry: null, detail: 'no registry configured (REGISTRY_CONTRACT)' };
  });
  app.get('/audit', async (req: any, reply) => {
    const a = await buildAudit(ctx.fuse);
    if (req.query?.format === 'md') { reply.type('text/markdown; charset=utf-8'); return auditMarkdown(a); }
    return a;
  });
  app.post('/chain-sig', async (req: any, reply) => {
    const b = req.body ?? {};
    if (!b.chain || !b.to || !b.value || !b.path || !b.payloadBase64) return reply.code(400).send({ error: 'chain, to, value, path, payloadBase64 required' });
    if (!heartbeat.alive) return reply.code(503).send({ error: 'AGENT_REVOKED: chip not connected' });
    return ctx.fuse.requestChainSig({ chain: b.chain, to: b.to, value: b.value, path: b.path, payloadBase64: b.payloadBase64, domainId: b.domainId ?? 0 });
  });
  app.get('/onchain', async () => {
    const w = ctx.cfg.WALLET_CONTRACT; const v = (m: string, a: Record<string, unknown> = {}) => ctx.fuse.near.view(w, m, a).catch((e: any) => ({ error: e.message }));
    const [policy, state, daily_spent, counts, payments, refusals, agent_keys, pending, config] = await Promise.all([
      v('get_policy'), v('get_state'), v('get_daily_spent'), v('get_counts'), v('get_payments', { from_index: 0, limit: 50 }), v('get_refusals', { from_index: 0, limit: 50 }),
      ctx.fuse.near.accessKeys(ctx.cfg.AGENT_ACCOUNT).catch((e: any) => ({ error: e.message })),
      v('get_pending', { from: 0, limit: 50 }), v('get_config'),
    ]);
    return { policy, state, daily_spent, counts, payments, refusals, agent_keys, pending, config };
  });

  // ---- setup from the UI (production path: no env files) ----
  // What the wizard needs to create the accounts with the owner's wallet: chip identity, network, artifact hashes, costs.
  app.get('/setup/info', async () => {
    let hello: any = null; try { hello = heartbeat.alive ? await chip.hello() : null; } catch {}
    const artifacts = Object.entries(ARTIFACT_FILES).map(([name, rel]) => { const p = path.join(ARTIFACTS, rel); if (!fs.existsSync(p)) return { name, missing: true }; const b = fs.readFileSync(p); return { name, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex'), url: `/artifacts/${name}` }; });
    return {
      chip: hello ? { pubkey: hello.pubkey, fw_sha256: hello.fw_sha256, proto: hello.proto, owner_pubkey: hello.owner_pubkey, policy_seq: hello.policy_seq, mode: chip.mode } : null,
      network: ctx.cfg.NEAR_NETWORK, rpc: ctx.cfg.NEAR_RPC_URL, current: accounts(ctx.cfg), config_file: readConfigFile(ctx.cfg.DATA_DIR), ui_keys: UI_KEYS,
      agent_methods: AGENT_METHODS, artifacts,
      // Suggested layout for an owner `<o>`: wallet contract fuse.<o>, agent agent.<o>; the wallet needs ~3 NEAR for storage (278 KB wasm) plus funds to spend.
      suggest_pattern: { wallet: 'fuse.<owner>', agent: 'agent.<owner>', approver: 'approver.<owner>' },
      costs: { wallet_storage_near: '2.9', agent_min_near: '0.1', note: 'storage is 1e19 yocto per byte; the v2 wasm is ~278 KB' },
      chain_sig_contract: ctx.cfg.NEAR_NETWORK === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet',
    };
  });
  app.get('/artifacts', async () => Object.entries(ARTIFACT_FILES).map(([name, rel]) => { const p = path.join(ARTIFACTS, rel); const b = fs.existsSync(p) ? fs.readFileSync(p) : null; return { name, bytes: b?.length ?? 0, sha256: b ? createHash('sha256').update(b).digest('hex') : null }; }));
  app.get('/artifacts/:name', async (req: any, reply) => {
    const rel = ARTIFACT_FILES[String(req.params?.name)]; if (!rel) return reply.code(404).send({ error: 'unknown artifact' });
    const p = path.join(ARTIFACTS, rel); if (!fs.existsSync(p)) return reply.code(404).send({ error: 'artifact not built' });
    reply.type('application/wasm'); return fs.readFileSync(p);
  });
  app.get('/config', async () => ({ file: readConfigFile(ctx.cfg.DATA_DIR), effective: Object.fromEntries(UI_KEYS.map(k => [k, (ctx.cfg as any)[k]])), path: 'data/config.json' }));
  // The wizard writes accounts here after it created them with the owner's wallet. Validated, persisted, applied at once.
  app.post('/config', async (req: any, reply) => {
    const b = req.body ?? {}; const patch: Record<string, string> = {};
    for (const k of UI_KEYS) if (b[k] !== undefined) { if (typeof b[k] !== 'string') return reply.code(400).send({ error: `${k} must be a string` }); patch[k] = b[k].trim(); }
    if (patch.NEAR_NETWORK && !['testnet', 'mainnet'].includes(patch.NEAR_NETWORK)) return reply.code(400).send({ error: 'NEAR_NETWORK must be testnet or mainnet' });
    for (const k of ['OWNER_ACCOUNT', 'WALLET_CONTRACT', 'AGENT_ACCOUNT', 'REGISTRY_CONTRACT'] as const) if (patch[k] && !ACCOUNT_RE.test(patch[k])) return reply.code(400).send({ error: `${k} is not a valid account id` });
    if (patch.NEAR_RPC_URL && !/^https?:\/\//.test(patch.NEAR_RPC_URL)) return reply.code(400).send({ error: 'NEAR_RPC_URL must be http(s)' });
    if (patch.NEAR_NETWORK && !patch.NEAR_RPC_URL && !readConfigFile(ctx.cfg.DATA_DIR).NEAR_RPC_URL) patch.NEAR_RPC_URL = defaultRpc(patch.NEAR_NETWORK);
    writeConfigFile(patch, ctx.cfg.DATA_DIR);
    const cfg = reconfigure();
    return { ok: true, effective: Object.fromEntries(UI_KEYS.map(k => [k, (cfg as any)[k]])), accounts: accounts(cfg) };
  });
  // Policy to the chip with an owner authorisation produced elsewhere (a browser wallet's NEP-413 signMessage, or the CLI).
  app.post('/policy', async (req: any, reply) => {
    const b = req.body ?? {}; const auth = b.auth as PolicyAuth | undefined;
    if (!b.policy || typeof b.policy !== 'object') return reply.code(400).send({ error: 'policy object required' });
    if (!auth || typeof auth.owner_sig !== 'string' || !Number.isInteger(auth.seq)) return reply.code(400).send({ error: 'auth {seq, owner_sig, owner_pubkey?, scheme?, nonce?, recipient?} required' });
    if (!heartbeat.alive) return reply.code(503).send({ error: 'AGENT_REVOKED: chip not connected', mode: chip.mode });
    const r = await chip.policySet(b.policy, auth);
    log.add({ type: r.ok ? 'policy_set' : 'policy_refused', mode: chip.mode, policy_hash: r.policy_hash, policy_seq: r.policy_seq, code: r.code, detail: r.detail, scheme: auth.scheme ?? 'raw' });
    return r;
  });
  // The message a wallet must sign for a given policy and seq (so the UI never reimplements the hashing).
  app.post('/policy/message', async (req: any, reply) => {
    const b = req.body ?? {}; if (!b.policy || typeof b.policy !== 'object') return reply.code(400).send({ error: 'policy object required' });
    const { policyAuthMessage, policyHashHex } = await import('./policy.js');
    let seq = Number(b.seq); if (!Number.isInteger(seq)) { try { seq = ((await chip.hello()).policy_seq ?? 0) + 1; } catch { seq = 1; } }
    return { seq, message: policyAuthMessage(b.policy, seq), policy_hash: policyHashHex(b.policy), recipient: 'fuse', scheme: 'nep413' };
  });

  app.get('/events', { websocket: true }, (socket) => {
    const send = (e: unknown) => { try { socket.send(JSON.stringify(e)); } catch {} };
    for (const e of log.recent(50)) send(e);
    const onEntry = (e: unknown) => send(e);
    log.on('entry', onEntry);
    const hb = setInterval(() => send({ type: 'heartbeat', ts: new Date().toISOString(), mode: chip.mode, ...heartbeat }), 1000);
    socket.on('close', () => { log.off('entry', onEntry); clearInterval(hb); });
  });

  await app.listen({ port, host: '127.0.0.1' });
  console.error(`[fuse] bridge on http://127.0.0.1:${port}  mode=${chip.mode}  network=${ctx.cfg.NEAR_NETWORK}  agent=${ctx.cfg.AGENT_ACCOUNT}  wallet=${ctx.cfg.WALLET_CONTRACT}${ctx.cfg.REGISTRY_CONTRACT ? `  registry=${ctx.cfg.REGISTRY_CONTRACT}` : ''}`);
  const stop = async () => { clearInterval(timer); await app.close(); await chip.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise(() => {}); // run until SIGINT: the CLI exits explicitly once a command resolves
  return app;
}
