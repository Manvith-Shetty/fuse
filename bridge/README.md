# bridge

Untrusted laptop relay (TypeScript, Node 22+). Builds unsigned NEAR transactions with near-api-js, hands the
raw Borsh bytes to the chip, broadcasts what the chip signs, posts refusal receipts, and serves a local API
for the dashboard, the agent and the MCP server. It holds no keys.

```sh
cp .env.example .env            # fill accounts; SIMULATE_CHIP=1 for the no-hardware path
npm i
npm test                        # strict decoder + policy + simulated chip (7 tests)
npm run fuse -- hello           # chip identity (mode HARDWARE or SIMULATED)
npm run fuse -- keys            # the agent account's access keys on chain: expect exactly one function-call key
npm run fuse -- enroll          # one tx: add the chip key (unlimited allowance), delete the bootstrap key
npm run fuse -- pay -r api.<owner>.testnet -t near -a 100000000000000000000000 -m "api call"
npm run fuse -- onchain         # wallet contract views
npm run fuse -- serve           # http://127.0.0.1:7777 : GET /status /log /onchain, POST /pay /chain-sig, WS /events
```

`SIMULATE_CHIP=1` runs `src/chip-sim.ts`: the same decoder and policy as the firmware with a software key in
`data/sim-chip-state.json`. Every response from it says `SIMULATED`. `SIM_BUTTON=deny` makes the simulated
button time out.

Hardware serial: `src/chip-serial.ts` has two transports. On macOS it opens the device as a file with non-blocking
polled reads (`SERIAL_TRANSPORT=fs`, the default there) because the `serialport` binding's poller never wakes for the
ESP32-S3's native USB CDC device; elsewhere it uses `serialport` (`SERIAL_TRANSPORT=serialport` forces it). Writes go
out in 64-byte chunks so small firmware RX buffers are not overrun. On a CP2102/CH340 UART bridge it drops DTR/RTS after
opening so the board is not held in reset.

Scripts: `scripts/borsh-vector.mjs` prints the near-api-js transaction vector the firmware tests decode.
`scripts/chip-smoke.ts` decodes and signs (or refuses) a real `pay` transaction on the attached chip and verifies the
signature or refusal receipt locally; nothing is broadcast.

## v2 commands (docs/v2-spec.md)
```sh
npm run fuse -- policy set ../firmware/policy.s3.json          # owner-signed: OWNER_ACCOUNT's legacy-keychain key signs seq+policy; BOOT confirms
npm run fuse -- check attacker.testnet                         # shared refusal registry verdict (REGISTRY_CONTRACT in .env)
npm run fuse -- pending && npm run fuse -- approve 3           # quorum: list / approve a pending payment (approver chip's bridge)
npm run fuse -- enroll --role approver                         # enrol a second chip with a function-call key for approve_payment only
npm run fuse -- audit --also-key ed25519:<previous chip key>   # data/audit/*.md and *.json, every receipt re-verified
npm run fuse -- chain-sig address --chain btc-testnet4         # Bitcoin testnet4 address of the same wallet via Chain Signatures
npm run fuse -- intents tokens | npm run fuse -- intents quote --from nep141:wrap.near --to <asset> --amount <atomic> --recipient <addr>   # mainnet dry quote, nothing moves
```
API additions on `serve`: `POST /approve {id}`, `GET /check?receiver=`, `GET /audit[?format=md]`; `/onchain` adds `pending` and
`config`; `POST /pay` accepts `decision` (attested model decision envelope) and returns `counterparty`, `pending`, `decision`.
Env: `REGISTRY_CONTRACT`, `FUSE_FW_ARG` (`1`/`0`, default: on for a protocol v2 chip), `SIM_DECISION_SIGNER_SEED` (simulator only).
Bootstrap for judges: `npx tsx scripts/bootstrap.ts <prefix>` prefers `contracts/fuse-wallet/res/fuse_wallet_v2.wasm`, else the
v1 artifact; `FUSE_ENV_OUT` and `FUSE_DATA_DIR` keep a test deployment apart from a live `.env` (then run the bridge with
`DOTENV_CONFIG_PATH=<that file>`).
