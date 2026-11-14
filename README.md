# Fuse: a hardware key for AI agents on NEAR

**The agent never holds a key.** Its NEAR account has exactly one access key: an ed25519 function-call key whose
private half was generated on an ESP32 and never leaves the chip. Before signing, the chip decodes the raw
transaction bytes itself and checks them against its policy. Payments above a threshold need a physical button
press. Refusals are signed by the chip and recorded onchain. Unplug the chip and the agent is revoked.

Built for NEAR HACKATHON 2026, tracks `security`, `agents`, `open`. Testnet. Every claim below says whether it ran
on the real chip or on the labelled software simulator (`SIMULATED`); the full list is in `docs/claims-ledger.md`.

## How the agent holds its keys, and what it cannot do without me

| Account | Keys | What it can do |
| --- | --- | --- |
| `agent.<owner>.testnet` | **one** function-call key, the chip's: `receiver_id = fuse.<owner>.testnet`, methods `pay, record_refusal, request_chain_sig`, allowance unlimited | call three methods on one contract, nothing else: no NEAR transfers, no deposits, no key management, no other contract |
| `fuse.<owner>.testnet` | contract | holds the funds, re-checks the policy, counts daily spend, verifies and stores refusal receipts, forwards cross-chain signing to NEAR Chain Signatures |
| `<owner>.testnet` | your wallet | sets policy, pauses, withdraws, rotates the chip key |

