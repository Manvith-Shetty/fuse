// One-command testnet bootstrap for judges and screeners (no hardware, no secrets in the repo):
//   1. create an owner account from the faucet, 2. create fuse/agent/api sub-accounts, 3. deploy + init the wallet contract,
//   4. enrol the SIMULATED chip as the agent account's only key, 5. write bridge/.env and the simulator policy.
// Usage: npx tsx scripts/bootstrap.ts <owner-prefix>     e.g. npx tsx scripts/bootstrap.ts fuse-judge-$RANDOM
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeDir = path.resolve(here, '..');
const repo = path.resolve(bridgeDir, '..');
// Prefer a local build; fall back to the prebuilt artifact committed in the repo (the bytes deployed on testnet,
// checksum in contracts/fuse-wallet/res/SHA256SUMS), so the simulator path needs only Node and near-cli-rs.
const builtWasm = path.join(repo, 'contracts/fuse-wallet/target/near/fuse_wallet.wasm');
const prebuiltV2 = path.join(repo, 'contracts/fuse-wallet/res/fuse_wallet_v2.wasm');
const prebuiltWasm = fs.existsSync(prebuiltV2) ? prebuiltV2 : path.join(repo, 'contracts/fuse-wallet/res/fuse_wallet.wasm');
const wasm = process.env.FUSE_WASM ?? (fs.existsSync(builtWasm) ? builtWasm : prebuiltWasm);
// FUSE_ENV_OUT / FUSE_DATA_DIR let a judge or a test keep this deployment apart from a live .env (run the bridge with DOTENV_CONFIG_PATH=<that file>).
const envOut = process.env.FUSE_ENV_OUT ?? path.join(bridgeDir, '.env');
const dataDir = process.env.FUSE_DATA_DIR ?? path.join(bridgeDir, 'data');
process.env.DOTENV_CONFIG_PATH = envOut;
const prefix = process.argv[2];
if (!prefix || !/^[a-z0-9-]{3,40}$/.test(prefix)) { console.error('usage: npx tsx scripts/bootstrap.ts <owner-prefix (lowercase, digits, dashes)>'); process.exit(1); }
if (!fs.existsSync(wasm)) { console.error(`missing ${wasm}. Build it (cd contracts/fuse-wallet && cargo near build non-reproducible-wasm) or restore contracts/fuse-wallet/res/fuse_wallet.wasm`); process.exit(1); }
console.log(`contract wasm: ${wasm} (${wasm === prebuiltWasm ? 'prebuilt artifact from the repo' : 'local build'})`);

