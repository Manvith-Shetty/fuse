import { useState } from 'react';
import { ModeBadge } from '../components/ModeBadge';
import { Page } from '../components/Page';
import { VerdictWord } from '../components/VerdictWord';
import { useCheck, useStatus } from '../hooks/useBridge';
import { errorMessage, isNotAvailable } from '../lib/api';
import { codeName } from '../lib/codes';
import { dateTimeOf, explorerAccount, nsToDate } from '../lib/format';

export function CounterpartyPage() {
  const { data: status } = useStatus();
  const [input, setInput] = useState('attacker.testnet');
  const [account, setAccount] = useState('attacker.testnet');
  const check = useCheck(account);
  const v = check.data;
  const last = v?.last_ts ? (/^\d{16,}$/.test(String(v.last_ts)) ? nsToDate(String(v.last_ts)) : new Date(v.last_ts as string | number)) : null;

  return (
    <Page>
      <div className="wrap pt-6 pb-10 sm:pt-12">
        <h1 className="text-[36px] sm:text-[48px] text-ink">Counterparty</h1>
        <p className="lead mt-3 max-w-[560px]">The shared registry weighs signed refusal receipts from many chips. Ask it about an account before your agent pays it.</p>
        <form className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center max-w-[640px]" onSubmit={e => { e.preventDefault(); setAccount(input.trim()); }}>
          <label htmlFor="acct" className="sr-only">NEAR account</label>
          <input id="acct" className="field" value={input} onChange={e => setInput(e.target.value)} placeholder="seller.testnet" autoComplete="off" spellCheck={false} />
          <button type="submit" className="btn-cta shrink-0" disabled={!input.trim() || check.isFetching}>{check.isFetching ? 'Asking…' : 'Check'}</button>
        </form>
        <div className="mt-3"><ModeBadge mode={status?.mode} /></div>

        {account && check.isError && <p className="mt-10 text-[15px] text-amber">{isNotAvailable(check.error) ? 'The registry check is not available on this bridge.' : errorMessage(check.error)}</p>}
        {v && (
          <section className="mt-12" aria-label="Verdict">
            <VerdictWord verdict={v.verdict} wordKey={account} />
            <div className="mt-5 max-w-[640px] text-[17px] text-ink-2 space-y-1.5">
              <p><span className="mono text-[15px] text-ink">{account}</span> <a className="link text-[14px]" href={explorerAccount(status?.network, account)} target="_blank" rel="noreferrer">explorer ↗</a></p>
              <p>{v.reports ?? 0} report{v.reports === 1 ? '' : 's'} from {v.distinct_chips ?? 0} chip{v.distinct_chips === 1 ? '' : 's'} and {v.distinct_reporters ?? 0} reporter{v.distinct_reporters === 1 ? '' : 's'}{typeof v.bound_reports === 'number' ? `, ${v.bound_reports} bound to this receiver` : ''}.</p>
              {v.top_codes && v.top_codes.length > 0 && <p>Most common reason: <span className="mono text-[15px]">{codeName(v.top_codes[0]![0])}</span>.</p>}
              {last && !isNaN(last.getTime()) && <p>Last report {dateTimeOf(last)}.</p>}
              {v.manual && <p className="text-red">Curated note: {String(v.manual)}</p>}
              {v.registry && <p className="text-[13px] text-ink-3">registry <span className="mono">{String(v.registry)}</span></p>}
            </div>
          </section>
        )}
      </div>
    </Page>
  );
}
