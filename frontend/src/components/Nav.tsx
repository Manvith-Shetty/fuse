import { useStatus } from '../hooks/useBridge';
import { useEvents } from '../hooks/events';
import { Link } from '../lib/router';
import { ModeBadge } from './ModeBadge';
import { WalletButton } from './WalletButton';
import { DetailsMenu } from './DetailsMenu';

export function Nav() {
  const { data: status, isError } = useStatus();
  const { link } = useEvents();
  // undefined = not known yet (no badge); null = bridge not reachable
  const mode = status?.mode ?? (isError || link === 'offline' ? null : undefined);
  const network = status?.network === 'mainnet' ? 'mainnet' : 'testnet';
  return (
    <header className="wrap flex items-center justify-between py-5">
      <Link to="/" className="inline-flex items-center gap-2.5 no-underline text-ink" aria-label="Fuse, home">
        <span className="inline-block h-[18px] w-[18px] rounded-[5px] bg-board relative" aria-hidden="true"><span className="absolute left-1/2 top-1/2 h-[6px] w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent" /></span>
        <span className="font-display font-semibold text-[18px] tracking-[-0.02em]">Fuse</span>
      </Link>
      <nav aria-label="Pages" className="flex items-center gap-3 sm:gap-5 text-[14px] whitespace-nowrap">
        <Link to="/live" className="link-quiet ml-3 sm:ml-0">Live</Link>
        <Link to="/red-team" className="link-quiet">Red team</Link>
        <DetailsMenu />
        {mode !== undefined && <ModeBadge mode={mode} className="hidden sm:inline-flex" />}
        <WalletButton network={network} owner={status?.accounts?.owner ?? null} />
      </nav>
    </header>
  );
}
