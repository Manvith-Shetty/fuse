import type { LogEntry } from './types';

/** LED language (README): green blink = signed, red blink = refused, amber = waiting for the button, solid red = no heartbeat. */
export type LedState = 'idle' | 'signed' | 'refused' | 'button' | 'revoked';
export interface LedInput { latest: LogEntry | undefined; alive: boolean | null; now: number }

/** How long a signed/refused flash stays lit before the LED returns to its idle breathe. */
export const FLASH_MS = 4000;

const SIGNED = new Set(['signed', 'executed']);
const REFUSED = new Set(['refused', 'failed_onchain']);

/**
 * Pure reducer: the LED state is derived, never stored. `alive === null` means "heartbeat unknown yet" and reads as idle.
 * A flash decays after FLASH_MS; amber holds until a newer event resolves the button.
 */
export function deriveLed({ latest, alive, now }: LedInput): LedState {
  if (alive === false) return 'revoked';
  if (!latest) return 'idle';
  if (latest.type === 'button_required') return 'button';
  const age = now - new Date(latest.ts).getTime();
  if (Number.isNaN(age) || age > FLASH_MS) return 'idle';
  if (SIGNED.has(latest.type)) return 'signed';
  if (REFUSED.has(latest.type)) return 'refused';
  return 'idle';
}

/** The most recent entry that can drive the LED (proposed/nonce_retry bookkeeping is skipped). */
export function latestLedEvent(log: LogEntry[]): LogEntry | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (SIGNED.has(e.type) || REFUSED.has(e.type) || e.type === 'button_required' || e.type === 'AGENT_REVOKED' || e.type === 'chip_connected') return e;
  }
  return undefined;
}

export const LED_LABEL: Record<LedState, string> = {
  idle: 'idle, policy loaded',
  signed: 'signed',
  refused: 'refused',
  button: 'waiting for the button',
  revoked: 'no heartbeat: agent revoked',
};
