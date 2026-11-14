import 'dotenv/config';
import { z } from 'zod';
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
});
export type Config = z.infer<typeof schema>;

export function loadConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  const cfg = schema.parse({ ...process.env, ...overrides });
  if (/rpc\.testnet\.near\.org/.test(cfg.NEAR_RPC_URL)) {
    console.error('[fuse] rpc.testnet.near.org is deprecated (answers -429); using https://test.rpc.fastnear.com. Update NEAR_RPC_URL in your env file.');
    cfg.NEAR_RPC_URL = 'https://test.rpc.fastnear.com';
  }
  if (!cfg.DATA_DIR) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    cfg.DATA_DIR = path.resolve(here, '..', 'data');
  }
  return cfg;
}
export function explorerTx(cfg: Config, hash: string) {
  return cfg.NEAR_NETWORK === 'mainnet' ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
}
export function explorerAccount(cfg: Config, id: string) {
  return cfg.NEAR_NETWORK === 'mainnet' ? `https://nearblocks.io/address/${id}` : `https://testnet.nearblocks.io/address/${id}`;
}
