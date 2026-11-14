import { describe, it, expect } from 'vitest';
import { agentCreateActions, chipPolicy, describeActions, parseReceivers, subAccountProblem, sumNear, suggestNames, validAccountId, walletCreateActions, toBase64, fromBase64 } from './setup';
import { formatAmount } from './format';

describe('names', () => {
  it('validates NEAR account ids', () => {
    expect(validAccountId('alice.testnet')).toBe(true);
    expect(validAccountId('fuse.fuse-hack-2026.testnet')).toBe(true);
    expect(validAccountId('Alice.testnet')).toBe(false);
    expect(validAccountId('a..b')).toBe(false);
    expect(validAccountId('x'.repeat(65))).toBe(false);
  });
  it('requires sub-accounts of the owner', () => {
    expect(subAccountProblem('fuse.alice.testnet', 'alice.testnet')).toBeNull();
    expect(subAccountProblem('fuse.bob.testnet', 'alice.testnet')).toMatch(/sub-account of alice.testnet/);
    expect(subAccountProblem('', 'alice.testnet')).toBe('Enter a name.');
    expect(subAccountProblem('fuse.alice.testnet', '')).toBe('Connect a wallet first.');
    expect(subAccountProblem('Fuse.alice.testnet', 'alice.testnet')).toMatch(/lowercase/);
  });
  it('suggests fuse.<owner> and agent.<owner>', () => expect(suggestNames('o.near')).toEqual({ wallet: 'fuse.o.near', agent: 'agent.o.near' }));
  it('parses receiver lists', () => expect(parseReceivers(' api.x.testnet, api.x.testnet\nseller.testnet ')).toEqual(['api.x.testnet', 'seller.testnet']));
});

describe('amounts', () => {
  it('adds NEAR decimals exactly', () => {
    expect(sumNear('2.9', '3')).toBe('5900000000000000000000000');
    expect(sumNear('0.1')).toBe('100000000000000000000000');
    expect(sumNear('', 'abc')).toBeNull();
  });
});

describe('transactions', () => {
  const code = new Uint8Array(278 * 1024);
  it('builds the wallet creation transaction in order', () => {
    const a = walletCreateActions({ owner: 'o.testnet', agent: 'agent.o.testnet', chipPubkey: 'ed25519:K', depositYocto: '5900000000000000000000000', code, receivers: ['api.testnet'] });
    expect(a.map(x => x.type)).toEqual(['CreateAccount', 'Transfer', 'DeployContract', 'FunctionCall']);
    const call = a[3]!; if (call.type !== 'FunctionCall') throw new Error();
    expect(call.params.methodName).toBe('new');
    expect(call.params.args).toMatchObject({ owner: 'o.testnet', agent: 'agent.o.testnet', chip_pubkey: 'ed25519:K', policy: { receiver_allowlist: ['api.testnet'], token_allowlist: ['near'], per_tx_cap: '1000000000000000000000000', daily_cap: '3000000000000000000000000', chain_value_cap: '0' } });
    expect(call.params.deposit).toBe('0');
  });
  it('gives the agent exactly one scoped key from birth', () => {
    const a = agentCreateActions({ wallet: 'fuse.o.testnet', chipPubkey: 'ed25519:K', depositYocto: '100000000000000000000000', methods: ['pay', 'record_refusal', 'request_chain_sig'] });
    expect(a.map(x => x.type)).toEqual(['CreateAccount', 'Transfer', 'AddKey']);
    const key = a[2]!; if (key.type !== 'AddKey') throw new Error();
    expect(key.params.accessKey.permission).toEqual({ receiverId: 'fuse.o.testnet', methodNames: ['pay', 'record_refusal', 'request_chain_sig'] });
  });
  it('describes what the wallet will ask', () => {
    const a = agentCreateActions({ wallet: 'fuse.o.testnet', chipPubkey: 'ed25519:K', depositYocto: '100000000000000000000000', methods: ['pay'] });
    expect(describeActions(a, 'agent.o.testnet', y => formatAmount(y, 'near'))).toEqual(['Create the account agent.o.testnet', 'Fund it with 0.1 NEAR', "Add the chip's key, limited to pay on fuse.o.testnet"]);
  });
  it('builds the chip policy with the fixed limits', () => {
    const p = chipPolicy({ agent: 'agent.o.testnet', wallet: 'fuse.o.testnet', methods: ['pay'], receivers: ['api.testnet'] });
    expect(p.button_threshold).toBe('500000000000000000000000');
    expect(p.velocity_cap).toBe(20);
    expect(p.tokens).toEqual(['near']);
  });
  it('round-trips base64', () => { const b = new Uint8Array([0, 1, 2, 250, 255]); expect(fromBase64(toBase64(b))).toEqual(b); });
});
