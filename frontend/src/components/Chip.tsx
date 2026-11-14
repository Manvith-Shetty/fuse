import type { LedState } from '../lib/led';
import { LedDot } from './Led';

/** The product: a small dark board with a cable port, one button and one LED. Drawn, not photographed. */
export function Chip({ state = 'idle', flashKey = '', className = '' }: { state?: LedState; flashKey?: string; className?: string }) {
  return (
    <svg viewBox="0 0 360 220" className={`block w-full h-auto [filter:drop-shadow(0_26px_28px_rgba(17,17,17,0.22))] ${className}`} role="img" aria-label="Fuse chip">
      <defs>
        <linearGradient id="chip-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="rgba(255,255,255,0.06)" />
          <stop offset="1" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>
      {/* cable stub */}
      <rect x="2" y="96" width="34" height="28" rx="9" fill="var(--board)" stroke="var(--board-edge)" />
      <rect x="10" y="104" width="18" height="12" rx="4" fill="rgba(255,255,255,0.12)" />
      {/* board */}
      <rect x="30" y="40" width="300" height="140" rx="18" fill="var(--board)" />
      <rect x="30" y="40" width="300" height="140" rx="18" fill="url(#chip-sheen)" stroke="var(--board-edge)" />
      {/* pads */}
      {Array.from({ length: 9 }).map((_, i) => <rect key={i} x={70 + i * 22} y="46" width="10" height="5" rx="1.5" fill="rgba(255,255,255,0.14)" />)}
      {Array.from({ length: 9 }).map((_, i) => <rect key={i} x={70 + i * 22} y="169" width="10" height="5" rx="1.5" fill="rgba(255,255,255,0.14)" />)}
      {/* module */}
      <rect x="196" y="76" width="88" height="68" rx="8" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.1)" />
      <rect x="206" y="86" width="40" height="48" rx="5" fill="rgba(255,255,255,0.07)" />
      {/* the button */}
      <rect x="256" y="92" width="22" height="36" rx="6" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.16)" />
      <rect x="261" y="99" width="12" height="22" rx="4" fill="rgba(0,0,0,0.5)" />
      {/* silk */}
      <text x="60" y="160" fontFamily="JetBrains Mono, monospace" fontSize="11" fill="rgba(255,255,255,0.35)" letterSpacing="2">FUSE</text>
      <text x="196" y="160" fontFamily="JetBrains Mono, monospace" fontSize="8" fill="rgba(255,255,255,0.22)" letterSpacing="1">ESP32-S3</text>
      <text x="246" y="72" fontFamily="JetBrains Mono, monospace" fontSize="7" fill="rgba(255,255,255,0.22)" letterSpacing="1">THUMB</text>
      {/* the LED */}
      <LedDot state={state} cx={118} cy={110} r={9} flashKey={flashKey} />
    </svg>
  );
}
