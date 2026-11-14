import { useMutation } from '@tanstack/react-query';
import { ModeBadge } from '../components/ModeBadge';
import { Page } from '../components/Page';
import { useOnchain, useStatus } from '../hooks/useBridge';
import { api, errorMessage, isNotAvailable } from '../lib/api';
import { codeName } from '../lib/codes';
import { dateTimeOf, formatAmount, nsToDate, short } from '../lib/format';
import { isViewError, type Refusal } from '../lib/types';

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function AuditPage() {
  const { data: status } = useStatus();
  const { data: onchain } = useOnchain();
  const counts = onchain?.counts && !isViewError(onchain.counts) ? onchain.counts : null;
  const cpol = onchain?.policy && !isViewError(onchain.policy) ? onchain.policy : null;
  const spent = typeof onchain?.daily_spent === 'string' ? onchain.daily_spent : undefined;
  const refusals: Refusal[] = Array.isArray(onchain?.refusals) ? [...onchain!.refusals!].reverse().slice(0, 10) : [];
  const audit = useMutation({ mutationFn: async () => { const d = await api.audit(); download(`fuse-audit-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`, d); return d; } });
  const n = (v: React.ReactNode) => <div className="font-display font-semibold text-[40px] leading-none tracking-[-0.04em] tabular-nums text-ink">{v}</div>;

  return (
    <Page>
      <div className="wrap pt-6 pb-10 sm:pt-12">
        <h1 className="text-[36px] sm:text-[48px] text-ink">Audit</h1>
        <p className="lead mt-3 max-w-[560px]">Everything the chip signed or refused is onchain. The bridge's audit file adds receipt verification, policy and firmware hashes.</p>
        <div className="mt-10 grid grid-cols-2 gap-8 sm:grid-cols-4 max-w-[760px]">
          <div>{n(counts?.payments ?? '–')}<div className="mt-2 text-[14px] text-ink-2">payments</div></div>
          <div>{n(counts?.refusals ?? '–')}<div className="mt-2 text-[14px] text-ink-2">refusal receipts</div></div>
          <div>{n(counts?.chain_sigs ?? '–')}<div className="mt-2 text-[14px] text-ink-2">chain signatures</div></div>
          <div>{n(<span className="text-[26px]">{formatAmount(spent, 'near')}</span>)}<div className="mt-2 text-[14px] text-ink-2">spent today{cpol?.daily_cap ? ` of ${formatAmount(cpol.daily_cap, 'near')}` : ''}</div></div>
        </div>
        <div className="mt-10 flex flex-wrap items-center gap-4">
          <button type="button" className="btn-cta" onClick={() => audit.mutate()} disabled={audit.isPending}>{audit.isPending ? 'Fetching…' : 'Download audit.json'}</button>
          <ModeBadge mode={status?.mode} />
          {audit.isError && <span className="text-[14px] text-amber">{isNotAvailable(audit.error) ? 'GET /audit is not served by this bridge.' : errorMessage(audit.error)}</span>}
          {audit.isSuccess && <span className="text-[14px] text-accent-deep">Downloaded.</span>}
        </div>

        <h2 className="mt-16 text-[22px] text-ink">Last refusal receipts</h2>
        <p className="mt-1 text-[14px] text-ink-2">Each one is ed25519-signed by the chip and verified by the contract before it is stored.</p>
        {refusals.length === 0 ? <p className="mt-4 text-[14px] text-ink-3">{onchain ? 'None yet.' : 'Loading…'}</p> : (
          <div className="mt-4 overflow-x-auto">
            <table className="tbl min-w-[560px]">
              <thead><tr><th>receipt</th><th>when</th><th>code</th><th>receiver</th><th>refused tx</th></tr></thead>
              <tbody>
                {refusals.map(r => (
                  <tr key={r.id}>
                    <td className="mono">#{r.counter}</td>
                    <td className="text-ink-2 whitespace-nowrap">{dateTimeOf(nsToDate(r.timestamp_ns))}</td>
                    <td className="mono text-red">{codeName(r.code)}</td>
                    <td className="mono">{r.receiver || <span className="text-ink-3">–</span>}</td>
                    <td className="mono text-ink-2" title={r.tx_hash_hex}>{short(r.tx_hash_hex, 8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Page>
  );
}
