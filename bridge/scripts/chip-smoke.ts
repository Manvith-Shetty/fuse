// Hardware smoke test: talk to the chip over SERIAL_PORT, decode a real `pay` transaction on it, ask it to sign,
// and verify locally whatever comes back (a signature over sha256(tx), or a refusal receipt). No funds move:
// nothing is broadcast. Usage: SIMULATE_CHIP=0 SERIAL_PORT=/dev/cu.usbmodemXXXX npx tsx scripts/chip-smoke.ts
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { makeFuse } from '../src/setup.js';
const t0 = Date.now(); const log = (...a: any[]) => console.log(((Date.now() - t0) / 1000).toFixed(2) + 's', ...a);
const { fuse, chip, cfg } = await makeFuse();
const h = await chip.hello(); log('hello:', h.mode, h.board ?? '', h.pubkey, 'fw', h.fw, 'policy', h.policy_hash, 'counter', h.counter);
const pk = Buffer.from(h.pubkey_hex, 'hex');
const built = await fuse.near.build({ signerId: cfg.AGENT_ACCOUNT, publicKey: h.pubkey, receiverId: cfg.WALLET_CONTRACT, method: 'pay', args: { receiver: process.argv[2] ?? 'api.fuse-hack-2026.testnet', token: 'near', amount: process.argv[3] ?? '100000000000000000000000', memo: 'chip smoke test' }, gasTgas: 100, minNonce: BigInt(h.last_nonce ?? 0) + 1n });
log('built pay tx:', built.bytes.length, 'bytes, hash', built.hash);
const d = await chip.decode(built.bytes); log('chip decoded:', d.ok ? `${d.signer} -> ${d.receiver}.${d.method} nonce ${d.nonce}` : d.code);
const r = await chip.sign(built.bytes, 'smoke test');
if (r.ok) {
  const okSig = await ed.verifyAsync(Buffer.from(r.sig!, 'base64'), sha256(built.bytes), pk);
  log('chip SIGNED', r.button ? '(after button)' : '', '| signature verifies against chip pubkey:', okSig, '| not broadcast');
} else {
  const buf = new Uint8Array(52); buf.set(new TextEncoder().encode('FUSE_REFUSAL_V1'), 0); buf.set(bs58.decode(r.hash), 15); buf[47] = r.code_num!; new DataView(buf.buffer).setUint32(48, r.counter!, true);
  const okRcpt = await ed.verifyAsync(Buffer.from(r.receipt!, 'base64'), sha256(buf), pk);
  const tampered = new Uint8Array(buf); tampered[47] ^= 1;
  log('chip REFUSED', r.code, `(${r.detail})`, 'counter', r.counter, '| receipt verifies:', okRcpt, '| tampered digest verifies:', await ed.verifyAsync(Buffer.from(r.receipt!, 'base64'), sha256(tampered), pk));
}
await chip.close(); process.exit(0);
