import { describe, it, expect } from 'vitest';
import { humanizeSummary, sentences } from './sentences';
import type { LogEntry } from './types';

const t = (s: number) => new Date(1_800_000_000_000 + s * 1000).toISOString();
const e = (sec: number, type: string, extra: Partial<LogEntry> = {}): LogEntry => ({ ts: t(sec), type, mode: 'HARDWARE', ...extra });

describe('humanizeSummary', () => {
  it('reads the chip summaries', () => {
    expect(humanizeSummary('pay 1000000000000000000000 near -> api.x.testnet')).toBe('0.001 NEAR to api.x.testnet');
    expect(humanizeSummary('record refusal #18')).toBe('refusal receipt #18');
    expect(humanizeSummary(undefined)).toBeUndefined();
    expect(humanizeSummary('something else')).toBe('something else');
  });
});

describe('sentences', () => {
  const pay = { receiver: 'api.x.testnet', token: 'near', amount: '1000000000000000000000' };
  const attack = { receiver: 'attacker.testnet', token: 'near', amount: '500000000000000000000000' };
  const log: LogEntry[] = [
    e(0, 'chip_connected'),
    e(1, 'proposed', { mode: 'BRIDGE', method: 'pay', args: pay, hash: 'H1' }),
    e(2, 'signed', { method: 'pay', hash: 'H1', summary: 'pay 1000000000000000000000 near -> api.x.testnet', button: false }),
    e(3, 'executed', { mode: 'BRIDGE', method: 'pay', hash: 'H1', explorer: 'https://x/txns/H1' }),
    e(4, 'proposed', { mode: 'BRIDGE', method: 'pay', args: attack, hash: 'H2' }),
    e(5, 'refused', { method: 'pay', hash: 'H2', code: 'RECEIVER_NOT_ALLOWED', detail: 'receiver attacker.testnet', counter: 18 }),
    e(6, 'proposed', { mode: 'BRIDGE', method: 'record_refusal', args: { counter: 18, code: 13 }, hash: 'H3' }),
    e(7, 'signed', { method: 'record_refusal', hash: 'H3', summary: 'record refusal #18' }),
    e(8, 'executed', { mode: 'BRIDGE', method: 'record_refusal', hash: 'H3', explorer: 'https://x/txns/H3' }),
    e(9, 'button_required', { hash: 'H4', timeout_ms: 30000 }),
    e(10, 'AGENT_REVOKED', { mode: 'BRIDGE' }),
  ];
  const s = sentences(log, 8);
  it('is newest first and folds the plumbing', () => {
    expect(s.map(x => x.text)).toEqual([
      'Chip unplugged · agent revoked, nothing can be signed',
      'Waiting for your thumb · 30 s',
      'Refused 0.5 NEAR to attacker.testnet · RECEIVER_NOT_ALLOWED · receipt #18 onchain',
      'Paid 0.001 NEAR to api.x.testnet',
      'Chip connected',
    ]);
  });
  it('links the refusal to its onchain receipt and the payment to its tx', () => {
    expect(s[2]?.href).toBe('https://x/txns/H3');
    expect(s[2]?.tone).toBe('block');
    expect(s[3]?.href).toBe('https://x/txns/H1');
    expect(s[3]?.mode).toBe('HARDWARE');
  });
  it('shows a signed-but-not-yet-executed payment as broadcasting', () => {
    const partial = [e(1, 'proposed', { mode: 'BRIDGE', method: 'pay', args: pay, hash: 'H9' }), e(2, 'signed', { method: 'pay', hash: 'H9', summary: 'pay 1000000000000000000000 near -> api.x.testnet', button: true })];
    expect(sentences(partial)[0]?.text).toBe('Chip signed 0.001 NEAR to api.x.testnet after your thumb · broadcasting');
  });
  it('respects the limit and handles numeric codes', () => {
    expect(sentences(log, 2)).toHaveLength(2);
    const num = [e(0, 'refused', { method: 'pay', hash: 'Z', code: 13, counter: 1 })];
    expect(sentences(num)[0]?.text).toBe('Refused pay · RECEIVER_NOT_ALLOWED · receipt #1');
  });
});
