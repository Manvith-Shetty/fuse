import { useCallback, useEffect, useRef, useState } from 'react';
import type { NetworkId } from '@near-wallet-selector/core';
import { getSelector } from '../lib/wallet';
import { Link } from '../lib/router';

// The owner's wallet, in the header, as every dapp does it: "Connect wallet" when signed out, the account with a small
// menu when signed in. Lazy on purpose: the wallet libraries load only when a previous session exists or on click, so the
// story pages stay light. The network follows the bridge (testnet or mainnet); the wizard uses the same selector.
const SESSION_KEY = 'near-wallet-selector:selectedWalletId';
const short = (id: string) => (id.length > 24 ? `${id.slice(0, 10)}…${id.slice(-8)}` : id);

export function WalletButton({ network, owner }: { network: NetworkId; owner?: string | null }) {
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const sub = useRef<{ unsubscribe(): void } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const attach = useCallback(async () => {
    const { selector } = await getSelector(network);
    sub.current?.unsubscribe();
    sub.current = selector.store.observable.subscribe(st => { const a = st.accounts.find(x => x.active) ?? st.accounts[0]; setAccountId(a?.accountId ?? null); });
  }, [network]);

  // Resume a previous session without loading wallet code for first-time visitors.
  useEffect(() => {
    let had = false; try { had = !!localStorage.getItem(SESSION_KEY); } catch { /* storage blocked: treat as signed out */ }
    if (had) attach().catch(() => setAccountId(null)); else setAccountId(null);
    return () => { sub.current?.unsubscribe(); sub.current = null; };
  }, [attach]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const connect = async () => {
    setBusy(true);
    try { await attach(); const { modal } = await getSelector(network); modal.show(); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    setOpen(false);
    const { selector } = await getSelector(network);
    if (selector.isSignedIn()) { const w = await selector.wallet(); await w.signOut(); }
    setAccountId(null);
  };

  if (!accountId) {
    return (
      <button type="button" className="btn-quiet !py-1.5 !px-3.5 text-[14px] whitespace-nowrap" onClick={connect} disabled={busy} aria-label="Connect your NEAR wallet">
        {busy ? 'Opening…' : <><span className="sm:hidden">Connect</span><span className="hidden sm:inline">Connect wallet</span></>}
      </button>
    );
  }
  const isOwner = !!owner && owner === accountId;
  return (
    <div ref={wrapRef} className="relative">
      <button type="button" className="btn-quiet !py-1.5 !px-3.5 text-[14px] inline-flex items-center gap-2" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} title={accountId}>
        <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
        <span className="font-mono text-[13px]">{short(accountId)}</span>
        {isOwner && <span className="text-[11px] uppercase tracking-[0.08em] text-ink-2">owner</span>}
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 min-w-[220px] rounded-[12px] border border-line bg-surface px-4 py-3 shadow-[var(--shadow-card)] text-[14px] z-20">
          <div className="text-ink-2 text-[12px] mb-2">{network} · {isOwner ? 'owner of this bridge' : owner ? `bridge owner is ${short(owner)}` : 'no bridge owner set yet'}</div>
          <nav className="flex flex-col gap-2" aria-label="Wallet">
            <Link to="/setup" className="link-quiet" onClick={() => setOpen(false)}>Set up a Fuse</Link>
            <Link to="/settings" className="link-quiet" onClick={() => setOpen(false)}>Bridge settings</Link>
            <button type="button" className="link-quiet text-left" onClick={disconnect}>Disconnect</button>
          </nav>
        </div>
      )}
    </div>
  );
}
