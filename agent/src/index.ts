#!/usr/bin/env node
// The Fuse agent CLI: an AI buyer that can only PROPOSE payments. The chip decides. The chain records.
// `run` one task, `loop` on a timer, `serve` the red-team HTTP endpoint. Logic lives in core.ts.
import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { BridgeClient } from './bridge.js';
import { runAgent, poisonedInvoice, type AgentEvent } from './core.js';
import { startServer } from './serve.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../bridge/.env'), quiet: true } as any); // share the bridge env by default
const bridge = new BridgeClient();
const log = (o: unknown) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
const print = (e: AgentEvent) => {
  switch (e.type) {
    case 'provider': return log(`[agent] provider=${e.provider} model=${e.model} (${e.labelled})`);
    case 'note': return log(`[agent] ${e.text}`);
    case 'tool': return log(`[agent] tool ${e.name} ${JSON.stringify(e.args)}`);
    case 'counterparty': return log(`[agent] counterparty ${e.receiver}: ${e.verdict}${e.reports !== undefined ? ` (${e.reports} reports)` : ''}`);
    case 'decision': return log(`[agent] decision attested=${e.attested}${e.kind ? ` kind=${e.kind}` : ''}${e.signer ? ` signer=${e.signer}` : ''}${e.error ? ` (${e.error})` : ''}`);
    case 'pay_result': return log({ event: e.event, ...e.result });
    case 'final': return log(`[agent] ${e.text}`);
  }
};
const loadDoc = (o: any) => o.inject ? poisonedInvoice() : o.doc ? fs.readFileSync(o.doc, 'utf8') : undefined;

const program = new Command().name('fuse-agent').description('AI purchasing agent whose only wallet is the Fuse chip');
program.command('run').description('run one task')
  .option('-t, --task <task>', 'what to buy', 'Buy the weather report for Bengaluru.')
  .option('--inject', 'attach the poisoned invoice fixture (prompt-injection demo)')
  .option('--doc <file>', 'attach a document file as untrusted content')
  .action(async (o) => {
    const st = await bridge.status(); if (st.http) { log({ error: 'bridge unreachable', st }); process.exit(1); }
    log(`[agent] chip mode=${st.mode} heartbeat.alive=${st.heartbeat?.alive} agent=${st.accounts?.agent}`);
    const r = await runAgent({ task: o.task, doc: loadDoc(o), bridge, sink: print });
    log(`[agent] outcome=${r.outcome}`);
  });
program.command('loop').description('autonomy: buy on a timer while the dashboard streams')
  .option('-t, --task <task>', 'what to buy each tick', 'Buy the weather report for Bengaluru.')
  .option('--every <seconds>', 'interval', '60').option('--inject-every <n>', 'attach the poisoned invoice every n-th tick (0 = never)', '0')
  .action(async (o) => {
    let i = 0; const every = Number(o.every) * 1000, inj = Number(o.injectEvery);
    for (;;) {
      i++; const doc = inj && i % inj === 0 ? poisonedInvoice() : undefined;
      log(`\n[agent] tick ${i} ${new Date().toISOString()}${doc ? ' (poisoned document attached)' : ''}`);
      try { await runAgent({ task: o.task, doc, bridge, sink: print }); } catch (e: any) { log(`[agent] error: ${e.message}`); }
      await new Promise(r => setTimeout(r, every));
    }
  });
program.command('serve').description('red-team server: POST /attempt {text} runs the agent on an untrusted document; GET /attempts is the leaderboard')
  .option('-p, --port <port>', 'port', process.env.FUSE_AGENT_PORT ?? '7778')
  .action(async (o) => { startServer(Number(o.port)); await new Promise(() => {}); });
program.parseAsync().catch(e => { console.error(e?.message ?? e); process.exit(1); });
