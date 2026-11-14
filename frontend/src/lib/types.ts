// Shapes from bridge/src/server.ts, bridge/src/log.ts, bridge/src/fuse.ts, agent/src/serve.ts and docs/v2-spec.md.
export type Mode = 'HARDWARE' | 'SIMULATED' | 'BRIDGE';
export type Verdict = 'allow' | 'warn' | 'block';

export interface LogEntry {
  ts: string; type: string; mode: Mode;
  method?: string; hash?: string; explorer?: string; code?: string | number; detail?: string; counter?: number;
  summary?: string; button?: boolean; hint?: string; timeout_ms?: number; error?: string; args?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface Heartbeat { alive: boolean; misses: number; lastOk: number; revokedSince: number; mode?: Mode; ts?: string }
export interface ChipHello {
  pubkey?: string; pubkey_hex?: string; fw?: string; fw_sha256?: string; policy_hash?: string; counter?: number; last_nonce?: string | number;
  board?: string; proto?: number; owner_pubkey?: string | null; policy_seq?: number; receipt_v?: number; error?: string;
}
export interface ChipPolicy {
  agent: string; wallet: string; methods: string[]; receivers: string[]; tokens: string[];
  per_tx_cap: string; button_threshold: string; chain_value_cap: string;
  chain_dests: { chain: string; to: string }[]; gas_cap: number; velocity_cap: number; velocity_window_ms: number;
  require_fw_arg?: boolean; decision_signers?: string[]; approve_button?: boolean;
}
export interface Status {
  mode: 'HARDWARE' | 'SIMULATED';
  chip: ChipHello | null;
  policy: ChipPolicy | null;
  heartbeat: Heartbeat;
  accounts: { agent: string; wallet: string; agent_explorer: string; wallet_explorer: string; owner?: string | null; registry?: string | null };
  network: string;
}
export interface ViewError { error: string }
export const isViewError = (v: unknown): v is ViewError => !!v && typeof v === 'object' && 'error' in (v as object) && typeof (v as ViewError).error === 'string';

export interface ContractPolicy {
  receiver_allowlist?: string[]; token_allowlist?: string[]; per_tx_cap?: string; daily_cap?: string;
  chain_dest_allowlist?: { chain: string; to: string }[]; chain_value_cap?: string;
}
export interface ContractState { owner?: string; agent?: string; chip_pubkey_hex?: string; chip_pubkey_b58?: string; paused?: boolean; chain_sig_contract?: string; last_refusal_counter?: number }
export interface Payment { id: number; receiver: string; token: string; amount: string; memo?: string; timestamp_ns?: string; block_height?: string; status?: string; tx_hash?: string }
export interface Refusal { id: number; tx_hash_hex: string; code: number; counter: number; receipt_sig_b64: string; timestamp_ns?: string; block_height?: string; receiver?: string; version?: number }
export interface AgentKey { public_key: string; access_key: { nonce: number; permission: 'FullAccess' | { FunctionCall: { allowance: string | null; method_names: string[]; receiver_id: string } } } }
export interface ContractConfig { allowed_fw?: string[]; approvers?: string[]; quorum_threshold?: string; registry?: string | null }
export interface Onchain {
  policy?: ContractPolicy | ViewError; state?: ContractState | ViewError; daily_spent?: string | ViewError;
  counts?: { payments: number; refusals: number; chain_sigs: number } | ViewError;
  payments?: Payment[] | ViewError; refusals?: Refusal[] | ViewError; agent_keys?: AgentKey[] | ViewError;
  pending?: Payment[] | ViewError; config?: ContractConfig | ViewError;
}

export interface CheckVerdict {
  verdict: Verdict; reports?: number; distinct_reporters?: number; distinct_chips?: number; bound_reports?: number; trusted_reports?: number;
  last_ts?: string | number | null; manual?: string | null; top_codes?: [number, number][]; registry?: string;
  [k: string]: unknown;
}
export interface PayRequest { receiver: string; token: string; amount: string; memo?: string }
export interface PayResult {
  ok: boolean; mode?: string; hash?: string; explorer?: string; summary?: string; button?: boolean; code?: string; detail?: string; error?: string;
  refusal?: { counter: number; recorded?: boolean; hash?: string; explorer?: string; error?: string };
  counterparty?: CheckVerdict; http?: number;
}

// agent/src/serve.ts
export interface AttemptVerdict { receiver: string; amount: string; event: 'REFUSED' | 'PAID' | 'PENDING' | string; code?: string; counter?: number; hash?: string; explorer?: string; refusal_explorer?: string; counterparty?: string }
export interface Attempt { id: string; ts: string; text_preview?: string; provider?: string; labelled?: string; outcome?: string; verdicts: AttemptVerdict[]; ms?: number }
export interface AttemptEvent { type?: string; [k: string]: unknown }
export interface AttemptResult { attempt?: Attempt; events?: AttemptEvent[]; provider?: { provider?: string; [k: string]: unknown } | string; outcome?: string; mode?: string; error?: string }
export interface Attempts { total_attempts?: number; refused?: number; paid?: number; pending?: number; by_code?: Record<string, number>; recent?: Attempt[]; cooldown_ms?: number }

// bridge setup / config / owner-signed policy (bridge/src/server.ts)
export interface SetupArtifact { name: string; bytes?: number; sha256?: string; url?: string; missing?: boolean }
export interface SetupInfo {
  chip: { pubkey: string; fw_sha256?: string; proto?: number; owner_pubkey?: string | null; policy_seq?: number; mode: string } | null;
  network: string; rpc: string; current: { agent: string; wallet: string; agent_explorer?: string; wallet_explorer?: string };
  config_file: Record<string, string>; ui_keys: string[]; agent_methods: string[]; artifacts: SetupArtifact[];
  suggest_pattern: { wallet: string; agent: string; approver?: string };
  costs: { wallet_storage_near: string; agent_min_near: string; note?: string };
  chain_sig_contract?: string;
}
export type ConfigKeys = 'NEAR_NETWORK' | 'NEAR_RPC_URL' | 'OWNER_ACCOUNT' | 'WALLET_CONTRACT' | 'AGENT_ACCOUNT' | 'REGISTRY_CONTRACT';
export type ConfigPatch = Partial<Record<ConfigKeys, string>>;
export interface ConfigResponse { file: Record<string, string>; effective: Record<ConfigKeys, string>; path?: string; ok?: boolean; accounts?: { agent: string; wallet: string } }
export interface PolicyMessage { seq: number; message: string; policy_hash: string; recipient: string; scheme: 'nep413' }
export interface PolicyAuth { scheme: 'nep413'; seq: number; nonce: string; recipient: string; owner_pubkey: string; owner_sig: string; callback_url?: string }
export interface PolicySetResult { ok: boolean; policy_hash?: string; policy_seq?: number; owner_pubkey?: string; code?: string; detail?: string; error?: string }
