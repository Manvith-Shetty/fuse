import { describe, it, expect } from 'vitest';
import { formatYocto, formatAmount, nearToYocto, percentOf, short, nsToDate, explorerTx } from './format';

describe('formatYocto', () => {
  it('converts whole NEAR', () => expect(formatYocto('1000000000000000000000000')).toBe('1'));
  it('keeps fractions without rounding and trims zeros', () => {
    expect(formatYocto('100000000000000000000000')).toBe('0.1');
    expect(formatYocto('1721000000000000000000000')).toBe('1.721');
    expect(formatYocto('123456789000000000000000000')).toBe('123.4567');
  });
  it('never loses precision on values above 2^53', () => {
    expect(formatYocto('987654321987654321987654321')).toBe('987.6543');
    expect(formatYocto(10n ** 30n)).toBe('1000000');
  });
  it('marks dust below the displayed precision', () => expect(formatYocto('1')).toBe('0.0000'));
  it('handles missing and garbage input', () => {
    expect(formatYocto(undefined)).toBe('–');
    expect(formatYocto(null)).toBe('–');
    expect(formatYocto('abc')).toBe('abc');
  });
  it('labels tokens', () => {
    expect(formatAmount('500000000000000000000000', 'near')).toBe('0.5 NEAR');
    expect(formatAmount('42', 'usdc.fakes.testnet')).toBe('42 usdc.fakes.testnet');
  });
});

describe('nearToYocto', () => {
  it('converts decimals exactly', () => {
    expect(nearToYocto('0.1')).toBe('100000000000000000000000');
    expect(nearToYocto('1')).toBe('1000000000000000000000000');
    expect(nearToYocto('0.000000000000000000000001')).toBe('1');
    expect(nearToYocto(' 2.5 ')).toBe('2500000000000000000000000');
  });
  it('rejects invalid input', () => {
    expect(nearToYocto('')).toBe('');
    expect(nearToYocto('.')).toBe('');
    expect(nearToYocto('1e5')).toBe('');
    expect(nearToYocto('-1')).toBe('');
    expect(nearToYocto('0.1234567890123456789012345')).toBe('');
  });
  it('round-trips with formatYocto', () => expect(formatYocto(nearToYocto('0.6'))).toBe('0.6'));
});

describe('helpers', () => {
  it('percentOf clamps and tolerates bad input', () => {
    expect(percentOf('1721000000000000000000000', '3000000000000000000000000')).toBe(57);
    expect(percentOf('9', '3')).toBe(100);
    expect(percentOf('1', '0')).toBeNull();
    expect(percentOf(undefined, '1')).toBeNull();
    expect(percentOf('x', '1')).toBeNull();
  });
  it('short keeps both ends', () => {
    expect(short('CxpuNBs7d4mEW6dk9Jn2V8q1u9V2fGFE2G4oNgroPgQ3', 6)).toBe('CxpuNB…roPgQ3');
    expect(short('abc', 6)).toBe('abc');
  });
  it('nsToDate handles nanosecond strings', () => {
    expect(nsToDate('1794578984262726052')?.getTime()).toBe(1794578984262);
    expect(nsToDate('')).toBeNull();
  });
  it('explorer links follow the network', () => {
    expect(explorerTx('testnet', 'h')).toBe('https://testnet.nearblocks.io/txns/h');
    expect(explorerTx('mainnet', 'h')).toBe('https://nearblocks.io/txns/h');
  });
});
