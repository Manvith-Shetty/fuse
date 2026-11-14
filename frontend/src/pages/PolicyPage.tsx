import type { ReactNode } from 'react';
import { ModeBadge } from '../components/ModeBadge';
import { Page } from '../components/Page';
import { useOnchain, useStatus } from '../hooks/useBridge';
import { formatAmount, short } from '../lib/format';
import { isViewError, type AgentKey } from '../lib/types';

type Cmp = 'same' | 'differs' | 'chip only' | 'contract only';
const norm = (v: unknown): string | undefined => v === undefined || v === null ? undefined : Array.isArray(v) ? v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).sort().join('|') : String(v);
const cmp = (a: unknown, b: unknown): Cmp | null => { const x = norm(a), y = norm(b); if (x === undefined && y === undefined) return null; if (x === undefined) return 'contract only'; if (y === undefined) return 'chip only'; return x === y ? 'same' : 'differs'; };
const list = (xs?: string[] | null) => xs === undefined || xs === null ? undefined : xs.length ? xs.join(', ') : 'none';
const near = (s?: string | null) => (s === undefined || s === null ? undefined : formatAmount(s, 'near'));

export function PolicyPage() {
  const { data: status } = useStatus();
  const { data: onchain } = useOnchain();
  const pol = status?.policy ?? null;
  const chip = status?.chip && !status.chip.error ? status.chip : null;
  const cpol = onchain?.policy && !isViewError(onchain.policy) ? onchain.policy : null;
  const state = onchain?.state && !isViewError(onchain.state) ? onchain.state : null;
  const keys: AgentKey[] = Array.isArray(onchain?.agent_keys) ? onchain!.agent_keys! : [];
  const fc = keys.length === 1 && typeof keys[0]!.access_key.permission === 'object' ? keys[0]!.access_key.permission.FunctionCall : null;

  const rows: { field: string; chip?: ReactNode; contract?: ReactNode; c: Cmp | null }[] = [
    { field: 'chip key', chip: chip?.pubkey && <span className="mono" title={chip.pubkey}>{short(chip.pubkey, 10)}</span>, contract: state?.chip_pubkey_b58 && <span className="mono" title={state.chip_pubkey_b58}>{short(state.chip_pubkey_b58, 10)}</span>, c: cmp(chip?.pubkey, state?.chip_pubkey_b58) },
    { field: 'agent account', chip: pol?.agent, contract: state?.agent, c: cmp(pol?.agent, state?.agent) },
    { field: 'methods', chip: list(pol?.methods), contract: fc ? list(fc.method_names) : undefined, c: cmp(pol?.methods, fc?.method_names) },
    { field: 'pays only', chip: list(pol?.receivers), contract: list(cpol?.receiver_allowlist), c: cmp(pol?.receivers, cpol?.receiver_allowlist) },
    { field: 'tokens', chip: list(pol?.tokens), contract: list(cpol?.token_allowlist), c: cmp(pol?.tokens, cpol?.token_allowlist) },
    { field: 'per payment', chip: near(pol?.per_tx_cap), contract: near(cpol?.per_tx_cap), c: cmp(pol?.per_tx_cap, cpol?.per_tx_cap) },
    { field: 'thumb above', chip: near(pol?.button_threshold), c: pol ? 'chip only' : null },
    { field: 'per day', contract: near(cpol?.daily_cap), c: cpol ? 'contract only' : null },
    { field: 'velocity', chip: pol && `${pol.velocity_cap} signatures / ${Math.round(pol.velocity_window_ms / 60000)} min`, c: pol ? 'chip only' : null },
    { field: 'paused', contract: state ? (state.paused ? 'yes' : 'no') : undefined, c: state ? 'contract only' : null },
  ];
  const differs = rows.filter(r => r.c === 'differs').length;

  return (
    <Page>
      <div className="wrap pt-6 pb-10 sm:pt-12">
        <h1 className="text-[36px] sm:text-[48px] text-ink">Policy</h1>
        <p className="lead mt-3 max-w-[600px]">Two copies, two enforcers. The chip's policy is owner-signed and lives in its flash; the contract's lives onchain. On the fields they share, they should agree.</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px] text-ink-2"><ModeBadge mode={status?.mode} />{chip?.policy_hash && <span>chip policy hash <span className="mono">{chip.policy_hash}</span>{chip.policy_seq !== undefined ? ` · seq ${chip.policy_seq}` : ''}</span>}<span className={differs ? 'text-red' : 'text-accent-deep'}>{differs ? `${differs} field${differs > 1 ? 's' : ''} differ` : 'all shared fields agree'}</span></div>
        <div className="mt-8 overflow-x-auto">
          <table className="tbl min-w-[640px]">
            <thead><tr><th>field</th><th>chip</th><th>contract</th><th></th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.field}>
                  <td className="text-ink">{r.field}</td>
                  <td className={r.c === 'differs' ? 'text-red' : 'text-ink-2'}>{r.chip ?? <span className="text-ink-3">–</span>}</td>
                  <td className={r.c === 'differs' ? 'text-red' : 'text-ink-2'}>{r.contract ?? <span className="text-ink-3">–</span>}</td>
                  <td className={`text-[13px] ${r.c === 'differs' ? 'text-red' : r.c === 'same' ? 'text-accent-deep' : 'text-ink-3'}`}>{r.c ?? 'not available'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!pol && <p className="mt-4 text-[14px] text-ink-3">Chip policy not available: {status?.chip?.error ?? 'bridge or chip not reached'}.</p>}
      </div>
    </Page>
  );
}