Live example on testnet: agent [`agent-s3.fuse-hack-2026.testnet`](https://testnet.nearblocks.io/address/agent-s3.fuse-hack-2026.testnet)
(one FunctionCall key, generated on an ESP32-S3), wallet [`fuse.fuse-hack-2026.testnet`](https://testnet.nearblocks.io/address/fuse.fuse-hack-2026.testnet).

## Three locks

| Layer | Enforces | What it stops even if the other two fail |
| --- | --- | --- |
| 1. Protocol (function-call key) | receiver = wallet contract, 3 methods, no deposits, no key management | a stolen chip or buggy firmware cannot drain the agent account or touch another contract |
| 2. Silicon (firmware) | strict Borsh decode, exactly one FunctionCall, signer/key/receiver match, method allowlist, zero deposit, gas cap, nonce monotonic, receiver and token allowlists, per-tx cap, velocity cap, button above threshold | a compromised laptop or a prompt-injected agent cannot obtain a signature outside policy |
| 3. Contract (onchain) | allowlists, per-tx cap, daily cap, pause, ed25519-verified refusal receipts | a compromised chip is still bounded by the daily cap and can be paused by the owner |

The chip never trusts the laptop. The laptop sends raw transaction bytes plus a display hint; the chip ignores the
hint and decides from the bytes (arXiv 2610.21063, "Approve What, Exactly?", shows why: in 4 of 8 agent runtimes the
arguments changed after approval).

## What is real today (2026-11-14)

| Claim | Status | Evidence |
| --- | --- | --- |
| Agent account has exactly one key, scoped function-call, unlimited allowance, generated on the ESP32-S3 | REAL | [enrol tx](https://testnet.nearblocks.io/txns/GmXiVtRXmm2m9cAw6ysWJehmZsNv1RnBnqUMd3D15RDj): adds the chip key `ed25519:FewvEQ…HoHF` and deletes the bootstrap key in one transaction; [agent account](https://testnet.nearblocks.io/address/agent-s3.fuse-hack-2026.testnet) |
| Payment signed by the real chip executed onchain | REAL (ESP32-S3) | [0.1 NEAR to the seller](https://testnet.nearblocks.io/txns/CxpuNBs7d4mEW6dk9Jn2V8q1u9V2fGFE2G4oNgroPgQ3), `mode: HARDWARE`. Earlier with the simulator: [MEdKgJ8F…](https://testnet.nearblocks.io/txns/MEdKgJ8FFMxtpCSp1pjVhUykhdYd1zN1d7byTiMjtx2) |
| Injected payment refused by the real chip, receipt verified and recorded onchain | REAL (ESP32-S3) | [record_refusal](https://testnet.nearblocks.io/txns/CHo4rwwhHisiViv69UcoAogPtsHgNNB5tBDe5jpFSF9V): the contract checks the chip's ed25519 receipt before storing it. A missed button press is refused and recorded the same way ([BUTTON_TIMEOUT receipt](https://testnet.nearblocks.io/txns/5BK7i9orQZL8zSi3AnyzxTNViky68F9HeqT7cTffXfcy)) |
| Over-threshold payment needs the physical button | REAL (ESP32-S3) | [0.6 NEAR, button=true](https://testnet.nearblocks.io/txns/AnP5Q2Zz9aY3NKGPewhXUVjYqP6EHRckEQzHseARah5a): the chip signed only after the BOOT press; without it the request times out and is recorded as refused |
| Purchasing agent reads a poisoned invoice: injected payment refused by the real chip and recorded, legitimate purchase paid | REAL chip (SCRIPTED agent, no LLM key) | [refusal receipt #7](https://testnet.nearblocks.io/txns/3wtq8u4V8tC39f8EKsnanbC2g8LHKR4ivbLTvFtBdUzW), [purchase](https://testnet.nearblocks.io/txns/5vKuWUZGbo5hEN29jR2xKzuxTCTZJbLtmyUU2TdJaGco); `cd agent && npx tsx src/index.ts run --inject` |
| 16/16 attack scenarios stopped (11 chip, 3 protocol, 2 contract), 0/50 legitimate decisions refused | SIMULATED chip, REAL chain, self-generated | `attacks/report.md`, regenerate with `npm run attacks` |
| Firmware decodes the real near-api-js bytes and refuses malformed ones | REAL (host tests) | `cd firmware && pio test -e native`: 11 tests incl. the near-api-js vector, trailing bytes, multi-action |
| Firmware compiles for ESP32 and ESP32-S3 | REAL | `pio run -e esp32dev` (507 KB flash, 22 KB RAM), `pio run -e esp32s3_usb` |
| The chip attests which firmware it runs | REAL | `hello` returns `fw_sha256`, the ELF SHA-256 the bootloader stores in the app descriptor; it matched `esptool image-info .pio/build/esp32s3_usb/firmware.bin` (`c07ec0e4…9f1a`) after flashing |
| Chain Signatures: the same chip approves a Sepolia payment | IN PROGRESS | request reaches the MPC through the chip and the contract; derived address `0x172F154aBe679a7777200911980eD05136ACc664` needs Sepolia ETH before broadcast |
| Real ESP32 in the loop: key born on the chip, policy accepted with the BOOT button, 296-byte tx decoded on-device, refusal receipt verified | REAL | 7Semi ESP32-S3-DevKitC-1 N16R8 over native USB; `bridge/scripts/chip-smoke.ts` (decode + sign/refuse + local verification, nothing broadcast); policy load needs the physical button (`policy_hash b8cebd9a572382b5`) |

## Quick start A: no hardware (about 5 minutes, your own testnet accounts, nothing to trust)

Prerequisites: Node 22+, Rust with the `wasm32-unknown-unknown` target and `cargo-near`, `near-cli-rs` (`npm i -g near-cli-rs`).

```sh
cd contracts/fuse-wallet && cargo test && cargo near build non-reproducible-wasm && cd ../..
#   see: "21 passed", target/near/fuse_wallet.wasm
cd bridge && npm i && npm test
#   see: "7 passed" (strict decoder, policy, simulated chip signs and refuses with verifiable receipts)
npx tsx scripts/bootstrap.ts fuse-judge-$RANDOM
#   creates <prefix>.testnet from the faucet and 3 sub-accounts, deploys + inits the contract,
#   enrols the SIMULATED chip as the agent account's only key, writes bridge/.env
npm run fuse -- keys
#   see: exactly one key, permission FunctionCall, receiver_id fuse.<prefix>.testnet, allowance null
npm run fuse -- pay -r api.<prefix>.testnet -t near -a 100000000000000000000000 -m "api call"
#   see: {"ok":true,"mode":"SIMULATED","explorer":"https://testnet.nearblocks.io/txns/..."}
npm run fuse -- pay -r attacker.testnet -t near -a 1000000000000000000000
#   see: {"ok":false,"code":"RECEIVER_NOT_ALLOWED","refusal":{"recorded":true,"explorer":"..."}}
npm run fuse -- pay -r api.<prefix>.testnet -t near -a 600000000000000000000000
#   see: "button":true  (the simulated button auto-presses after 1.5 s; SIM_BUTTON=deny makes it time out)
npm run fuse -- onchain
#   see: get_counts, get_refusals with the verified receipts
```

Then the live pieces, each in its own terminal:

```sh
cd bridge && npm run fuse -- serve                 # bridge API on 127.0.0.1:7777
cd dashboard && npm i && npm run dev               # http://localhost:5173: heartbeat, three locks, feed, "Inject attack" button
cd agent && npm i && npx tsx src/index.ts run --inject
#   a purchasing agent reads a poisoned invoice; the injected payment is refused, the real purchase goes through.
#   Without NEAR_AI_API_KEY it runs a labelled SCRIPTED agent; with a key it uses NEAR AI Cloud (TEE inference, signed responses).
cd mcp && npm i && npm run build && claude mcp add fuse -- node "$PWD/dist/index.js"
#   Claude Code now pays through the chip. Ask it to pay the seller, then paste agent/fixtures/poisoned-invoice.md.
npm run attacks                                    # from the repo root: regenerates attacks/report.md against testnet
```

Unplug demo on the simulator: stop `serve` and the dashboard shows AGENT REVOKED within 2 s; restart it and the heartbeat returns.
On hardware, pull the cable: the bridge loses the heartbeat and refuses to pay (`503 AGENT_REVOKED`); plug it back in and the
bridge reopens the port by itself. Only one process can hold the serial port, so while `serve` runs, pay through it (`POST /pay`,
the dashboard, the agent or MCP) rather than the CLI.

## Quick start B: hardware

`firmware/README.md` has the steps: flash (`pio run -e esp32s3_usb -t upload` for an S3 on its native USB port, `-e esp32dev` for a classic ESP32), read the public key from the
serial `ready` line, point the bridge at the serial port with the simulator off, send the policy (`npm run fuse -- policy set
../firmware/policy.example.json`, press BOOT when the LED blinks amber), then `npm run fuse -- enroll`. Every command above then
runs against the real chip and reports `mode: HARDWARE`. LED language: green blink = signed, red blink = refused, amber = waiting
for your finger, solid red = no bridge heartbeat.

## How it fits together

```
Claude Code / agent --MCP or HTTP--> bridge (untrusted, holds no keys) --USB serial, raw Borsh bytes--> Fuse chip (ESP32, no network)
                                        |                                                             decode, policy, button, sign
                                        |<------------------------ signature, or a signed refusal receipt ------------|
                                        v
                 NEAR testnet: agent account (one scoped key) -> fuse-wallet contract (policy, daily cap, receipts)
                                                                   -> v1.signer (Chain Signatures) -> Ethereum Sepolia
```

| Folder | What |
| --- | --- |
| `firmware/` | ESP32 signer: `lib/fusecore` (Borsh decoder, policy, encodings, host-tested) and `src` (serial protocol, NVS keystore, LED and button) |
| `contracts/fuse-wallet/` | Rust near-sdk contract, 21 unit tests |
| `bridge/` | TypeScript relay, CLI and local API; simulated chip; `scripts/bootstrap.ts` |
| `agent/` | purchasing agent on NEAR AI Cloud (OpenAI-compatible, response signatures) with a scripted fallback and a poisoned-invoice fixture |
| `mcp/` | `fuse-mcp`: Claude Code or Claude Desktop use the chip as their wallet |
| `dashboard/` | live view: heartbeat, three locks, feed, onchain tables, AGENT REVOKED banner |
| `attacks/` | scenario suite and report |
| `docs/` | threat model, serial protocol and Borsh layout, claims ledger, demo script, X post, Windows setup, the organisers' track prompts |

## Honest limits

- A dev-board ESP32 is not a tamper-proof HSM. Flash encryption and secure boot are the production step and are not enabled here.
- The simulator is software and says so in every response. It runs the same decoder and policy logic as the firmware, which is tested on the host.
- The chip has no clock, so the daily cap is enforced onchain and the chip enforces a velocity cap per window.
- Testnet only. The Chain Signatures leg signs for a derived Sepolia address that a human must fund before anything broadcasts.
- The contract does not yet RLP-decode the EVM transaction to cross-check `to` and `value`; today it trusts the arguments the chip already checked.
- The attack report is self-generated. It is reproducible with one command and every broadcast has an explorer link.

## Prior art and how Fuse differs

- **EspWarden** (ESP32 policy signer for Ethereum bots): keys on device, whitelist, gas caps, ethers Signer. Fuse adds NEAR function-call key
  scoping as a protocol-level lock, signed refusal receipts recorded onchain, Chain Signatures and an MCP server for Claude Code.
- **NEAR Intents Agent API** (official hosted policy wallet): policy on a server, owner approval through a wallet. In Fuse the policy lives in
  silicon you hold plus onchain. There is no hosted party to trust, and revocation is a cable.
- **Ledger Agent Stack**: agent proposes, human approves on a device. The Fuse chip parses and enforces policy itself, so the human is only
  needed above a threshold and the agent can run unattended within bounds.
- **LeekWallet** (ETHOnline 2026 finalist, ESP32-S3 DIY hardware wallet): "the device decides, the host asks", EVM calldata decoded and shown
  on an OLED, refuse-by-default with a blind-signing override the user can switch on. Fuse is built for an agent, not a person: no screen,
  no blind-signing override at all, a policy instead of a prompt, NEAR function-call key scoping as a lock the firmware cannot loosen, and
  refusals that become onchain evidence.

## Tracks

`security`: spending limits, a policy engine and a sandboxed wallet, with the key physically out of the agent's reach. `agents`: an agent
that buys services and pays on NEAR, usable from Claude Code through MCP. `open`: a hardware key, onchain refusal evidence and cross-chain
approval from one chip fit no existing category.

MIT. See `LICENSE`.
