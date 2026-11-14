// Pure logic for the onboarding wizard: names, amounts, policies, and the transactions the owner's wallet will sign.
// Everything here is testable without a wallet or a bridge. Amounts are yoctoNEAR strings built with BigInt.
import { nearToYocto } from './format';

export const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const PER_TX_CAP = '1000000000000000000000000';        // 1 NEAR
export const DAILY_CAP = '3000000000000000000000000';         // 3 NEAR
export const BUTTON_THRESHOLD = '500000000000000000000000';   // 0.5 NEAR
export const GAS_NEW = '100000000000000';                     // 100 Tgas
export const GAS_CALL = '30000000000000';                     // 30 Tgas

export function validAccountId(id: string): boolean { return id.length >= 2 && id.length <= 64 && ACCOUNT_RE.test(id); }
/** A sub-account of `owner`: valid, ≤ 64 chars, and ending in `.<owner>`. Returns a sentence or null. */
export function subAccountProblem(name: string, owner: string): string | null {
  if (!owner) return 'Connect a wallet first.';
  if (!name) return 'Enter a name.';
  if (name.length > 64) return 'Account ids are at most 64 characters.';
  if (!ACCOUNT_RE.test(name)) return 'Only lowercase letters, digits, - and _, separated by dots.';
  if (!name.endsWith(`.${owner}`) || name === `.${owner}`) return `Must be a sub-account of ${owner} (end with .${owner}).`;
  return null;
}
export function suggestNames(owner: string): { wallet: string; agent: string } { return { wallet: `fuse.${owner}`, agent: `agent.${owner}` }; }

/** Sum of NEAR decimal strings as yocto. '' or invalid parts count as 0; returns null when nothing parses. */
export function sumNear(...parts: string[]): string | null {
  let total = 0n, any = false;
  for (const p of parts) { const y = nearToYocto(p); if (y) { total += BigInt(y); any = true; } }
  return any ? total.toString() : null;
}

export interface WalletPolicy { receiver_allowlist: string[]; token_allowlist: string[]; per_tx_cap: string; daily_cap: string; chain_dest_allowlist: { chain: string; to: string }[]; chain_value_cap: string }
export interface ChipPolicyInput { agent: string; wallet: string; methods: string[]; receivers: string[]; tokens: string[]; per_tx_cap: string; button_threshold: string; chain_value_cap: string; chain_dests: { chain: string; to: string }[]; gas_cap: number; velocity_cap: number; velocity_window_ms: number }

export const walletPolicy = (receivers: string[]): WalletPolicy => ({ receiver_allowlist: receivers, token_allowlist: ['near'], per_tx_cap: PER_TX_CAP, daily_cap: DAILY_CAP, chain_dest_allowlist: [], chain_value_cap: '0' });
export const chipPolicy = (p: { agent: string; wallet: string; methods: string[]; receivers: string[] }): ChipPolicyInput => ({
  agent: p.agent, wallet: p.wallet, methods: p.methods, receivers: p.receivers, tokens: ['near'],
  per_tx_cap: PER_TX_CAP, button_threshold: BUTTON_THRESHOLD, chain_value_cap: '0', chain_dests: [], gas_cap: 300_000_000_000_000, velocity_cap: 20, velocity_window_ms: 600_000,
});
export const parseReceivers = (s: string): string[] => Array.from(new Set(s.split(/[\s,]+/).map(x => x.trim()).filter(Boolean)));

// Wallet-selector action shapes (plain objects; the selector serialises them).
export type Action =
  | { type: 'CreateAccount' }
  | { type: 'Transfer'; params: { deposit: string } }
  | { type: 'DeployContract'; params: { code: Uint8Array } }
  | { type: 'FunctionCall'; params: { methodName: string; args: object; gas: string; deposit: string } }
  | { type: 'AddKey'; params: { publicKey: string; accessKey: { permission: 'FullAccess' | { receiverId: string; allowance?: string; methodNames?: string[] } } } };

/** Tx A: create the wallet contract account, fund it, deploy, init. One transaction signed by the owner. */
export function walletCreateActions(p: { owner: string; agent: string; chipPubkey: string; depositYocto: string; code: Uint8Array; receivers: string[] }): Action[] {
  return [
    { type: 'CreateAccount' },
    { type: 'Transfer', params: { deposit: p.depositYocto } },
    { type: 'DeployContract', params: { code: p.code } },
    { type: 'FunctionCall', params: { methodName: 'new', args: { owner: p.owner, agent: p.agent, chip_pubkey: p.chipPubkey, policy: walletPolicy(p.receivers) }, gas: GAS_NEW, deposit: '0' } },
  ];
}
/** Tx B: create the agent account with the chip's key as its only key, scoped to the wallet contract's methods. */
export function agentCreateActions(p: { wallet: string; chipPubkey: string; depositYocto: string; methods: string[] }): Action[] {
  return [
    { type: 'CreateAccount' },
    { type: 'Transfer', params: { deposit: p.depositYocto } },
    { type: 'AddKey', params: { publicKey: p.chipPubkey, accessKey: { permission: { receiverId: p.wallet, methodNames: p.methods } } } },
  ];
}
/** Tx C (optional): point the wallet contract at the shared refusal registry. */
export const registryActions = (registry: string): Action[] => [{ type: 'FunctionCall', params: { methodName: 'set_registry', args: { registry }, gas: GAS_CALL, deposit: '0' } }];

/** Human lines for a transaction preview: what the wallet is about to ask the owner to sign. */
export function describeActions(actions: Action[], receiverId: string, near: (y: string) => string): string[] {
  return actions.map(a => {
    switch (a.type) {
      case 'CreateAccount': return `Create the account ${receiverId}`;
      case 'Transfer': return `Fund it with ${near(a.params.deposit)}`;
      case 'DeployContract': return `Deploy the Fuse wallet contract (${Math.round(a.params.code.byteLength / 1024)} KB)`;
      case 'FunctionCall': return `Call ${a.params.methodName} on ${receiverId}`;
      case 'AddKey': { const perm = a.params.accessKey.permission; return perm === 'FullAccess' ? 'Add a full-access key' : `Add the chip's key, limited to ${perm.methodNames?.join(', ') ?? 'any method'} on ${perm.receiverId}`; }
    }
  });
}

// Byte helpers (browser)
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const d = await crypto.subtle.digest('SHA-256', buf as BufferSource);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('');
}
export const randomNonce = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
export const toBase64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
export const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));
