import { Chip } from '../components/Chip';
import { Page } from '../components/Page';
import { Reveal } from '../components/Reveal';
import { useCheck, useOnchain, useStatus } from '../hooks/useBridge';
import { Link } from '../lib/router';
import { isViewError } from '../lib/types';

const BEATS = [
  { n: '1', title: 'The agent proposes', line: 'It never holds a key. It can only ask.' },
  { n: '2', title: 'The chip decides', line: 'Raw bytes decoded in silicon, policy enforced, your thumb above a limit.' },
  { n: '3', title: 'The chain remembers', line: 'Signed refusal receipts, in a registry other agents consult.' },
];
const CANNOT = [
  'Transfer NEAR out of the agent account.',
  'Call any contract but its own wallet.',
  'Add, rotate or delete a key.',
  'Spend above the cap, per payment or per day.',
  'Sign anything once the cable is pulled.',
];

function Number_({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <div>
      <div className="font-display font-semibold text-[44px] sm:text-[56px] leading-none tracking-[-0.04em] tabular-nums text-ink">{value}</div>
      <div className="mt-2 text-[14px] text-ink-2">{label}</div>
    </div>
  );
}

export function Landing() {
  const { data: status } = useStatus();
  const { data: onchain } = useOnchain();
  const check = useCheck('attacker.testnet');
  const counts = onchain?.counts && !isViewError(onchain.counts) ? onchain.counts : null;
  const dash = <span className="text-ink-3">–</span>;
  const chips = check.data?.distinct_chips;

  return (
    <Page>
      {/* (a) hero */}
      <section className="wrap pt-10 pb-20 sm:pt-20 sm:pb-28">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1.1fr_1fr] lg:gap-16">
          <div>
            <p className="text-[14px] text-ink-2">Fuse · the hardware budget key for AI agents</p>
            <h1 className="mt-4 text-[44px] sm:text-[64px] lg:text-[72px] text-ink">Give your agent a budget, not your keys.</h1>
            <p className="lead mt-6 max-w-[560px]">A chip on your desk holds the only key of your agent's NEAR account. It reads every transaction itself, says no to anything outside the policy, asks for your thumb above a limit, and is revoked by pulling the cable.</p>
            <div className="mt-8 flex flex-wrap items-center gap-5">
              <Link to="/live" className="btn-cta no-underline">See it live</Link>
              <Link to="/red-team" className="link text-[15px]">Try to rob it →</Link>
            </div>
          </div>
          <div className="mx-auto w-full max-w-[460px] lg:max-w-none"><Chip state="idle" /></div>
        </div>
      </section>

      {/* (b) three beats */}
      <Reveal className="wrap py-16 sm:py-24 border-t border-line">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-3 sm:gap-8">
          {BEATS.map(b => (
            <div key={b.n}>
              <div className="font-display font-semibold text-[40px] leading-none tracking-[-0.04em] text-ink-3">{b.n}</div>
              <h2 className="mt-4 text-[24px] text-ink">{b.title}</h2>
              <p className="mt-2 text-[15px] text-ink-2 max-w-[300px]">{b.line}</p>
            </div>
          ))}
        </div>
      </Reveal>

      {/* (c) proof strip */}
      <Reveal className="wrap py-16 sm:py-24 border-t border-line">
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-4 sm:gap-8">
          <Number_ value={counts ? counts.payments : dash} label="payments executed" />
          <Number_ value={counts ? counts.refusals : dash} label="refusals onchain, verified" />
          <Number_ value={typeof chips === 'number' ? chips : dash} label="chips that refused attacker.testnet" />
          <Number_ value={<span className="text-[28px] sm:text-[36px] font-mono font-medium tracking-[0.02em]">{status?.mode ?? '–'}</span>} label={status?.mode === 'HARDWARE' ? 'a real chip, right now' : status?.mode === 'SIMULATED' ? 'software simulator, labelled' : 'bridge not reached'} />
        </div>
      </Reveal>

      {/* (d) what it cannot do */}
      <Reveal className="wrap py-16 sm:py-24 border-t border-line">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_1.2fr]">
          <h2 className="text-[32px] sm:text-[40px] text-ink">What it cannot do.</h2>
          <ol className="divide-y divide-line">
            {CANNOT.map(l => <li key={l} className="py-4 text-[17px] sm:text-[19px] text-ink-2 first:pt-0 last:pb-0">{l}</li>)}
          </ol>
        </div>
      </Reveal>
    </Page>
  );
}
