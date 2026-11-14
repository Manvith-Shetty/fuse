// Chain Signatures leg. chainsig.js is used for address derivation, EVM tx preparation and signature assembly only.
// The MPC `sign` request is NOT sent by this file: it goes through the chip -> wallet contract -> v1.signer, so the
// chip's chain_dests/value policy and the contract's allowlist both apply before any foreign-chain signature exists.
import { chainAdapters, contracts, utils, constants } from 'chainsig.js';
import { createPublicClient, http, recoverAddress, keccak256, serializeTransaction, type Hex, type Chain, type PublicClient } from "viem";
import { sepolia } from 'viem/chains';
import type { Fuse } from './fuse.js';

export const CHAINS: Record<string, { chain: Chain; path: string; explorer: (h: string) => string; addr: (a: string) => string }> = {
  'eth-sepolia': { chain: sepolia, path: 'ethereum-sepolia-1', explorer: (h: string) => `https://sepolia.etherscan.io/tx/${h}`, addr: (a: string) => `https://sepolia.etherscan.io/address/${a}` },
};
export type ChainKey = string;

export class ChainSig {
  readonly mpc: InstanceType<typeof contracts.ChainSignatureContract>;
  readonly evm: InstanceType<typeof chainAdapters.evm.EVM>;
  readonly client: PublicClient;
  constructor(public key: ChainKey, rpcUrl?: string, network: 'testnet' | 'mainnet' = 'testnet') {
    this.mpc = new contracts.ChainSignatureContract({ networkId: network, contractId: constants.CONTRACT_ADDRESSES[network === 'mainnet' ? 'MAINNET' : 'TESTNET'] });
    this.client = createPublicClient({ chain: CHAINS[key].chain, transport: http(rpcUrl) }) as PublicClient;
    this.evm = new chainAdapters.evm.EVM({ publicClient: this.client as any, contract: this.mpc });
  }
  // The MPC derives from the account that calls `sign`: our wallet contract, not the agent.
  derive(walletContract: string) { return this.evm.deriveAddressAndPublicKey(walletContract, CHAINS[this.key].path); }
  balance(address: string) { return this.evm.getBalance(address); }
  // Build the EIP-1559 transfer ourselves (fixed 21000 gas) so an unfunded derived address can still be signed for:
  // the MPC signature is the thing we demonstrate; broadcast needs the address funded.
  async prepare(from: `0x${string}`, to: `0x${string}`, valueWei: bigint) {
    const [nonce, fees] = await Promise.all([this.client.getTransactionCount({ address: from, blockTag: 'pending' }), this.client.estimateFeesPerGas()]);
    const transaction = { type: 'eip1559' as const, chainId: CHAINS[this.key].chain.id, nonce, to, value: valueWei, gas: 21000n, maxFeePerGas: fees.maxFeePerGas!, maxPriorityFeePerGas: fees.maxPriorityFeePerGas!, data: '0x' as Hex };
    const unsigned = serializeTransaction(transaction);
    const payload = new Uint8Array(Buffer.from(keccak256(unsigned).slice(2), 'hex'));
    return { transaction, payload, payloadBase64: Buffer.from(payload).toString('base64'), payloadHex: Buffer.from(payload).toString('hex') };
  }
  toRSV(mpcResultJson: string) { return utils.cryptography.toRSV(JSON.parse(mpcResultJson)); }
  finalize(transaction: any, rsv: { r: string; s: string; v: number }) {
    const yParity = rsv.v >= 27 ? rsv.v - 27 : rsv.v;
    return serializeTransaction(transaction, { r: `0x${rsv.r.replace(/^0x/, '')}` as Hex, s: `0x${rsv.s.replace(/^0x/, '')}` as Hex, yParity, v: BigInt(yParity + 27) });
  }
  async recoveredSigner(payload: Uint8Array, rsv: { r: string; s: string; v: number }) {
    const sig = `0x${rsv.r.replace(/^0x/, '')}${rsv.s.replace(/^0x/, '')}${(rsv.v >= 27 ? rsv.v : rsv.v + 27).toString(16).padStart(2, '0')}` as Hex;
    return recoverAddress({ hash: `0x${Buffer.from(payload).toString('hex')}` as Hex, signature: sig });
  }
  broadcast(signedTx: string) { return this.client.sendRawTransaction({ serializedTransaction: signedTx as Hex }); }
}

// Full flow. Returns everything a judge needs to verify: derived address, NEAR tx, MPC signature, recovered signer, Sepolia tx (if funded).
export async function crossChainPay(fuse: Fuse, cs: ChainSig, to: `0x${string}`, valueWei: bigint, opts: { broadcast: boolean; pollMs?: number; pollMax?: number }) {
  const wallet = fuse.cfg.WALLET_CONTRACT;
  const { address } = await cs.derive(wallet);
  const bal = await cs.balance(address).catch(() => ({ balance: 0n, decimals: 18 }));
  const prepared = await cs.prepare(address as `0x${string}`, to, valueWei);
  const before = await fuse.near.view(wallet, 'get_counts');
  const req = await fuse.requestChainSig({ chain: cs.key, to: to.toLowerCase(), value: valueWei.toString(), path: CHAINS[cs.key].path, payloadBase64: prepared.payloadBase64, domainId: 0 });
  if (!req.ok) return { ok: false, stage: 'chip_or_contract', derivedAddress: address, balanceWei: bal.balance.toString(), request: req };
  const id = Number(before.chain_sigs); // ids are 0-based in insertion order
  let rec: any = null;
  for (let i = 0; i < (opts.pollMax ?? 40); i++) { rec = await fuse.near.view(wallet, 'get_chain_sig_result', { id }); if (rec && rec.status !== 'pending') break; await new Promise(r => setTimeout(r, opts.pollMs ?? 3000)); }
  if (!rec || rec.status !== 'ok' || !rec.result_json) return { ok: false, stage: 'mpc', derivedAddress: address, nearTx: req, record: rec };
  const rsv = cs.toRSV(rec.result_json);
  const signer = await cs.recoveredSigner(prepared.payload, rsv);
  const signedTx = cs.finalize(prepared.transaction, rsv);
  const out: any = { ok: true, derivedAddress: address, derivedAddressExplorer: CHAINS[cs.key].addr(address), balanceWei: bal.balance.toString(), nearTx: req, mpc: { id, rsv, recoveredSigner: signer, signerMatchesDerived: signer.toLowerCase() === address.toLowerCase() }, signedTxHex: signedTx, signedTxHash: keccak256(signedTx as Hex) };
  if (opts.broadcast && bal.balance > 0n) { try { out.foreignTxHash = await cs.broadcast(signedTx); out.foreignExplorer = CHAINS[cs.key].explorer(out.foreignTxHash); } catch (e: any) { out.broadcastError = e.shortMessage ?? e.message; } }
  else out.broadcastSkipped = bal.balance === 0n ? `derived address ${address} has no Sepolia ETH; fund it from a faucet and rerun with --broadcast` : 'broadcast disabled';
  return out;
}
