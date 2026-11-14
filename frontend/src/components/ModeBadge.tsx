/** Quiet, honest, on every page: which chip answered. */
export function ModeBadge({ mode, className = '' }: { mode?: string | null; className?: string }) {
  const word = mode === 'HARDWARE' ? 'hardware' : mode === 'SIMULATED' ? 'simulated' : 'offline';
  const dot = mode === 'HARDWARE' ? 'bg-accent' : mode === 'SIMULATED' ? 'bg-amber' : 'bg-ink-3';
  const title = mode === 'HARDWARE' ? 'A real ESP32-S3 holds the key' : mode === 'SIMULATED' ? 'Software simulator: same decoder and policy, a software key' : 'The bridge is not reachable';
  return (
    <span className={`mode ${className}`} title={title}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />{word}
    </span>
  );
}
