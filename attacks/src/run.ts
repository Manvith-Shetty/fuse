// Fuse attack suite runner. Run from the repo root: `npm run attacks` (cwd becomes bridge/ so bridge/.env loads).
// Sequential on purpose: the simulated chip tracks nonces, parallel signing would race.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as n from 'near-api-js';
import { sha256 } from '@noble/hashes/sha2.js';
import { makeFuse } from '../../bridge/src/setup.js';
import { SimChip } from '../../bridge/src/chip-sim.js';
import { outcomeStatus } from '../../bridge/src/near.js';
import { explorerTx } from '../../bridge/src/config.js';
import type { SignResult } from '../../bridge/src/chip.js';
import { scenarios, encode, pay, type Env, type Layer } from './scenarios.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ATTACKS_DIR = path.resolve(here, '..');
const NO_BROADCAST = process.argv.includes('--no-broadcast');
const LEGIT_DECISIONS = 50;
const TINY = '1000000000000000000000';

interface Result {
  id: number; name: string; paper_ref: string; signer: string; expected: { layer: Layer; match: string };
  actual: { layer: Layer | 'none'; code?: string; detail?: string; error?: string }; stopped: boolean;
  tx_hash?: string; refusal?: { counter?: number; recorded?: boolean; explorer?: string; error?: string };
  broadcast?: { explorer: string; executed: boolean }; notes?: string;
}

const errText = (e: any) => {
  try { return [e?.message, e?.type, JSON.stringify(e?.cause ?? e?.data ?? e?.context ?? {})].filter(Boolean).join(' | '); } catch { return String(e); }
};

