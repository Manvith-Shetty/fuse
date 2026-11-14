import { EventEmitter } from 'node:events';
import type { Policy } from './policy.js';
import type { CodeName } from './codes.js';

export interface HelloResult {
  pubkey: string; pubkey_hex: string; fw: string; fw_sha256?: string; policy_hash: string; counter: number; last_nonce: number | string;
  mode: 'HARDWARE' | 'SIMULATED'; board?: string;
  // protocol v2 (docs/v2-spec.md 2): absent on a v1 chip
  proto?: number; owner_pubkey?: string | null; policy_seq?: number; receipt_v?: number;
}
// An attested model decision (NEAR AI Cloud response signature, ed25519). The chip verifies the envelope; see spec 2.3.
export interface DecisionEnvelope { text: string; sig: string; signer: string; resp?: string }
// Owner authorisation for policy_set (spec 2.2). Two schemes over the same owner key:
//  raw:    ed25519 over sha256("FUSE_POLICY_V1" || sha256(policy) || seq_le)                 (keychain / CLI)
//  nep413: ed25519 over sha256(borsh(tag 2^31+413, message, nonce[32], recipient, callback))   (browser wallets, NEP-413 signMessage)
//          with message = "FUSE_POLICY_V1:<sha256(policy) hex>:<seq>"
export interface PolicyAuth { seq: number; owner_pubkey?: string; owner_sig: string; scheme?: 'raw' | 'nep413'; nonce?: string; recipient?: string; callback_url?: string }

export type SignResult =
  | { ok: true; hash: string; sig: string; summary: string; button: boolean; decoded?: any; decision?: 'none' | 'envelope' | 'bound' }
  | { ok: false; hash: string; code: CodeName; code_num?: number; detail: string; receipt?: string; counter?: number; decoded?: any; receipt_v?: number; receiver?: string };

export interface PolicySetResult { ok: boolean; policy_hash?: string; policy_seq?: number; owner_pubkey?: string; code?: CodeName; detail?: string }

export interface ChipEvents { button_required: (info: { id: string; summary: string; timeout_ms: number }) => void; disconnected: () => void; raw: (line: string) => void }

// The chip is the trust anchor. The bridge talks to it through this interface and never sees a private key.
export abstract class Chip extends EventEmitter {
  abstract readonly mode: 'HARDWARE' | 'SIMULATED';
  abstract hello(): Promise<HelloResult>;
  abstract sign(txBytes: Uint8Array, hint: string, decision?: DecisionEnvelope): Promise<SignResult>;
  abstract ping(): Promise<{ pong: true; uptime_ms: number }>;
  abstract policyGet(): Promise<{ policy: Policy; policy_hash: string }>;
  abstract policySet(policy: Policy, auth?: PolicyAuth): Promise<PolicySetResult>;
  abstract decode(txBytes: Uint8Array): Promise<any>;
  abstract close(): Promise<void>;
}