const owner = `${prefix}.testnet`, wallet = `fuse.${owner}`, agent = `agent.${owner}`, api = `api.${owner}`;
// Windows: npm installs a near.cmd shim that execFileSync cannot spawn; use the real binary near-cli-rs ships, or FUSE_NEAR_BIN.
function nearBin(): string {
  if (process.env.FUSE_NEAR_BIN) return process.env.FUSE_NEAR_BIN;
  if (process.platform !== 'win32') return 'near';
  try { const root = execFileSync('npm.cmd', ['root', '-g'], { encoding: 'utf8', shell: true }).trim(); const exe = path.join(root, 'near-cli-rs', 'node_modules', '.bin_real', 'near.exe'); if (fs.existsSync(exe)) return exe; } catch { /* fall through */ }
  return 'near.cmd';
}
const NEAR = nearBin();
const near = (...args: string[]) => { console.log('$ near', args.join(' ').slice(0, 160)); return execFileSync(NEAR, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', shell: NEAR.endsWith('.cmd') }); };
const net = ['network-config', 'testnet'];
// Run the bridge CLI through node + tsx directly: `npx` is a .cmd shim on Windows that execFileSync cannot spawn.
const TSX = path.join(bridgeDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = (cmd: string) => execFileSync(process.execPath, [TSX, 'src/cli.ts', cmd], { cwd: bridgeDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

if (process.env.FUSE_BOOTSTRAP_SKIP_ACCOUNTS) console.log(`\n== 1-2. skipping account creation for ${owner} (FUSE_BOOTSTRAP_SKIP_ACCOUNTS)`);
else {
  console.log(`\n== 1. owner ${owner} from the faucet`);
  near('account', 'create-account', 'sponsor-by-faucet-service', owner, 'autogenerate-new-keypair', 'save-to-legacy-keychain', ...net, 'create');
  console.log(`\n== 2. sub-accounts`);
  for (const [sub, amt] of [[wallet, '4 NEAR'], [agent, '1 NEAR'], [api, '0.5 NEAR']] as const)
    near('account', 'create-account', 'fund-myself', sub, amt, 'autogenerate-new-keypair', 'save-to-legacy-keychain', 'sign-as', owner, ...net, 'sign-with-legacy-keychain', 'send');
}

console.log(`\n== 3. simulated chip identity`);
const envFile = envOut;
const env = `NEAR_NETWORK=testnet
NEAR_RPC_URL=${process.env.NEAR_RPC_URL ?? 'https://test.rpc.fastnear.com'}
OWNER_ACCOUNT=${owner}
WALLET_CONTRACT=${wallet}
AGENT_ACCOUNT=${agent}
TOKEN_CONTRACT=
SERIAL_PORT=
SERIAL_BAUD=115200
SIMULATE_CHIP=1
SIM_BUTTON=press
SIM_BUTTON_DELAY_MS=1500
BRIDGE_PORT=7777
DATA_DIR=${dataDir}
REGISTRY_CONTRACT=${process.env.REGISTRY_CONTRACT ?? ''}
NEAR_AI_API_KEY=${process.env.NEAR_AI_API_KEY ?? ''}
NEAR_AI_BASE_URL=https://cloud-api.near.ai/v1
NEAR_AI_MODEL=zai-org/GLM-5.1-FP8
`;
fs.writeFileSync(envFile, env);
fs.mkdirSync(dataDir, { recursive: true });
for (const f of ['sim-chip-state.json', 'log.jsonl']) { const p = path.join(dataDir, f); if (fs.existsSync(p)) fs.renameSync(p, p + '.bak-' + Date.now()); }
fs.writeFileSync(path.join(dataDir, 'sim-policy.json'), JSON.stringify({
  agent, wallet, methods: ['pay', 'record_refusal', 'request_chain_sig'], receivers: [api], tokens: ['near'],
  per_tx_cap: '1000000000000000000000000', button_threshold: '500000000000000000000000', chain_value_cap: '1000000000000000',
  chain_dests: [{ chain: 'eth-sepolia', to: '0x000000000000000000000000000000000000dead' }], gas_cap: 300000000000000, velocity_cap: 20, velocity_window_ms: 600000,
}, null, 2));
const hello = JSON.parse(cli('hello'));
console.log('chip pubkey', hello.pubkey, 'mode', hello.mode);

console.log(`\n== 4. deploy + init ${wallet}`);
const init = { owner, agent, chip_pubkey: hello.pubkey, policy: { receiver_allowlist: [api], token_allowlist: ['near'], per_tx_cap: '1000000000000000000000000', daily_cap: '3000000000000000000000000', chain_dest_allowlist: [{ chain: 'eth-sepolia', to: '0x000000000000000000000000000000000000dead' }], chain_value_cap: '1000000000000000' } };
near('contract', 'deploy', wallet, 'use-file', wasm, 'with-init-call', 'new', 'json-args', JSON.stringify(init), 'prepaid-gas', '100 Tgas', 'attached-deposit', '0 NEAR', ...net, 'sign-with-legacy-keychain', 'send');

console.log(`\n== 5. enrol: the chip key becomes the agent account's only key`);
const enrolled = cli('enroll');
console.log(enrolled);
console.log(`\nDone. Next:\n  npm run fuse -- keys\n  npm run fuse -- pay -r ${api} -t near -a 100000000000000000000000 -m "api call"\n  npm run fuse -- pay -r attacker.testnet -t near -a 1000000000000000000000   # refused, receipt onchain\n  npm run fuse -- serve   # then open the dashboard`);
