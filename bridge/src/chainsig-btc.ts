// Bitcoin leg of Chain Signatures: address derivation and balance for the wallet contract's derived key.
// Signing goes the same way as Sepolia (chip -> wallet contract -> v1.signer MPC); this file only derives and prepares.
// Networks: btc-testnet4 (mempool.space testnet4 API) and btc-mainnet (not used; mainnet spending needs the human's yes).
import { chainAdapters, contracts } from 'chainsig.js';

export const BTC_CHAINS: Record<string, { network: 'testnet' | 'mainnet'; path: string; mempool: string; addr: (a: string) => string; tx: (h: string) => string }> = {
  'btc-testnet4': { network: 'testnet', path: 'bitcoin-testnet4-1', mempool: 'https://mempool.space/testnet4/api', addr: a => `https://mempool.space/testnet4/address/${a}`, tx: h => `https://mempool.space/testnet4/tx/${h}` },
  'btc-mainnet': { network: 'mainnet', path: 'bitcoin-1', mempool: 'https://mempool.space/api', addr: a => `https://mempool.space/address/${a}`, tx: h => `https://mempool.space/tx/${h}` },
};
export const isBtcChain = (key: string) => key in BTC_CHAINS;
const withTimeout = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out after ${ms} ms`)), ms))]);

export class ChainSigBtc {
  readonly btc: InstanceType<typeof chainAdapters.btc.Bitcoin>;
  // rpcUrl: the NEAR RPC the MPC contract's root key is read from (the library's default testnet RPC is deprecated and stalls).
  constructor(public key: string, nearNetwork: 'testnet' | 'mainnet' = 'testnet', rpcUrl?: string) {
    const c = BTC_CHAINS[key]; if (!c) throw new Error(`unknown bitcoin chain ${key}`);
    const mpc = new contracts.ChainSignatureContract({ networkId: nearNetwork, contractId: nearNetwork === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet', ...(rpcUrl ? { fallbackRpcUrls: [rpcUrl] } : {}) } as any);
    this.btc = new chainAdapters.btc.Bitcoin({ network: c.network, contract: mpc, btcRpcAdapter: new chainAdapters.btc.BTCRpcAdapters.Mempool(c.mempool) });
  }
  // The MPC derives from the account that calls `sign`: the wallet contract, with a chain-specific path (replay safety).
  derive(walletContract: string) { return withTimeout(this.btc.deriveAddressAndPublicKey(walletContract, BTC_CHAINS[this.key].path), 30_000, 'derive'); }
  balance(address: string) { return withTimeout(this.btc.getBalance(address), 15_000, 'balance'); }
  // Unsigned P2WPKH transfer plus the sighashes the MPC must sign (one per input). Needs a funded derived address.
  async prepare(from: string, publicKey: string, to: string, satoshis: number): Promise<{ transaction: unknown; hashesToSign: unknown[] }> {
    return this.btc.prepareTransactionForSigning({ publicKey, from, to, value: String(satoshis) } as any) as any;
  }
}
