import { useEffect, useRef, useState } from 'react';
import { Link } from '../lib/router';

// The pages behind the story: what a judge, an auditor or the owner opens. One header entry, five rows, each with the
// one sentence that says why you would go there.
const ITEMS = [
  { to: '/audit', title: 'Audit', hint: 'every payment and refusal, re-verified' },
  { to: '/counterparty', title: 'Counterparty', hint: 'ask the registry about any account' },
  { to: '/policy', title: 'Policy', hint: 'chip and contract, side by side' },
  { to: '/setup', title: 'Setup', hint: 'create a Fuse with your wallet' },
  { to: '/settings', title: 'Settings', hint: 'the bridge accounts and network' },
];

export function DetailsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" className="link-quiet inline-flex items-center gap-1" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
        Details <span aria-hidden="true" className={`inline-block transition-transform ${open ? 'rotate-180' : ''}`}>↓</span>
      </button>
      {open && (
        <nav role="menu" aria-label="Details" className="absolute right-0 mt-3 w-[280px] rounded-[14px] border border-line bg-surface p-2 shadow-[var(--shadow-card)] z-20">
          {ITEMS.map(i => (
            <Link key={i.to} to={i.to} role="menuitem" className="block rounded-[10px] px-3 py-2.5 no-underline hover:bg-paper focus-visible:bg-paper" onClick={() => setOpen(false)}>
              <span className="block text-[14px] text-ink">{i.title}</span>
              <span className="block text-[12px] text-ink-2">{i.hint}</span>
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
