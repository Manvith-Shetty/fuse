#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { makeFuse } from './setup.js';
import { serve } from './server.js';
import { explorerAccount, explorerTx } from './config.js';
import { enroll, AGENT_METHODS, APPROVER_METHODS } from './enroll.js';
import { ChainSig, crossChainPay, CHAINS, type ChainKey } from './chainsig.js';
import { loadKeyPair, signPolicyAuth, signPolicyAuthNep413 } from './keychain.js';
import { buildAudit, auditMarkdown } from './audit.js';
import { dryQuote, tokens } from './intents.js';
import { ChainSigBtc, BTC_CHAINS, isBtcChain } from './chainsig-btc.js';

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
  .option('--decision <file>', 'JSON file with an attested decision envelope {text, sig, signer, resp?} (protocol v2)')
  .action(async (o) => {
    const { fuse, chip } = await makeFuse();
    const decision = o.decision ? JSON.parse(fs.readFileSync(o.decision, 'utf8')) : undefined;
    out(await fuse.pay({ receiver: o.receiver, token: o.token, amount: o.amount, memo: o.memo }, decision)); await chip.close();
  });
program.command('keys').description('show the agent account access keys on chain (judges: expect exactly one function-call key)').action(async () => {
  const { fuse, cfg, chip } = await makeFuse(); out({ account: cfg.AGENT_ACCOUNT, explorer: explorerAccount(cfg, cfg.AGENT_ACCOUNT), keys: await fuse.near.accessKeys(cfg.AGENT_ACCOUNT) }); await chip.close();
});
program.command('enroll').description('make the chip the ONLY key of the agent account: add its function-call key, delete the bootstrap full-access key')
  .option('--keep-bootstrap-key', 'add the chip key but keep the bootstrap key (dev only)')
  .option('--role <role>', '"agent" (pay, record_refusal, request_chain_sig) or "approver" (approve_payment only)', 'agent')
  .action(async (o) => {
    const { fuse, cfg, chip } = await makeFuse();
    const pub = await fuse.chipPubkey();
    const methods = o.role === 'approver' ? APPROVER_METHODS : AGENT_METHODS;
    const r = await enroll(cfg, fuse.near, pub, { keepBootstrapKey: !!o.keepBootstrapKey, methods });
    out({ ...r, role: o.role, explorer: r.hash ? explorerTx(cfg, r.hash) : undefined, account_explorer: explorerAccount(cfg, cfg.AGENT_ACCOUNT) }); await chip.close();
  });
const policy = program.command('policy').description('read or update the chip policy');
policy.command('get').action(async () => { const { chip } = await makeFuse(); out(await chip.policyGet()); await chip.close(); });
policy.command('set <file>').description('send a policy JSON file to the chip, signed by the owner key (protocol v2), confirmed with the button')
  .option('--seq <n>', 'policy sequence number (default: chip policy_seq + 1)')
  .option('--owner <account>', 'owner account whose legacy-keychain key signs the policy (default: OWNER_ACCOUNT)')
  .option('--unsigned', 'v1 chips only: send without an owner signature')
  .option('--nep413', 'sign the NEP-413 way (what a browser wallet produces) instead of the raw digest')
  .action(async (file, o) => {
    const { chip, cfg } = await makeFuse();
    const pol = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (o.unsigned) { out(await chip.policySet(pol)); await chip.close(); return; }
    const owner = o.owner ?? cfg.OWNER_ACCOUNT; if (!owner) throw new Error('set OWNER_ACCOUNT or pass --owner');
    const h = await chip.hello();
    const seq = o.seq !== undefined ? Number(o.seq) : (h.policy_seq ?? 0) + 1;
    const kp = loadKeyPair(cfg.NEAR_NETWORK, owner);
    const auth = o.nep413 ? signPolicyAuthNep413(pol, seq, kp) : signPolicyAuth(pol, seq, kp);
    out({ owner, ...await chip.policySet(pol, auth) }); await chip.close();
  });
program.command('check <receiver>').description('shared refusal registry verdict for a receiver: allow / warn / block (advisory; the chip still decides)').action(async (receiver) => {
  const { fuse, chip } = await makeFuse(); out((await fuse.check(receiver)) ?? { verdict: 'allow', registry: null, detail: 'no registry configured (REGISTRY_CONTRACT)' }); await chip.close();
});
program.command('approve <id>').description('second chip: approve a pending (quorum) payment through this chip').action(async (id) => {
  const { fuse, chip } = await makeFuse(); out(await fuse.approve(Number(id))); await chip.close();
});
program.command('pending').description('list payments waiting for a second-chip approval').action(async () => {
  const { fuse, cfg, chip } = await makeFuse(); out(await fuse.near.view(cfg.WALLET_CONTRACT, 'get_pending', { from: 0, limit: 50 }).catch((e: any) => ({ error: e.message }))); await chip.close();
});
program.command('audit').description('export the verifiable spending history (payments, re-verified refusal receipts, chain sigs, config) as JSON and Markdown')
  .option('--out <dir>', 'output directory', 'data/audit')
  .option('--also-key <pubkey...>', 'previous chip keys (base58) to verify receipts issued before a set_chip_key rotation')
  .action(async (o) => {
    const { fuse, chip } = await makeFuse();
    const a = await buildAudit(fuse, undefined, o.alsoKey ?? []); fs.mkdirSync(o.out, { recursive: true });
    const stamp = a.generated_at.replace(/[:.]/g, '-');
    const j = path.join(o.out, `audit-${stamp}.json`), m = path.join(o.out, `audit-${stamp}.md`);
    fs.writeFileSync(j, JSON.stringify(a, null, 2)); fs.writeFileSync(m, auditMarkdown(a));
    out({ json: j, markdown: m, summary: a.summary }); await chip.close();
  });
