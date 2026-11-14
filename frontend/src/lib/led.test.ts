import { describe, it, expect } from 'vitest';
import { deriveLed, latestLedEvent, FLASH_MS } from './led';
import type { LogEntry } from './types';

const NOW = 1_800_000_000_000;
const at = (msAgo: number, type: string, extra: Partial<LogEntry> = {}): LogEntry => ({ ts: new Date(NOW - msAgo).toISOString(), type, mode: 'SIMULATED', ...extra });

describe('deriveLed', () => {
  it('is solid red whenever the heartbeat is dead, whatever the last event', () => {
    expect(deriveLed({ latest: at(100, 'signed'), alive: false, now: NOW })).toBe('revoked');
    expect(deriveLed({ latest: undefined, alive: false, now: NOW })).toBe('revoked');
  });
  it('breathes idle with no events or an unknown heartbeat', () => {
    expect(deriveLed({ latest: undefined, alive: true, now: NOW })).toBe('idle');
    expect(deriveLed({ latest: undefined, alive: null, now: NOW })).toBe('idle');
  });
  it('flashes green on signed/executed and red on refused/failed_onchain', () => {
    expect(deriveLed({ latest: at(50, 'signed'), alive: true, now: NOW })).toBe('signed');
    expect(deriveLed({ latest: at(50, 'executed'), alive: true, now: NOW })).toBe('signed');
    expect(deriveLed({ latest: at(50, 'refused', { code: 'RECEIVER_NOT_ALLOWED' }), alive: true, now: NOW })).toBe('refused');
    expect(deriveLed({ latest: at(50, 'failed_onchain'), alive: true, now: NOW })).toBe('refused');
  });
  it('lets a flash decay back to idle', () => {
    expect(deriveLed({ latest: at(FLASH_MS - 1, 'signed'), alive: true, now: NOW })).toBe('signed');
    expect(deriveLed({ latest: at(FLASH_MS + 1, 'signed'), alive: true, now: NOW })).toBe('idle');
    expect(deriveLed({ latest: at(60_000, 'refused'), alive: true, now: NOW })).toBe('idle');
  });
  it('holds amber while the button is pending, regardless of age', () => {
    expect(deriveLed({ latest: at(30_000, 'button_required'), alive: true, now: NOW })).toBe('button');
  });
  it('treats unknown or bookkeeping events as idle', () => {
    expect(deriveLed({ latest: at(10, 'proposed'), alive: true, now: NOW })).toBe('idle');
    expect(deriveLed({ latest: at(10, 'chip_connected'), alive: true, now: NOW })).toBe('idle');
    expect(deriveLed({ latest: { ts: 'garbage', type: 'signed', mode: 'SIMULATED' }, alive: true, now: NOW })).toBe('idle');
  });
});

describe('latestLedEvent', () => {
  it('skips proposed/nonce_retry and returns the newest driver', () => {
    const log = [at(500, 'button_required'), at(400, 'signed'), at(300, 'proposed'), at(200, 'nonce_retry')];
    expect(latestLedEvent(log)?.type).toBe('signed');
    expect(latestLedEvent([])).toBeUndefined();
  });
});
