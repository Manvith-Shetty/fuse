import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Page } from '../components/Page';
import { api, errorMessage, isNotAvailable } from '../lib/api';
import { Link } from '../lib/router';
import type { ConfigKeys, ConfigPatch } from '../lib/types';

const KEYS: { k: ConfigKeys; label: string; hint: string }[] = [
  { k: 'NEAR_NETWORK', label: 'Network', hint: 'testnet or mainnet' },
  { k: 'NEAR_RPC_URL', label: 'RPC URL', hint: 'leave empty for the network default' },
  { k: 'OWNER_ACCOUNT', label: 'Owner account', hint: 'your wallet' },
  { k: 'WALLET_CONTRACT', label: 'Wallet contract', hint: 'holds the funds and the onchain policy' },
  { k: 'AGENT_ACCOUNT', label: 'Agent account', hint: 'the chip key is its only key' },
  { k: 'REGISTRY_CONTRACT', label: 'Refusal registry', hint: 'optional, shared evidence' },
];

export function SettingsPage() {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ['config'], queryFn: api.config, retry: false });
  const [form, setForm] = useState<ConfigPatch>({});
  useEffect(() => { if (cfg.data) setForm(Object.fromEntries(KEYS.map(({ k }) => [k, cfg.data.effective[k] ?? ''])) as ConfigPatch); }, [cfg.data]);
  const save = useMutation({
    mutationFn: () => { const patch: ConfigPatch = {}; for (const { k } of KEYS) { const v = (form[k] ?? '').trim(); if (v !== (cfg.data?.effective[k] ?? '')) patch[k] = v; } return api.saveConfig(patch); },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['config'] }); void qc.invalidateQueries({ queryKey: ['status'] }); void qc.invalidateQueries({ queryKey: ['onchain'] }); },
  });
  const dirty = !!cfg.data && KEYS.some(({ k }) => (form[k] ?? '') !== (cfg.data!.effective[k] ?? ''));

  return (
    <Page>
      <div className="wrap pt-6 pb-10 sm:pt-12">
        <h1 className="text-[36px] sm:text-[48px] text-ink">Settings</h1>
        <p className="lead mt-3 max-w-[560px]">What the bridge uses right now. Saving writes <span className="mono text-[15px]">bridge/data/config.json</span> and switches the bridge at once. No keys live here; the <Link to="/setup" className="link">setup wizard</Link> fills these in for you.</p>
        {cfg.isError && <p className="mt-8 text-[15px] text-amber">{isNotAvailable(cfg.error) ? 'The bridge is not reachable, so there is nothing to edit.' : errorMessage(cfg.error)}</p>}
        {cfg.data && (
          <form className="mt-10 max-w-[640px] space-y-6" onSubmit={e => { e.preventDefault(); save.mutate(); }}>
            {KEYS.map(({ k, label, hint }) => (
              <div key={k}>
                <label htmlFor={k} className="block text-[14px] text-ink">{label} <span className="text-ink-3">· {hint}</span></label>
                {k === 'NEAR_NETWORK' ? (
                  <select id={k} className="field mt-1.5" value={form[k] ?? 'testnet'} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}><option value="testnet">testnet</option><option value="mainnet">mainnet</option></select>
                ) : (
                  <input id={k} className="field mt-1.5 mono text-[14px]" value={form[k] ?? ''} onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))} spellCheck={false} autoComplete="off" />
                )}
                {cfg.data.file[k] !== undefined && cfg.data.file[k] !== cfg.data.effective[k] && <p className="mt-1 text-[12px] text-ink-3">file says {cfg.data.file[k] || '(empty)'}</p>}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-4">
              <button type="submit" className="btn-cta" disabled={!dirty || save.isPending}>{save.isPending ? 'Saving…' : 'Save to the bridge'}</button>
              {save.isSuccess && <span className="text-[14px] text-accent-deep">Saved. The bridge now uses these values.</span>}
              {save.isError && <span className="text-[14px] text-red">{errorMessage(save.error)}</span>}
            </div>
          </form>
        )}
      </div>
    </Page>
  );
}
