// Dry run of the setup wizard WITHOUT a browser: executes the exact transactions the wizard asks the owner's wallet to
// sign (frontend/src/lib/setup.ts builders), signed here by a fresh faucet owner's keychain key instead of an extension.
// Proves on testnet that: Tx A (CreateAccount+Transfer+DeployContract+FunctionCall new) and Tx B (CreateAccount+Transfer+
// AddKey function-call key) are accepted, the agent account ends with exactly one key, and set_registry works.
// The "chip" is a throwaway ed25519 key (this is a transaction-shape test, not a chip test).
// Usage: npx tsx scripts/wizard-dryrun.ts [bridgeUrl]            (bridge only used for /artifacts and /setup/info)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KeyPair, KeyPairEd25519, PublicKey, createTransaction, encodeTransaction, actions as A, SignedTransaction, Signature, KeyType, baseDecode, JsonRpcProvider } from 'near-api-js';
import { sha256 } from '@noble/hashes/sha2.js';
import { walletCreateActions, agentCreateActions, registryActions, chipPolicy, type Action } from '../../frontend/src/lib/setup.ts';

const bridge = process.argv[2] ?? 'http://127.0.0.1:7777';
const RPC = 'https://test.rpc.fastnear.com';
const NEAR = process.platform === 'win32' ? path.join(execFileSync('npm.cmd', ['root', '-g'], { encoding: 'utf8', shell: true }).trim(), 'near-cli-rs', 'node_modules', '.bin_real', 'near.exe') : 'near';
const provider = new JsonRpcProvider({ url: RPC });
const log = (...a: unknown[]) => console.log(...a);

// 1. a fresh owner from the faucet (what the human's wallet already has)
const owner = `fuse-wiz-${Math.random().toString(36).slice(2, 7)}.testnet`;
log(`== owner ${owner} (faucet)`);
execFileSync(NEAR, ['account', 'create-account', 'sponsor-by-faucet-service', owner, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'network-config', 'testnet', 'create'], { stdio: 'ignore' });
const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.near-credentials', 'testnet', `${owner}.json`), 'utf8'));
const ownerKp = KeyPair.fromString(cred.private_key) as KeyPairEd25519;

// 2. what the wizard reads from the bridge: artifact + its hash
const info: any = await (await fetch(`${bridge}/setup/info`)).json();
const art = info.artifacts.find((a: any) => a.name === 'fuse_wallet_v2.wasm');
const code = new Uint8Array(await (await fetch(`${bridge}/artifacts/fuse_wallet_v2.wasm`)).arrayBuffer());
const codeHash = createHash('sha256').update(code).digest('hex');
if (codeHash !== art.sha256) throw new Error(`artifact hash mismatch ${codeHash} vs ${art.sha256}`);
log(`artifact fuse_wallet_v2.wasm ${code.length} bytes, sha256 verified ${codeHash.slice(0, 12)}…`);

// 3. a stand-in chip key (a real run uses the chip's pubkey from /setup/info)
const chip = KeyPairEd25519.fromRandom(); const chipPubkey = chip.getPublicKey().toString();
const wallet = `fuse.${owner}`, agent = `agent.${owner}`, vendor = `api.${owner}`;
const toNaj = (a: Action) => {
  switch (a.type) {
    case 'CreateAccount': return A.createAccount();
    case 'Transfer': return A.transfer(BigInt(a.params.deposit));
    case 'DeployContract': return A.deployContract(a.params.code);
    case 'FunctionCall': return A.functionCall(a.params.methodName, new TextEncoder().encode(JSON.stringify(a.params.args)), BigInt(a.params.gas), BigInt(a.params.deposit));
    case 'AddKey': { const p = a.params.accessKey.permission; return p === 'FullAccess' ? A.addFullAccessKey(PublicKey.fromString(a.params.publicKey)) : A.addFunctionCallAccessKey(PublicKey.fromString(a.params.publicKey), p.receiverId, p.methodNames ?? [], p.allowance ? BigInt(p.allowance) : undefined); }
  }
};
async function signAndSend(receiverId: string, acts: Action[]) {
  const pk = ownerKp.getPublicKey();
  const ak: any = await provider.query({ request_type: 'view_access_key', finality: 'optimistic', account_id: owner, public_key: pk.toString() });
  const block: any = await provider.viewBlock({ finality: 'final' });
  const tx = createTransaction(owner, pk, receiverId, BigInt(ak.nonce) + 1n, acts.map(toNaj), baseDecode(block.header.hash));
  const bytes = encodeTransaction(tx); const sig = ownerKp.sign(sha256(bytes)).signature;
  const out: any = await provider.sendTransaction(new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: KeyType.ED25519, data: sig }) }));
  const st = out.status; const ok = st && typeof st === 'object' && 'SuccessValue' in st;
  return { ok, hash: out.transaction?.hash as string, failure: ok ? undefined : JSON.stringify(st).slice(0, 300) };
}

// Tx A: wallet contract. 2.9 NEAR storage + 0.6 NEAR budget (the faucet gives 10 NEAR; keep it small)
const txA = await signAndSend(wallet, walletCreateActions({ owner, agent, chipPubkey, depositYocto: (3_500_000_000_000_000_000_000_000n).toString(), code, receivers: [vendor] }));
log(`Tx A create+deploy+new ${wallet}: ${txA.ok ? 'ok' : 'FAILED ' + txA.failure} https://testnet.nearblocks.io/txns/${txA.hash}`);
// Tx B: agent account with the chip key as its only key
const txB = await signAndSend(agent, agentCreateActions({ wallet, chipPubkey, depositYocto: (100_000_000_000_000_000_000_000n).toString(), methods: info.agent_methods }));
log(`Tx B create agent ${agent}: ${txB.ok ? 'ok' : 'FAILED ' + txB.failure} https://testnet.nearblocks.io/txns/${txB.hash}`);
// Tx C: registry
const registry = info.current?.registry ?? 'registry.fuse-v2-sdgt.testnet';
const txC = await signAndSend(wallet, registryActions(registry));
log(`Tx C set_registry ${registry}: ${txC.ok ? 'ok' : 'FAILED ' + txC.failure} https://testnet.nearblocks.io/txns/${txC.hash}`);

// 4. what a judge would check
const keys: any = await provider.query({ request_type: 'view_access_key_list', finality: 'final', account_id: agent });
const perm = keys.keys.map((k: any) => k.access_key.permission);
log(`agent keys: ${keys.keys.length} → ${JSON.stringify(perm).slice(0, 200)}`);
const view = async (m: string, args: any = {}) => provider.callFunction({ contractId: wallet, method: m, args, blockQuery: { finality: 'final' } } as any);
const state: any = await view('get_state'); const cfg: any = await view('get_config');
log(`wallet state: owner ${state.owner}, agent ${state.agent}, chip ${state.chip_pubkey_b58 === chipPubkey ? 'matches' : 'MISMATCH'}; registry ${cfg.registry}`);
// 5. the policy the wizard would send to the chip (shape only; the chip part is covered by setup-smoke.ts and the real board)
const pol = chipPolicy({ agent, wallet, methods: info.agent_methods, receivers: [vendor] });
log(`chip policy for the wizard: ${JSON.stringify(pol).length} bytes, receivers ${pol.receivers.join(',')}`);
const allOk = txA.ok && txB.ok && txC.ok && keys.keys.length === 1 && perm[0]?.FunctionCall && state.chip_pubkey_b58 === chipPubkey;
log(allOk ? 'WIZARD DRY RUN: all transactions accepted by testnet' : 'WIZARD DRY RUN: something failed, see above');
process.exit(allOk ? 0 : 1);
