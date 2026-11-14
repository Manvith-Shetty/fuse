// Exercises the setup endpoints a browser wizard uses, against a running bridge (default the simulator one on 7787):
// GET /setup/info, GET /config, POST /config (round trip), POST /policy/message, POST /policy with a NEP-413 owner
// signature made by the owner's keychain key (what a wallet's signMessage produces). Usage:
//   DOTENV_CONFIG_PATH=.env.sim npx tsx scripts/setup-smoke.ts [http://127.0.0.1:7787]
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { loadKeyPair } from '../src/keychain.js';
import { nep413Hash } from '../src/policy.js';

const base = process.argv[2] ?? 'http://127.0.0.1:7787';
const cfg = loadConfig();
const j = async (path: string, init?: RequestInit) => { const r = await fetch(base + path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };

const info = await j('/setup/info'); console.log('setup/info:', info.status, JSON.stringify({ chip: info.body?.chip?.pubkey, mode: info.body?.chip?.mode, network: info.body?.network, artifacts: info.body?.artifacts?.length }));
const before = await j('/config'); console.log('config before:', JSON.stringify(before.body?.effective));
// round trip: set the registry through the UI path, read it back, then restore the previous value
const prevReg = before.body?.file?.REGISTRY_CONTRACT ?? '';
const set = await j('/config', { method: 'POST', body: JSON.stringify({ REGISTRY_CONTRACT: 'registry.fuse-v2-sdgt.testnet' }) }); console.log('POST /config:', set.status, set.body?.effective?.REGISTRY_CONTRACT);
const bad = await j('/config', { method: 'POST', body: JSON.stringify({ WALLET_CONTRACT: 'Not Valid!' }) }); console.log('POST /config invalid id ->', bad.status, bad.body?.error);
await j('/config', { method: 'POST', body: JSON.stringify({ REGISTRY_CONTRACT: prevReg }) });

const st = await j('/status'); const policy = st.body?.policy; if (!policy) throw new Error('no chip policy from /status');
const msg = await j('/policy/message', { method: 'POST', body: JSON.stringify({ policy }) }); console.log('policy/message:', msg.status, msg.body?.message, 'seq', msg.body?.seq);
// Sign like a wallet would (NEP-413 over the message, recipient "fuse", fresh 32-byte nonce) with the owner key from the keychain.
const kp = loadKeyPair(cfg.NEAR_NETWORK, cfg.OWNER_ACCOUNT);
const nonce = randomBytes(32);
const sig = kp.sign(nep413Hash({ message: msg.body.message, nonce, recipient: 'fuse' })).signature;
const auth = { scheme: 'nep413', seq: msg.body.seq, nonce: Buffer.from(nonce).toString('base64'), recipient: 'fuse', owner_pubkey: kp.getPublicKey().toString(), owner_sig: Buffer.from(sig).toString('base64') };
const tampered = await j('/policy', { method: 'POST', body: JSON.stringify({ policy, auth: { ...auth, recipient: 'evil' } }) }); console.log('POST /policy tampered recipient ->', tampered.body?.code, tampered.body?.detail);
const ok = await j('/policy', { method: 'POST', body: JSON.stringify({ policy, auth }) }); console.log('POST /policy nep413 ->', ok.status, JSON.stringify(ok.body));
