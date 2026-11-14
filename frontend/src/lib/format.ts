// Amount and identifier formatting. Amounts are yoctoNEAR decimal strings: BigInt only, never Number.
export const YOCTO = 10n ** 24n;

/** yoctoNEAR -> "1.2345" (trailing zeros trimmed, at most `maxFrac` decimals, truncated not rounded). */
export function formatYocto(atomic: string | number | bigint | null | undefined, maxFrac = 4): string {
  if (atomic === undefined || atomic === null || atomic === '') return '–';
  let v: bigint;
  try { v = BigInt(typeof atomic === 'number' ? Math.trunc(atomic) : atomic); } catch { return String(atomic); }
  const neg = v < 0n; if (neg) v = -v;
  const whole = (v / YOCTO).toString();
  let frac = (v % YOCTO).toString().padStart(24, '0').slice(0, maxFrac).replace(/0+$/, '');
  if (frac === '' && v % YOCTO !== 0n && maxFrac > 0) frac = '0'.repeat(maxFrac); // dust below the displayed precision
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
/** Token-aware label: NEAR amounts are converted, other tokens are shown in atomic units. */
export function formatAmount(atomic: string | number | bigint | null | undefined, token?: string): string {
  if (token && token !== 'near') return `${atomic ?? '–'} ${token}`;
  const s = formatYocto(atomic);
  return s === '–' ? s : `${s} NEAR`;
}
/** "0.1" NEAR -> "100000000000000000000000". Returns '' for invalid input. Exact, up to 24 decimals. */
export function nearToYocto(near: string): string {
  const t = near.trim();
  const m = /^(\d*)(?:\.(\d{0,24}))?$/.exec(t);
  if (!m || t === '' || t === '.') return '';
  return (BigInt(m[1] || '0') * YOCTO + BigInt((m[2] || '').padEnd(24, '0'))).toString();
}
/** Integer percent of `part` over `whole`, clamped 0..100. null when not computable. */
export function percentOf(part: string | undefined, whole: string | undefined): number | null {
  try {
    if (part === undefined || whole === undefined) return null;
    const w = BigInt(whole); if (w <= 0n) return null;
    const p = Number((BigInt(part) * 100n) / w);
    return Math.max(0, Math.min(100, p));
  } catch { return null; }
}
export function short(s: string | undefined | null, n = 8): string {
  if (!s) return '';
  return s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`;
}
export function nsToDate(ns?: string | number | null): Date | null {
  if (ns === undefined || ns === null || ns === '') return null;
  try { return new Date(Number(BigInt(String(ns)) / 1_000_000n)); } catch { return null; }
}
export function timeOf(ts?: string | number | Date | null): string {
  if (ts === undefined || ts === null || ts === '') return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function dateTimeOf(ts?: string | number | Date | null): string {
  if (ts === undefined || ts === null || ts === '') return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
export function explorerTx(network: string | undefined, hash: string): string {
  return network === 'mainnet' ? `https://nearblocks.io/txns/${hash}` : `https://testnet.nearblocks.io/txns/${hash}`;
}
export function explorerAccount(network: string | undefined, id: string): string {
  return network === 'mainnet' ? `https://nearblocks.io/address/${id}` : `https://testnet.nearblocks.io/address/${id}`;
}
export function tgas(gas?: number | string | null): string {
  if (gas === undefined || gas === null) return '–';
  try { return `${(BigInt(gas) / 1_000_000_000_000n).toString()} Tgas`; } catch { return String(gas); }
}
export function minutes(ms?: number): string {
  if (ms === undefined || ms === null) return '–';
  const m = ms / 60000;
  return Number.isInteger(m) ? `${m} min` : `${m.toFixed(1)} min`;
}
