#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import { makeFuse } from './setup.js';
import { serve } from './server.js';
import { explorerAccount, explorerTx } from './config.js';
import { enroll } from './enroll.js';
import { ChainSig, crossChainPay, CHAINS, type ChainKey } from './chainsig.js';

const out = (o: unknown) => console.log(JSON.stringify(o, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
const program = new Command().name('fuse').description('Fuse bridge: the untrusted relay between an agent, the Fuse chip and NEAR');

program.command('hello').description('ask the chip who it is (public key, firmware, policy hash, mode)').action(async () => {
  const { chip, cfg } = await makeFuse(); const h = await chip.hello(); out({ ...h, agent_account: cfg.AGENT_ACCOUNT, agent_explorer: explorerAccount(cfg, cfg.AGENT_ACCOUNT) }); await chip.close();
});
program.command('ping').action(async () => { const { chip } = await makeFuse(); out(await chip.ping()); await chip.close(); });
program.command('decode <base64tx>').description('ask the chip to decode a transaction without signing').action(async (b64) => {
  const { chip } = await makeFuse(); out(await chip.decode(new Uint8Array(Buffer.from(b64, 'base64')))); await chip.close();
});
program.command('pay').description('pay through the wallet contract; the chip decides')
  .requiredOption('-r, --receiver <account>').requiredOption('-a, --amount <atomic>').option('-t, --token <token>', 'token contract or "near"', 'near').option('-m, --memo <memo>')
  .action(async (o) => { const { fuse, chip } = await makeFuse(); out(await fuse.pay({ receiver: o.receiver, token: o.token, amount: o.amount, memo: o.memo })); await chip.close(); });
program.command('keys').description('show the agent account access keys on chain (judges: expect exactly one function-call key)').action(async () => {
  const { fuse, cfg, chip } = await makeFuse(); out({ account: cfg.AGENT_ACCOUNT, explorer: explorerAccount(cfg, cfg.AGENT_ACCOUNT), keys: await fuse.near.accessKeys(cfg.AGENT_ACCOUNT) }); await chip.close();
});
program.command('enroll').description('make the chip the ONLY key of the agent account: add its function-call key, delete the bootstrap full-access key')
  .option('--keep-bootstrap-key', 'add the chip key but keep the bootstrap key (dev only)')
  .action(async (o) => {
    const { fuse, cfg, chip } = await makeFuse();
    const pub = await fuse.chipPubkey();
    const r = await enroll(cfg, fuse.near, pub, { keepBootstrapKey: !!o.keepBootstrapKey });
    out({ ...r, explorer: r.hash ? explorerTx(cfg, r.hash) : undefined, account_explorer: explorerAccount(cfg, cfg.AGENT_ACCOUNT) }); await chip.close();
  });
const policy = program.command('policy').description('read or update the chip policy');
policy.command('get').action(async () => { const { chip } = await makeFuse(); out(await chip.policyGet()); await chip.close(); });
policy.command('set <file>').description('send a policy JSON file to the chip (needs the button)').action(async (file) => {
  const { chip } = await makeFuse(); out(await chip.policySet(JSON.parse(fs.readFileSync(file, 'utf8')))); await chip.close();
});
program.command('onchain').description('read wallet contract views').action(async () => {
  const { fuse, cfg, chip } = await makeFuse();
  const views: Record<string, unknown> = {};
  for (const m of ['get_state', 'get_policy', 'get_daily_spent', 'get_counts']) { try { views[m] = await fuse.near.view(cfg.WALLET_CONTRACT, m); } catch (e: any) { views[m] = { error: e.message }; } }
  try { views.get_refusals = await fuse.near.view(cfg.WALLET_CONTRACT, 'get_refusals', { from_index: 0, limit: 20 }); } catch (e: any) { views.get_refusals = { error: e.message }; }
  try { views.get_payments = await fuse.near.view(cfg.WALLET_CONTRACT, 'get_payments', { from_index: 0, limit: 20 }); } catch (e: any) { views.get_payments = { error: e.message }; }
  out(views); await chip.close();
});
const cs = program.command('chain-sig').description('Chain Signatures: the same chip approves a payment on another chain');
cs.command('address').description('derive the wallet contract\'s address on the foreign chain').option('-c, --chain <key>', 'chain key', 'eth-sepolia').action(async (o) => {
  const { fuse, cfg, chip } = await makeFuse(); const c = new ChainSig(o.chain as ChainKey, process.env.SEPOLIA_RPC_URL || undefined);
  const d = await c.derive(cfg.WALLET_CONTRACT); const b = await c.balance(d.address).catch(() => ({ balance: 0n, decimals: 18 }));
  out({ chain: o.chain, path: CHAINS[o.chain as ChainKey].path, predecessor: cfg.WALLET_CONTRACT, ...d, balanceWei: b.balance.toString(), explorer: CHAINS[o.chain as ChainKey].addr(d.address) }); await chip.close();
});
cs.command('pay').description('propose a foreign-chain payment through the chip and the wallet contract')
  .requiredOption('--to <address>').requiredOption('--value-wei <wei>').option('-c, --chain <key>', 'chain key', 'eth-sepolia').option('--broadcast', 'broadcast to the foreign chain if funded')
  .action(async (o) => { const { fuse, chip } = await makeFuse(); const c = new ChainSig(o.chain as ChainKey, process.env.SEPOLIA_RPC_URL || undefined); out(await crossChainPay(fuse, c, o.to, BigInt(o.valueWei), { broadcast: !!o.broadcast })); await chip.close(); });

program.command('serve').description('run the local bridge API for the dashboard, agent and MCP server').option('-p, --port <port>', 'port', '7777').action(async (o) => { await serve(Number(o.port)); });
program.parseAsync().then(() => process.exit(0)).catch((e) => { console.error(e?.message ?? e); process.exit(1); }); // exit explicitly: the fs serial transport keeps a blocking read in flight
