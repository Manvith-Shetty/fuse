import 'dotenv/config';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const schema = z.object({
  NEAR_NETWORK: z.string().default('testnet'),
  NEAR_RPC_URL: z.string().default('https://test.rpc.fastnear.com'), // rpc.testnet.near.org is deprecated (returns -429)
  OWNER_ACCOUNT: z.string().default(''),
  WALLET_CONTRACT: z.string().default('fuse.example.testnet'),
  AGENT_ACCOUNT: z.string().default('agent.example.testnet'),
  TOKEN_CONTRACT: z.string().default(''),
  SERIAL_PORT: z.string().default(''),
  SERIAL_BAUD: z.coerce.number().default(115200),
  SIMULATE_CHIP: z.coerce.number().default(0),
  SIM_BUTTON: z.enum(['press', 'deny']).default('press'),
  SIM_BUTTON_DELAY_MS: z.coerce.number().default(1500),
  BRIDGE_PORT: z.coerce.number().default(7777),
  DATA_DIR: z.string().default(''),
  // v2
  REGISTRY_CONTRACT: z.string().default(''),          // shared refusal registry (fuse-registry); empty = no counterparty check
  FUSE_FW_ARG: z.string().default(''),                // '1' / '0': add the fw attestation arg to pay/request_chain_sig (default: on for HARDWARE)
  SIM_DECISION_SIGNER_SEED: z.string().default(''),   // SIMULATED only: hex seed of a dev "TEE" key that signs decisions in tests
});
export type Config = z.infer<typeof schema>;

// Keys the UI may manage. They live in <DATA_DIR>/config.json and override the env file, so production setups never
// touch .env: the setup wizard connects the owner's wallet, creates the accounts, and POSTs these here.
export const UI_KEYS = ['NEAR_NETWORK', 'NEAR_RPC_URL', 'OWNER_ACCOUNT', 'WALLET_CONTRACT', 'AGENT_ACCOUNT', 'REGISTRY_CONTRACT'] as const;
export type UiKey = (typeof UI_KEYS)[number];
const dataDirDefault = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const configFilePath = (dataDir?: string) => path.join(dataDir || process.env.DATA_DIR || dataDirDefault(), 'config.json');
export function readConfigFile(dataDir?: string): Partial<Record<UiKey, string>> {
  try { const j = JSON.parse(fs.readFileSync(configFilePath(dataDir), 'utf8')); const out: Partial<Record<UiKey, string>> = {}; for (const k of UI_KEYS) if (typeof j[k] === 'string') out[k] = j[k]; return out; } catch { return {}; }
}
export function writeConfigFile(patch: Partial<Record<UiKey, string>>, dataDir?: string) {
  const file = configFilePath(dataDir); fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = readConfigFile(dataDir); const next: Record<string, string> = { ...cur };
  for (const k of UI_KEYS) if (patch[k] !== undefined) { if (patch[k] === '') delete next[k]; else next[k] = patch[k]!; }
  fs.writeFileSync(file, JSON.stringify({ ...next, _note: 'written by the Fuse setup UI; overrides .env; no secrets live here' }, null, 2));
  return next;
}
export const defaultRpc = (network: string) => network === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com';

export function loadConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  const fileCfg = readConfigFile(overrides.DATA_DIR || process.env.DATA_DIR);
  const cfg = schema.parse({ ...process.env, ...fileCfg, ...overrides });
  if (/rpc\.testnet\.near\.org/.test(cfg.NEAR_RPC_URL)) {
    console.error('[fuse] rpc.testnet.near.org is deprecated (answers -429); using https://test.rpc.fastnear.com. Update NEAR_RPC_URL in your env file.');
    cfg.NEAR_RPC_URL = 'https://test.rpc.fastnear.com';
  }
  // A mainnet setup whose RPC still points at testnet (env default) gets the mainnet default instead.
  if (cfg.NEAR_NETWORK === 'mainnet' && /test\.rpc\.fastnear|testnet/.test(cfg.NEAR_RPC_URL)) cfg.NEAR_RPC_URL = defaultRpc('mainnet');
  if (!cfg.DATA_DIR) cfg.DATA_DIR = dataDirDefault();
  return cfg;
}
export function explorerTx(cfg: Config, hash: string) {
  return cfg.NEAR_NETWORK === 'mainnet' ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
}
export function explorerAccount(cfg: Config, id: string) {
  return cfg.NEAR_NETWORK === 'mainnet' ? `https://nearblocks.io/address/${id}` : `https://testnet.nearblocks.io/address/${id}`;
}
