import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { makeFuse } from './setup.js';
import { explorerAccount } from './config.js';

// Local API for the dashboard, the agent and the MCP server. Binds to localhost only.
export async function serve(port: number) {
  const { cfg, chip, log, fuse } = await makeFuse();
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const heartbeat = { alive: false, misses: 0, lastOk: 0, revokedSince: 0 as number | 0 };
  const tick = async () => {
    try { await chip.ping(); heartbeat.misses = 0; heartbeat.lastOk = Date.now(); if (!heartbeat.alive) { heartbeat.alive = true; heartbeat.revokedSince = 0; log.add({ type: 'chip_connected', mode: chip.mode }); } }
    catch { heartbeat.misses++; if (heartbeat.misses >= 3 && heartbeat.alive) { heartbeat.alive = false; heartbeat.revokedSince = Date.now(); log.add({ type: 'AGENT_REVOKED', mode: 'BRIDGE', detail: 'chip unreachable: no key, no signatures, no spending' }); } }
  };
  await tick(); const timer = setInterval(tick, 2000);
  chip.on('disconnected', () => { heartbeat.misses = 3; void tick(); });

  app.get('/status', async () => {
    // When the heartbeat is dead, do not wait on chip timeouts (6 s): answer at once so the dashboard stays responsive.
    let hello: any = { error: 'chip not connected' }, policy: any = null;
    if (heartbeat.alive) {
      try { hello = await chip.hello(); } catch (e: any) { hello = { error: e.message }; }
      try { policy = (await chip.policyGet()).policy; } catch {}
    }
    return { mode: chip.mode, chip: hello, policy, heartbeat, accounts: { agent: cfg.AGENT_ACCOUNT, wallet: cfg.WALLET_CONTRACT, agent_explorer: explorerAccount(cfg, cfg.AGENT_ACCOUNT), wallet_explorer: explorerAccount(cfg, cfg.WALLET_CONTRACT) }, network: cfg.NEAR_NETWORK };
  });
  app.get('/log', async (req: any) => log.recent(Number(req.query?.limit ?? 100)));
  app.post('/pay', async (req: any, reply) => {
    const b = req.body ?? {};
    if (!b.receiver || !b.token || typeof b.amount !== 'string') return reply.code(400).send({ error: 'receiver, token, amount (decimal string) required' });
    if (!heartbeat.alive) return reply.code(503).send({ error: 'AGENT_REVOKED: chip not connected', mode: chip.mode });
    return fuse.pay({ receiver: b.receiver, token: b.token, amount: b.amount, memo: b.memo });
  });
  app.post('/chain-sig', async (req: any, reply) => {
    const b = req.body ?? {};
    if (!b.chain || !b.to || !b.value || !b.path || !b.payloadBase64) return reply.code(400).send({ error: 'chain, to, value, path, payloadBase64 required' });
    if (!heartbeat.alive) return reply.code(503).send({ error: 'AGENT_REVOKED: chip not connected' });
    return fuse.requestChainSig({ chain: b.chain, to: b.to, value: b.value, path: b.path, payloadBase64: b.payloadBase64, domainId: b.domainId ?? 0 });
  });
  app.get('/onchain', async () => {
    const w = cfg.WALLET_CONTRACT; const v = (m: string, a: Record<string, unknown> = {}) => fuse.near.view(w, m, a).catch((e: any) => ({ error: e.message }));
    const [policy, state, daily_spent, counts, payments, refusals, agent_keys] = await Promise.all([
      v('get_policy'), v('get_state'), v('get_daily_spent'), v('get_counts'), v('get_payments', { from_index: 0, limit: 50 }), v('get_refusals', { from_index: 0, limit: 50 }),
      fuse.near.accessKeys(cfg.AGENT_ACCOUNT).catch((e: any) => ({ error: e.message })),
    ]);
    return { policy, state, daily_spent, counts, payments, refusals, agent_keys };
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
  console.error(`[fuse] bridge on http://127.0.0.1:${port}  mode=${chip.mode}  agent=${cfg.AGENT_ACCOUNT}  wallet=${cfg.WALLET_CONTRACT}`);
  const stop = async () => { clearInterval(timer); await app.close(); await chip.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await new Promise(() => {}); // run until SIGINT: the CLI exits explicitly once a command resolves
  return app;
}
