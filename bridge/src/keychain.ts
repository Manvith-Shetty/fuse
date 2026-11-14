// Owner-side signing helpers. The owner's NEAR key (near-cli-rs legacy keychain) also owns the chip's policy:
// policy_set carries an ed25519 signature by that key (docs/v2-spec.md 2.2). Nothing here touches the chip key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KeyPair, KeyPairEd25519 } from 'near-api-js';
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { randomBytes } from 'node:crypto';
import { policyAuthDigest, policyAuthMessage, nep413Hash, type Policy } from './policy.js';
import type { PolicyAuth, DecisionEnvelope } from './chip.js';

export function credentialsPath(network: string, account: string) { return path.join(os.homedir(), '.near-credentials', network, `${account}.json`); }

export function loadKeyPair(network: string, account: string): KeyPairEd25519 {
  const file = credentialsPath(network, account);
  if (!fs.existsSync(file)) throw new Error(`no credentials for ${account} at ${file} (near-cli-rs legacy keychain)`);
  const cred = JSON.parse(fs.readFileSync(file, 'utf8'));
  const kp = KeyPair.fromString(cred.private_key);
  if (!(kp instanceof KeyPairEd25519)) throw new Error('owner key must be ed25519');
  return kp;
}

// The owner signs sha256("FUSE_POLICY_V1" || sha256(compact policy JSON) || seq_le). Returns the fields policy_set needs.
export function signPolicyAuth(policy: Policy, seq: number, kp: KeyPairEd25519): PolicyAuth {
  const sig = kp.sign(policyAuthDigest(policy, seq)).signature;
  return { seq, owner_pubkey: kp.getPublicKey().toString(), owner_sig: Buffer.from(sig).toString('base64') };
}

// The NEP-413 form of the same authorisation, as a browser wallet's signMessage would produce it. Used by tests and by
// `policy set --nep413` to prove the chip accepts wallet-style signatures before the UI relies on them.
export function signPolicyAuthNep413(policy: Policy, seq: number, kp: KeyPairEd25519, recipient = 'fuse', nonce: Uint8Array = randomBytes(32)): PolicyAuth {
  const hash = nep413Hash({ message: policyAuthMessage(policy, seq), nonce, recipient });
  const sig = kp.sign(hash).signature;
  return { seq, owner_pubkey: kp.getPublicKey().toString(), owner_sig: Buffer.from(sig).toString('base64'), scheme: 'nep413', nonce: Buffer.from(nonce).toString('base64'), recipient };
}

// SIMULATED-only "TEE" signer for tests and demos without a NEAR AI key: signs a decision text the way the chip
// expects (ed25519 over sha256(text)). Labelled so it can never be mistaken for a real attestation.
export class DevDecisionSigner {
  constructor(private seed: Uint8Array) {}
  static fromHex(hex: string) { return new DevDecisionSigner(new Uint8Array(Buffer.from(hex, 'hex'))); }
  async pubkey() { return 'ed25519:' + bs58.encode(await ed.getPublicKeyAsync(this.seed)); }
  async sign(model: string, requestBytes: Uint8Array, responseBytes: Uint8Array, bind = true): Promise<DecisionEnvelope & { simulated: true }> {
    const text = `${model}:${Buffer.from(sha256(requestBytes)).toString('hex')}:${Buffer.from(sha256(responseBytes)).toString('hex')}`;
    const sig = await ed.signAsync(sha256(new TextEncoder().encode(text)), this.seed);
    return { text, sig: Buffer.from(sig).toString('base64'), signer: await this.pubkey(), ...(bind ? { resp: Buffer.from(responseBytes).toString('base64') } : {}), simulated: true };
  }
}
