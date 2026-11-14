import { EventEmitter } from 'node:events';
import type { Policy } from './policy.js';
import type { CodeName } from './codes.js';

export interface HelloResult { pubkey: string; pubkey_hex: string; fw: string; fw_sha256?: string; policy_hash: string; counter: number; last_nonce: number | string; mode: 'HARDWARE' | 'SIMULATED'; board?: string }
export type SignResult =
  | { ok: true; hash: string; sig: string; summary: string; button: boolean; decoded?: any }
  | { ok: false; hash: string; code: CodeName; code_num?: number; detail: string; receipt?: string; counter?: number; decoded?: any };

export interface ChipEvents { button_required: (info: { id: string; summary: string; timeout_ms: number }) => void; disconnected: () => void; raw: (line: string) => void }

// The chip is the trust anchor. The bridge talks to it through this interface and never sees a private key.
export abstract class Chip extends EventEmitter {
  abstract readonly mode: 'HARDWARE' | 'SIMULATED';
  abstract hello(): Promise<HelloResult>;
  abstract sign(txBytes: Uint8Array, hint: string): Promise<SignResult>;
  abstract ping(): Promise<{ pong: true; uptime_ms: number }>;
  abstract policyGet(): Promise<{ policy: Policy; policy_hash: string }>;
  abstract policySet(policy: Policy): Promise<{ ok: boolean; policy_hash?: string; code?: CodeName; detail?: string }>;
  abstract decode(txBytes: Uint8Array): Promise<any>;
  abstract close(): Promise<void>;
}