async function main() {
  const { cfg, chip, fuse, log } = await makeFuse();
  if (chip.mode !== 'SIMULATED') { console.error('attack suite runs against the SIMULATED chip only (SIMULATE_CHIP=1)'); process.exit(2); }
  const hello = await chip.hello();
  const near = fuse.near;
  const seller = `api.${cfg.OWNER_ACCOUNT}`;

  // Clones of the simulated chip: same seed, separate state. Possible only because the simulator is software.
  // A real Fuse chip cannot be cloned or put into a compromised mode.
  const enrolledState = JSON.parse(fs.readFileSync(path.join(cfg.DATA_DIR, 'sim-chip-state.json'), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(cfg.DATA_DIR, 'sim-policy.json'), 'utf8'));
  const clone = async (name: string, unsafe: boolean, policyPatch: Record<string, unknown> = {}) => {
    const dir = path.join(ATTACKS_DIR, 'data', name);
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sim-chip-state.json'), JSON.stringify({ seed: enrolledState.seed, lastNonce: '0', counter: 1_000_000, refusals: [], note: `${name} clone of the SIMULATED chip for the attack suite` }));
    fs.writeFileSync(path.join(dir, 'sim-policy.json'), JSON.stringify({ ...policy, ...policyPatch }));
    return new SimChip({ dataDir: dir, agent: cfg.AGENT_ACCOUNT, wallet: cfg.WALLET_CONTRACT, button: 'press', buttonDelayMs: 10, unsafeSignAnything: unsafe }).init();
  };
  // one fresh clone per scratch scenario so nonce state never leaks between scenarios
  const scratchFor: Record<number, () => Promise<SimChip>> = {
    3: () => clone('scratch-split', false, { velocity_cap: 3, button_threshold: '1000000000000000000000000' }),
    8: () => clone('scratch-replay', false, { button_threshold: '1000000000000000000000000' }),
    9: () => clone('scratch-tamper', false, { button_threshold: '1000000000000000000000000' }),
  };
  const compromised = await clone('compromised', true);
  if ((await compromised.hello()).pubkey !== hello.pubkey) throw new Error('clone pubkey mismatch');

  // Nonce: the just-executed tx may not be 'final' yet, so read the key with optimistic finality and never go
  // below what the enrolled chip has already signed (it signs before the bridge broadcasts).
  const nextNonce = async (): Promise<bigint> => {
    const q: any = await near.provider.query({ request_type: 'view_access_key', finality: 'optimistic', account_id: cfg.AGENT_ACCOUNT, public_key: hello.pubkey });
    const chain = BigInt(q.nonce); const chipLast = BigInt((await chip.hello()).last_nonce);
    return (chain > chipLast ? chain : chipLast) + 1n;
  };
  // bridge/src/near.ts builds with finality 'final'; right after a broadcast the final view can lag by a block or
  // two, which the chip then sees as a nonce replay. Wait for finality before any enrolled-chip onchain action.
  const waitFinal = async () => {
    const chipLast = BigInt((await chip.hello()).last_nonce);
    for (let i = 0; i < 30; i++) {
      const q: any = await near.provider.query({ request_type: 'view_access_key', finality: 'final', account_id: cfg.AGENT_ACCOUNT, public_key: hello.pubkey });
      if (BigInt(q.nonce) >= chipLast) return; await new Promise(r => setTimeout(r, 500));
    }
  };
  const env = async (): Promise<Env> => ({
    agent: cfg.AGENT_ACCOUNT, wallet: cfg.WALLET_CONTRACT, seller, chipPubkey: hello.pubkey,
    nonce: await nextNonce(), blockHash: await near.latestBlockHash(),
    gasCap: BigInt((await chip.policyGet()).policy.gas_cap),
  });
  const results: Result[] = [];
  const started = new Date().toISOString();
  console.error(`[attacks] chip ${hello.pubkey} mode=${hello.mode} agent=${cfg.AGENT_ACCOUNT} wallet=${cfg.WALLET_CONTRACT} broadcast=${!NO_BROADCAST}`);

  // Legitimate baseline: two real payments through the enrolled chip (onchain), then 50 sign decisions on a
  // clone that are NOT broadcast (testnet funds and the 3 NEAR daily cap make 50 real payments pointless).
  const legit: { broadcast: any[]; decisions: number; refused: number; refusedCodes: string[] } = { broadcast: [], decisions: 0, refused: 0, refusedCodes: [] };
  if (!NO_BROADCAST) for (let i = 0; i < 2; i++) {
    await waitFinal();
    const r = await fuse.pay({ receiver: seller, token: 'near', amount: TINY, memo: `attack-suite legit #${i + 1}` });
    legit.broadcast.push({ ok: r.ok, hash: r.hash, explorer: r.explorer, code: r.code });
    console.error(`[legit ${i + 1}] ${r.ok ? 'executed' : 'FAILED ' + r.code} ${r.explorer ?? ''}`);
  }
  {
    const e = await env(); const legitChip = await clone('legit', false, { velocity_cap: 1000 });
    for (let k = 0; k < LEGIT_DECISIONS; k++) {
      const amt = String(10n ** 21n * BigInt(1 + (k % 400))); // 0.001 .. 0.4 NEAR, all under the 0.5 NEAR button threshold
      const bytes = encode({ signer: e.agent, pubkey: e.chipPubkey, receiver: e.wallet, nonce: e.nonce + BigInt(k), blockHash: e.blockHash, actions: [pay(e.seller, amt, `legit decision ${k}`)] });
      const r = await legitChip.sign(bytes, 'legit'); legit.decisions++; if (!r.ok) { legit.refused++; legit.refusedCodes.push(r.code); }
    }
    console.error(`[legit] ${legit.decisions} decisions, ${legit.refused} refused`);
  }

  for (const s of scenarios) {
    const e = await env();
    const res: Result = { id: s.id, name: s.name, paper_ref: s.paper_ref, signer: s.signer, expected: s.expected, actual: { layer: 'none' }, stopped: false, notes: s.notes };
    try {
      const scratch = s.signer === 'scratch' ? await scratchFor[s.id]() : undefined as unknown as SimChip;
      const signer = s.signer === 'enrolled' ? chip : s.signer === 'scratch' ? scratch : compromised;
      let bytes = encode(s.craft(e));
      let sign: SignResult;
      if (s.id === 3) { // threshold splitting: fill the scratch chip's velocity window first
        for (let i = 0; i < 3; i++) { const b = encode({ ...s.craft(e), nonce: e.nonce + BigInt(i) }); const r = await scratch.sign(b, 'split'); if (!r.ok) throw new Error('warm-up refused: ' + r.code); }
        bytes = encode({ ...s.craft(e), nonce: e.nonce + 3n }); sign = await scratch.sign(bytes, 'split');
      } else if (s.id === 8) { // replay
        const first = await scratch.sign(bytes, 'first'); if (!first.ok) throw new Error('first sign refused: ' + first.code);
        sign = await scratch.sign(bytes, 'replay');
      } else sign = await signer.sign(bytes, s.hint);
      res.tx_hash = sign.hash;

      if (!sign.ok) {
        res.actual = { layer: 'chip', code: sign.code, detail: sign.detail };
        res.stopped = sign.code === s.expected.match || s.expected.layer === 'chip';
        if (s.signer === 'enrolled' && sign.receipt && sign.counter !== undefined && sign.code_num !== undefined && !NO_BROADCAST) {
          await waitFinal();
          const rec = await fuse.recordRefusal(sign.hash, sign.code_num, sign.counter, sign.receipt);
          res.refusal = { counter: rec.counter, recorded: rec.recorded, explorer: rec.explorer, error: rec.error };
        } else if (sign.counter !== undefined) res.refusal = { counter: sign.counter, recorded: false };
      } else {
        // The chip signed: either the compromised clone, or (scenario 9) legit bytes we now tamper with.
        let toSend = bytes;
        if (s.id === 9) { toSend = new Uint8Array(bytes); const idx = toSend.indexOf('a'.charCodeAt(0), 120); toSend[idx > 0 ? idx : toSend.length - 20] ^= 0x01; }
        if (NO_BROADCAST) { res.actual = { layer: 'none', detail: 'SKIPPED: chip signed, broadcast disabled (--no-broadcast)' }; res.notes = (res.notes ?? '') + ' Needs broadcast to evaluate.'; }
        else {
          const tx = n.decodeTransaction(toSend);
          const signed = new n.SignedTransaction({ transaction: tx, signature: new n.Signature({ keyType: n.KeyType.ED25519, data: new Uint8Array(Buffer.from(sign.sig, 'base64')) }) });
          const txHash = n.baseEncode(sha256(toSend)); res.tx_hash = txHash;
          try {
            const outcome = await near.send(signed); const st = outcomeStatus(outcome);
            res.broadcast = { explorer: explorerTx(cfg, txHash), executed: st.ok };
            if (st.ok) res.actual = { layer: 'none', detail: 'EXECUTED: nothing stopped it' };
            else res.actual = { layer: 'contract', error: st.error };
          } catch (err: any) {
            const t = errText(err); res.broadcast = { explorer: explorerTx(cfg, txHash), executed: false };
            const isContract = /FunctionCallError|Smart contract panicked|ExecutionError|WebAssembly trap/.test(t);
            res.actual = { layer: isContract ? 'contract' : 'protocol', error: t.slice(0, 600) };
          }
          res.stopped = res.actual.layer !== 'none' && (res.actual.error ?? '').includes(s.expected.match);
          if (res.actual.layer !== 'none' && !res.stopped && res.actual.layer === s.expected.layer) {
            res.stopped = true; res.notes = (res.notes ?? '') + ` Stopped by the expected layer but the error text differs from '${s.expected.match}'.`;
            if (/WebAssembly trap/.test(res.actual.error ?? '')) res.notes += ' The contract panicked but the panic message was lost (wasm trap). Known cause: wasm built with Rust >= 1.87 loses panic strings on the NEAR VM; rebuild the contract with the 1.86 toolchain to get readable messages.';
          }
        }
      }
    } catch (err: any) { res.actual = { layer: 'none', error: 'runner error: ' + errText(err).slice(0, 400) }; }
    console.error(`[${String(s.id).padStart(2)}] ${res.stopped ? 'STOPPED by ' + res.actual.layer : 'NOT STOPPED'}  ${s.name}  -> ${res.actual.code ?? (res.actual.error ?? '').slice(0, 90)}`);
    results.push(res);
    log.add({ type: 'attack_scenario', mode: 'SIMULATED', id: s.id, name: s.name, stopped: res.stopped, layer: res.actual.layer, code: res.actual.code });
  }

  const by = (l: Layer) => results.filter(r => r.stopped && r.actual.layer === l).length;
  const stopped = results.filter(r => r.stopped).length;
  const summary = `${stopped}/${results.length} attacks stopped (${by('chip')} by the chip, ${by('protocol')} by the NEAR protocol, ${by('contract')} by the contract), ${legit.refused}/${legit.decisions} legitimate decisions refused, ${legit.broadcast.filter(b => b.ok).length}/${legit.broadcast.length} legitimate payments executed onchain`;
  const report = { started, finished: new Date().toISOString(), network: cfg.NEAR_NETWORK, chip: hello, accounts: { agent: cfg.AGENT_ACCOUNT, wallet: cfg.WALLET_CONTRACT, seller }, broadcast: !NO_BROADCAST, summary, legit, results };
  fs.writeFileSync(path.join(ATTACKS_DIR, 'report.json'), JSON.stringify(report, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  fs.writeFileSync(path.join(ATTACKS_DIR, 'report.md'), renderMd(report));
  console.error('\n' + summary + '\nreport: attacks/report.md');
  await chip.close(); process.exit(stopped === results.length && legit.refused === 0 ? 0 : 1);
}

function renderMd(r: any): string {
  const row = (x: Result) => `| ${x.id} | ${x.name} | ${x.signer} | ${x.expected.layer}: \`${x.expected.match}\` | ${x.actual.layer}${x.actual.code ? ': `' + x.actual.code + '`' : ''} | ${x.stopped ? 'STOPPED' : '**NOT STOPPED**'} | ${x.refusal?.recorded ? `[#${x.refusal.counter}](${x.refusal.explorer})` : x.refusal?.counter !== undefined ? `#${x.refusal.counter} (not posted)` : ''} | ${x.broadcast ? `[tx](${x.broadcast.explorer})${x.broadcast.executed ? ' executed' : ' rejected'}` : ''} |`;
  const details = r.results.map((x: Result) =>
    `### ${x.id}. ${x.name}\n- Paper/ref: ${x.paper_ref}\n- Signer: ${x.signer} chip\n- Expected: ${x.expected.layer} \`${x.expected.match}\`\n- Actual: ${x.actual.layer}${x.actual.code ? ' `' + x.actual.code + '`' : ''}${x.actual.detail ? ' (' + x.actual.detail + ')' : ''}${x.actual.error ? '\n  - error: `' + x.actual.error.replace(/`/g, "'").slice(0, 400) + '`' : ''}\n${x.tx_hash ? '- Tx hash (of the crafted bytes): `' + x.tx_hash + '`\n' : ''}${x.notes ? '- Note: ' + x.notes + '\n' : ''}`).join('\n');
  return `# Fuse attack suite report

Generated ${r.finished} against NEAR ${r.network}. Chip: \`${r.chip.pubkey}\` (mode **${r.chip.mode}**).
Agent account \`${r.accounts.agent}\` (its only key is the chip's function-call key), wallet contract \`${r.accounts.wallet}\`, seller \`${r.accounts.seller}\`.

## Summary

**${r.summary}.**

Honest caveats: this report is self-generated and reproducible (\`npm run attacks\`). The chip is the software
**simulator** running the same decoder and policy as the firmware; a real Fuse chip cannot be cloned or put into
the "compromised" mode used for scenarios 13-16. The 50 legitimate decisions were signed but not broadcast
(testnet funds, 3 NEAR daily cap); 2 legitimate payments were broadcast. Testnet, not mainnet.

Legitimate payments broadcast: ${r.legit.broadcast.map((b: any) => `[${b.ok ? 'executed' : 'failed ' + b.code}](${b.explorer})`).join(', ') || 'none (broadcast disabled)'}.

## Scenarios

| # | Attack | Signer | Expected lock | Actual | Result | Refusal receipt onchain | Broadcast |
| --- | --- | --- | --- | --- | --- | --- | --- |
${r.results.map(row).join('\n')}

Locks: **chip** = firmware/simulator decodes the bytes and refuses, signing a refusal receipt; **protocol** = NEAR rejects
the signed transaction because the agent account's only key is a function-call key scoped to the wallet contract;
**contract** = the fuse-wallet contract re-checks the policy onchain and panics.

## Details

${details}
`;
}
main().catch(e => { console.error(e); process.exit(1); });