program.command('onchain').description('read wallet contract views').action(async () => {
  const { fuse, cfg, chip } = await makeFuse();
  const views: Record<string, unknown> = {};
  for (const m of ['get_state', 'get_policy', 'get_daily_spent', 'get_counts', 'get_config']) { try { views[m] = await fuse.near.view(cfg.WALLET_CONTRACT, m); } catch (e: any) { views[m] = { error: e.message }; } }
  for (const m of ['get_refusals', 'get_payments', 'get_pending']) { try { views[m] = await fuse.near.view(cfg.WALLET_CONTRACT, m, m === 'get_pending' ? { from: 0, limit: 20 } : { from_index: 0, limit: 20 }); } catch (e: any) { views[m] = { error: e.message }; } }
  out(views); await chip.close();
});
const cs = program.command('chain-sig').description('Chain Signatures: the same chip approves a payment on another chain');
cs.command('address').description('derive the wallet contract\'s address on the foreign chain (eth-sepolia, btc-testnet4)').option('-c, --chain <key>', 'chain key', 'eth-sepolia').action(async (o) => {
  const { fuse, cfg, chip } = await makeFuse();
  if (isBtcChain(o.chain)) {
    const b = new ChainSigBtc(o.chain, cfg.NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet', cfg.NEAR_RPC_URL); const d = await b.derive(cfg.WALLET_CONTRACT);
    const bal = await b.balance(d.address).catch(() => ({ balance: 0n, decimals: 8 }));
    out({ chain: o.chain, path: BTC_CHAINS[o.chain].path, predecessor: cfg.WALLET_CONTRACT, ...d, balanceSats: bal.balance.toString(), explorer: BTC_CHAINS[o.chain].addr(d.address), note: 'fund this address with testnet4 coins to sign a transfer through the chip' }); await chip.close(); return;
  }
  const c = new ChainSig(o.chain as ChainKey, process.env.SEPOLIA_RPC_URL || undefined, cfg.NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet', cfg.NEAR_RPC_URL);
  const d = await c.derive(cfg.WALLET_CONTRACT); const b = await c.balance(d.address).catch(() => ({ balance: 0n, decimals: 18 }));
  out({ chain: o.chain, path: CHAINS[o.chain as ChainKey].path, predecessor: cfg.WALLET_CONTRACT, ...d, balanceWei: b.balance.toString(), explorer: CHAINS[o.chain as ChainKey].addr(d.address) }); await chip.close();
});
cs.command('pay').description('propose a foreign-chain payment through the chip and the wallet contract')
  .requiredOption('--to <address>').requiredOption('--value-wei <wei>').option('-c, --chain <key>', 'chain key', 'eth-sepolia').option('--broadcast', 'broadcast to the foreign chain if funded')
  .action(async (o) => { const { fuse, cfg, chip } = await makeFuse(); const c = new ChainSig(o.chain as ChainKey, process.env.SEPOLIA_RPC_URL || undefined, cfg.NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet', cfg.NEAR_RPC_URL); out(await crossChainPay(fuse, c, o.to, BigInt(o.valueWei), { broadcast: !!o.broadcast })); await chip.close(); });

const intents = program.command('intents').description('NEAR Intents (1Click) on mainnet: dry quotes only, nothing moves (HACKATHON.md Q-007)');
intents.command('tokens').description('list assets 1Click can route').action(async () => { out((await tokens()).slice(0, 50)); });
intents.command('quote').description('dry-run quote for a cross-chain purchase a Fuse-guarded agent could make')
  .requiredOption('--from <asset>', 'origin asset id, e.g. nep141:wrap.near').requiredOption('--to <asset>', 'destination asset id, e.g. nep141:eth.omft.near or a USDC id from `intents tokens`')
  .requiredOption('--amount <atomic>', 'exact input amount in the origin asset\'s atomic units').requiredOption('--recipient <address>', 'destination-chain recipient')
  .option('--refund-to <account>', 'origin-chain refund account (default: WALLET_CONTRACT)')
  .action(async (o) => { const { cfg } = await makeFuse({ SIMULATE_CHIP: '1' }); out(await dryQuote({ originAsset: o.from, destinationAsset: o.to, amount: o.amount, recipient: o.recipient, refundTo: o.refundTo ?? cfg.WALLET_CONTRACT })); });

program.command('serve').description('run the local bridge API for the dashboard, agent and MCP server').option('-p, --port <port>', 'port', '7777').action(async (o) => { await serve(Number(o.port)); });
program.parseAsync().then(() => process.exit(0)).catch((e) => { console.error(e?.message ?? e); process.exit(1); }); // exit explicitly: the fs serial transport keeps a blocking read in flight
