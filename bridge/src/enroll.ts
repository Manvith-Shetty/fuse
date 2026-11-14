// Enrol the chip: one transaction, signed by the agent account's bootstrap full-access key, that
//   1. adds the chip's public key as a function-call key (receiver = wallet contract, 3 methods, unlimited allowance)
//   2. deletes the bootstrap full-access key
// After this the agent account has exactly one key, and it is the chip's. Only the owner's wallet can change that.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair, PublicKey, createTransaction, encodeTransaction, actions, SignedTransaction, Signature, KeyType, baseDecode } from 'near-api-js';
import { sha256 } from '@noble/hashes/sha2.js';
import { Near, outcomeStatus } from './near.js';
import type { Config } from './config.js';

export const AGENT_METHODS = ['pay', 'record_refusal', 'request_chain_sig'];

export async function enroll(cfg: Config, near: Near, chipPubkey: string, opts: { keepBootstrapKey?: boolean; credentialsFile?: string } = {}) {
  const file = opts.credentialsFile ?? path.join(os.homedir(), '.near-credentials', cfg.NEAR_NETWORK, `${cfg.AGENT_ACCOUNT}.json`);
  if (!fs.existsSync(file)) throw new Error(`no bootstrap credentials for ${cfg.AGENT_ACCOUNT} at ${file}`);
  const cred = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kp = KeyPair.fromString(cred.private_key);
  const bootstrapPk = kp.getPublicKey();
  const chipPk = PublicKey.fromString(chipPubkey);
  if (chipPk.toString() === bootstrapPk.toString()) throw new Error('chip key equals bootstrap key');

  const nonce = (await near.accessKeyNonce(cfg.AGENT_ACCOUNT, bootstrapPk.toString())) + 1n;
  const blockHash = await near.latestBlockHash();
  const acts = [actions.addFunctionCallAccessKey(chipPk, cfg.WALLET_CONTRACT, AGENT_METHODS)];
  if (!opts.keepBootstrapKey) acts.push(actions.deleteKey(bootstrapPk));
  const tx = createTransaction(cfg.AGENT_ACCOUNT, bootstrapPk, cfg.AGENT_ACCOUNT, nonce, acts, baseDecode(blockHash));
  const bytes = encodeTransaction(tx);
  const sig = kp.sign(sha256(bytes)).signature;
  const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: KeyType.ED25519, data: sig }) });
  const outcome = await near.send(signed);
  const st = outcomeStatus(outcome);
  return { ok: st.ok, error: st.error, hash: outcome?.transaction?.hash, chipPubkey, bootstrapDeleted: !opts.keepBootstrapKey, keys: await near.accessKeys(cfg.AGENT_ACCOUNT) };
}
