# Fuse: the hardware budget key for AI agents on NEAR

**Give your agent a budget, not your keys.** Coding agents and autonomous agents now pay for API calls, data and compute.
Fuse is the chip on your desk that lets them: it holds the only key of the agent's NEAR account, reads every transaction
itself, refuses anything outside the policy, asks for your thumb above a limit, and is revoked by pulling the cable.
Vendors get paid per call with no accounts or API keys, because the onchain receipt is the payment.

**The agent never holds a key.** Its NEAR account has exactly one access key: an ed25519 function-call key whose
private half was generated on an ESP32 and never leaves the chip. Before signing, the chip decodes the raw
transaction bytes itself and checks them against its policy. Payments above a threshold need a physical button
press. Refusals are signed by the chip and recorded onchain, where other agents can look them up before they pay the
same address. Unplug the chip and the agent is revoked.

Built for NEAR HACKATHON 2026, tracks `security`, `agents`, `open`. Testnet. Every claim below says whether it ran
on the real chip, on the labelled software simulator (`SIMULATED`), or is not yet demonstrated (`UNVERIFIED`); the full
list is `docs/claims-ledger.md`. Protocol v2 (owner-signed policy, attested decisions, firmware attestation, quorum,
shared refusal registry) is specified in `docs/v2-spec.md`; its status is in the "What is real" table.

## How the agent holds its keys, and what it cannot do without me

| Account | Keys | What it can do |
| --- | --- | --- |
| `agent.<owner>.testnet` | **one** function-call key, the chip's: `receiver_id = fuse.<owner>.testnet`, methods `pay, record_refusal, request_chain_sig`, allowance unlimited | call three methods on one contract, nothing else: no NEAR transfers, no deposits, no key management, no other contract |
| `fuse.<owner>.testnet` | contract | holds the funds, re-checks the policy, counts daily spend, verifies and stores refusal receipts, forwards cross-chain signing to NEAR Chain Signatures, forwards refusal evidence to the shared registry (v2) |
| `<owner>.testnet` | your wallet | sets policy (and signs the chip's policy, v2), pauses, withdraws, rotates the chip key |
| `approver.<owner>.testnet` (v2, optional) | a second chip's function-call key, method `approve_payment` only | approve payments above the quorum threshold; nothing else |

Live example on testnet: agent [`agent-s3.fuse-hack-2026.testnet`](https://testnet.nearblocks.io/address/agent-s3.fuse-hack-2026.testnet)
(one FunctionCall key, generated on an ESP32-S3), wallet [`fuse.fuse-hack-2026.testnet`](https://testnet.nearblocks.io/address/fuse.fuse-hack-2026.testnet).
The v2 contracts (wallet v2 and the refusal registry) on fresh testnet accounts are listed in `docs/v2-deploy.md`.

## allow / warn / block

The organisers' security prompt asks for a counterparty check that answers allow, warn or block, a wrapper that refuses
on block and asks a human on warn, a function-call key scoped to one contract, and an attack demo with the log. Fuse:

| Verdict | Where it is decided | What happens |
| --- | --- | --- |
| **allow** | chip policy: receiver and token allowlisted, amount under the per-tx cap, nonce fresh, velocity under cap, (v2) firmware hash and attested decision present when required | the chip signs; the contract re-checks and counts the daily cap; the payment executes |
| **warn** | amount above the chip's button threshold, or (v2) above the contract's quorum threshold | the chip lights amber and waits up to 30 s for a human finger on BOOT; above the quorum threshold the contract parks the payment until a second chip approves |
| **block** | anything else: wrong receiver, wrong token, over cap, replayed nonce, malformed bytes, missing decision, unknown firmware | nothing is signed; the chip issues an ed25519 refusal receipt; the bridge records it onchain; (v2) the wallet forwards it to the shared registry so `check <receiver>` answers block for everyone |

The log of the attack demo is `attacks/report.md` (16 scenarios) and the live feed on the dashboard. The shared
registry's verdict is advisory: the agent and the humans see it; the chip decides from bytes regardless.

## Three locks

| Layer | Enforces | What it stops even if the other two fail |
| --- | --- | --- |
| 1. Protocol (function-call key) | receiver = wallet contract, 3 methods, no deposits, no key management | a stolen chip or buggy firmware cannot drain the agent account or touch another contract |
| 2. Silicon (firmware) | strict Borsh decode, exactly one FunctionCall, signer/key/receiver match, method allowlist, zero deposit, gas cap, nonce monotonic, receiver and token allowlists, per-tx cap, velocity cap, button above threshold; v2: owner-signed policy, firmware hash in args, attested model decision, approve_payment with button | a compromised laptop or a prompt-injected agent cannot obtain a signature outside policy, and cannot change the policy |
| 3. Contract (onchain) | allowlists, per-tx cap, daily cap, pause, ed25519-verified refusal receipts; v2: allowed firmware list, quorum threshold with second-chip approval, registry forwarding | a compromised chip is still bounded by the daily cap and can be paused by the owner; large payments need two devices |

The chip never trusts the laptop. The laptop sends raw transaction bytes plus a display hint; the chip ignores the
hint and decides from the bytes (arXiv 2610.21063, "Approve What, Exactly?", shows why: in 4 of 8 agent runtimes the
arguments changed after approval).

## What is real today (2026-11-14)

| Claim | Status | Evidence |
| --- | --- | --- |
| Agent account has exactly one key, scoped function-call, unlimited allowance, generated on the ESP32-S3 | REAL | [enrol tx](https://testnet.nearblocks.io/txns/GmXiVtRXmm2m9cAw6ysWJehmZsNv1RnBnqUMd3D15RDj): adds the chip key `ed25519:FewvEQ…HoHF` and deletes the bootstrap key in one transaction; [agent account](https://testnet.nearblocks.io/address/agent-s3.fuse-hack-2026.testnet) |
| Payment signed by the real chip executed onchain | REAL (ESP32-S3) | [0.1 NEAR to the seller](https://testnet.nearblocks.io/txns/CxpuNBs7d4mEW6dk9Jn2V8q1u9V2fGFE2G4oNgroPgQ3), `mode: HARDWARE`; from the Windows laptop: [4BMnbJd4…](https://testnet.nearblocks.io/txns/4BMnbJd4KFuPaB6TQwXvzAcYw6oRQVW2k2QBgSeDYRG1) |
| Injected payment refused by the real chip, receipt verified and recorded onchain | REAL (ESP32-S3) | [record_refusal](https://testnet.nearblocks.io/txns/CHo4rwwhHisiViv69UcoAogPtsHgNNB5tBDe5jpFSF9V): the contract checks the chip's ed25519 receipt before storing it; same path from Windows: [CNWoiT8n…](https://testnet.nearblocks.io/txns/CNWoiT8nLvboXW1h6Q5rdY1uG9vdVCjSWLrz3o7Ma91Z). A missed button press is refused and recorded the same way ([BUTTON_TIMEOUT receipt](https://testnet.nearblocks.io/txns/5BK7i9orQZL8zSi3AnyzxTNViky68F9HeqT7cTffXfcy)) |
| Over-threshold payment needs the physical button | REAL (ESP32-S3) | [0.6 NEAR, button=true](https://testnet.nearblocks.io/txns/AnP5Q2Zz9aY3NKGPewhXUVjYqP6EHRckEQzHseARah5a) |
| Purchasing agent reads a poisoned invoice: injected payment refused by the real chip and recorded, legitimate purchase paid | REAL chip (SCRIPTED agent, no LLM key) | [refusal receipt #7](https://testnet.nearblocks.io/txns/3wtq8u4V8tC39f8EKsnanbC2g8LHKR4ivbLTvFtBdUzW), [purchase](https://testnet.nearblocks.io/txns/5vKuWUZGbo5hEN29jR2xKzuxTCTZJbLtmyUU2TdJaGco); `cd agent && npx tsx src/index.ts run --inject` |
| 16/16 attack scenarios stopped (11 chip, 3 protocol, 2 contract), 0/50 legitimate decisions refused | SIMULATED chip, REAL chain, self-generated | `attacks/report.md`, regenerate with `npm run attacks` |
| Firmware decodes the real near-api-js bytes and refuses malformed ones | REAL (host tests) | `cd firmware && pio test -e native` |
| The chip attests which firmware it runs | REAL | `hello` returns `fw_sha256`, the ELF SHA-256 the bootloader stores in the app descriptor; matched `esptool image-info` (`c07ec0e4…9f1a`) |
| Audit export re-verifies every onchain refusal receipt against the chip key | REAL | `cd bridge && npm run fuse -- audit --also-key ed25519:8sJtD4jwcbiMCGWKNwpyEPDH43syeqb6Heibvr34GMW5` (46 of 46 receipts verify: 10 by the live chip, 36 by the retired simulator key) |
| Bitcoin testnet4 address for the same wallet via Chain Signatures | REAL (derivation) | `tb1q46t7q59fqqf6x486jrxxmd436a9gcry8uf2gp6`, unfunded |
| Chain Signatures: the same chip approves a Sepolia payment | IN PROGRESS | request reaches the MPC through the chip and the contract; derived address `0x172F154aBe679a7777200911980eD05136ACc664` needs Sepolia ETH before broadcast |
| v2: owner-signed policy, receipt v2 with receiver, firmware hash argument, attested decisions, approve_payment | SIMULATED (bridge + simulator, 16 vitest); firmware built, not yet flashed; contracts per `docs/v2-deploy.md` | `cd bridge && npm test`; `docs/v2-spec.md`; `docs/claims-ledger.md` rows 14-23 |
| Shared refusal registry answers allow / warn / block with evidence | per `docs/v2-deploy.md` | `npm run fuse -- check attacker.testnet` with `REGISTRY_CONTRACT` set |
| Red-team endpoint: paste any document, the agent reads it, the chip decides, every attempt is logged with its verdict | REAL code path (SCRIPTED agent without an LLM key) | `cd agent && npx tsx src/index.ts serve`, then `POST http://127.0.0.1:7778/attempt {"text": "..."}` |
| Pay-per-call seller serves only after reading the payment from the chain | REAL code path | `seller/`, then `SELLER_URL=http://127.0.0.1:7779 npx tsx src/index.ts run` |
| Payments carry the hash of a NEAR AI Cloud signed model response; the chip verifies the TEE signature | UNVERIFIED (needs `NEAR_AI_API_KEY`; the simulator verifies a labelled dev signer) | `agent/src/llm.ts`, `bridge/test/v2.test.ts` |

## Quick start A: no hardware, Node only (about 5 minutes, your own testnet accounts, nothing to trust)

Prerequisites: Node 22+ and `near-cli-rs` (`npm i -g near-cli-rs`). No Rust needed: the contract wasm deployed on
testnet is committed as `contracts/fuse-wallet/res/*.wasm` with `SHA256SUMS` (rebuild with `cargo near build` if you prefer).

```sh
cd bridge && npm i && npm test
#   see: "16 passed" (strict decoder, policy, simulated chip signs and refuses with verifiable receipts; protocol v2)
npx tsx scripts/bootstrap.ts fuse-judge-$RANDOM
#   creates <prefix>.testnet from the faucet and 3 sub-accounts, deploys + inits the wallet contract (prebuilt wasm),
#   enrols the SIMULATED chip as the agent account's only key, writes bridge/.env
npm run fuse -- keys
#   see: exactly one key, permission FunctionCall, receiver_id fuse.<prefix>.testnet, allowance null
npm run fuse -- pay -r api.<prefix>.testnet -t near -a 100000000000000000000000 -m "api call"
#   see: {"ok":true,"mode":"SIMULATED","explorer":"https://testnet.nearblocks.io/txns/..."}
npm run fuse -- pay -r attacker.testnet -t near -a 1000000000000000000000
#   see: {"ok":false,"code":"RECEIVER_NOT_ALLOWED","refusal":{"recorded":true,"explorer":"..."}}
npm run fuse -- pay -r api.<prefix>.testnet -t near -a 600000000000000000000000
#   see: "button":true  (the simulated button auto-presses after 1.5 s; SIM_BUTTON=deny makes it time out)
npm run fuse -- onchain && npm run fuse -- audit
#   see: get_counts, get_refusals with the verified receipts; data/audit/audit-<ts>.md re-verifies every receipt
```

Then the live pieces, each in its own terminal:

```sh
cd bridge && npm run fuse -- serve                 # bridge API on 127.0.0.1:7777
cd frontend && npm i && npm run dev                # product UI http://localhost:3000 (Live, Red team, Counterparty, Audit, Policy)
cd dashboard && npm i && npm run dev               # the minimal v1 dashboard on http://localhost:5173, same data
cd agent && npm i && npx tsx src/index.ts run --inject
#   a purchasing agent reads a poisoned invoice; the injected payment is refused, the real purchase goes through.
#   Without NEAR_AI_API_KEY it runs a labelled SCRIPTED agent; with a key it uses NEAR AI Cloud (TEE inference, signed responses).
cd agent && npx tsx src/index.ts serve             # red-team server 127.0.0.1:7778: POST /attempt {"text": "<poisoned doc>"}, GET /attempts
cd seller && npm i && npm start                    # pay-per-call seller 127.0.0.1:7779; set SELLER_URL for the agent to use it
cd mcp && npm i && npm run build && claude mcp add fuse -- node "$PWD/dist/index.js"
#   Claude Code now pays through the chip (fuse_pay, fuse_check_counterparty, fuse_pending, fuse_approve, fuse_audit).
npm run attacks                                    # from the repo root: regenerates attacks/report.md against testnet
```

Unplug demo on the simulator: stop `serve` and the UI shows AGENT REVOKED within 2 s; restart it and the heartbeat returns.
On hardware, pull the cable: the bridge loses the heartbeat and refuses to pay (`503 AGENT_REVOKED`); plug it back in and the
bridge reopens the port by itself. Only one process can hold the serial port, so while `serve` runs, pay through it (`POST /pay`,
the UI, the agent or MCP) rather than the CLI.

## Quick start C: Claude Code buys an API call (the product loop)

```sh
cd bridge && npm run fuse -- serve                       # the chip (or SIMULATE_CHIP=1)
cd seller && npm start                                   # a vendor that charges per call over HTTP 402
cd mcp && npm run build && claude mcp add fuse -- node "$PWD/dist/index.js"
```
Then, in Claude Code: "Call fuse_budget, then fetch http://127.0.0.1:7779/service/weather?city=Bengaluru with fuse_fetch."
See: the budget in plain words; a 402 with a price; the chip signs 0.001 NEAR; the seller verifies the payment onchain and
answers with the data. Now paste `agent/fixtures/poisoned-invoice.md` and ask Claude to follow it: the chip refuses the
0.5 NEAR to attacker.testnet, the receipt lands onchain, and `fuse_check_counterparty attacker.testnet` says block.
Without Claude Code: `cd mcp && node scripts/smoke.mjs --buy "http://127.0.0.1:7779/service/weather?city=Bengaluru"`.

## Setup without env files (production path)

The bridge keeps its accounts in `bridge/data/config.json`, written by the setup UI (`frontend/`, route `/setup`) or
`POST /config`; it overrides `.env`. The wizard connects the owner's NEAR wallet, creates `fuse.<owner>` (deploys the
contract bytes served at `GET /artifacts/fuse_wallet_v2.wasm`, hash shown) and `agent.<owner>` with the chip's public key as
its only function-call key, saves the accounts to the bridge, and signs the chip policy with the wallet (NEP-413
`signMessage`, scheme `nep413`, message from `POST /policy/message`) before the human presses BOOT. Mainnet works the
same way with the wallet on mainnet; `docs/mainnet.md` lists what changes and what it costs.

## Quick start B: hardware

`firmware/README.md` has the steps: flash (`pio run -e esp32s3_usb -t upload` for an S3 on its native USB port, `-e esp32dev`
for a classic ESP32), read the public key from the serial `ready` line, point the bridge at the serial port with the simulator
off (`docs/windows-setup.md` for Windows), send the policy (`npm run fuse -- policy set ../firmware/policy.example.json`: v2
signs it with the owner's key, press BOOT when the LED blinks amber), then `npm run fuse -- enroll`. Every command above then
runs against the real chip and reports `mode: HARDWARE`. LED language: green blink = signed, red blink = refused, amber = waiting
for your finger, solid dim red = no bridge heartbeat.

## How it fits together

```
Claude Code / agent / red-team page --MCP or HTTP--> bridge (untrusted, holds no keys) --USB serial, raw Borsh bytes--> Fuse chip (ESP32, no network)
                                                        |                                                             decode, policy, button, sign
                                                        |<------------------------ signature, or a signed refusal receipt ------------|
                                                        v
      NEAR testnet: agent account (one scoped key) -> fuse-wallet contract (policy, daily cap, receipts, quorum) -> fuse-registry (shared refusal evidence)
                                                                                 -> v1.signer (Chain Signatures) -> Ethereum Sepolia, Bitcoin testnet4
      seller API: verifies the payment from the chain before serving (pay-per-call)
```

| Folder | What |
| --- | --- |
| `firmware/` | ESP32 signer: `lib/fusecore` (Borsh decoder, policy, encodings, host-tested) and `src` (serial protocol, NVS keystore, LED and button) |
| `contracts/fuse-wallet/` | Rust near-sdk contract (v1 live; v2 adds quorum, allowed firmware, registry forwarding, `migrate()`); `res/` holds the deployed wasm + checksums |
| `contracts/fuse-registry/` | shared refusal registry: verified receipts indexed by receiver, allow / warn / block verdicts |
| `bridge/` | TypeScript relay, CLI and local API; simulated chip; owner signing; audit export; `scripts/bootstrap.ts` |
| `agent/` | purchasing agent on NEAR AI Cloud (OpenAI-compatible, response signatures) with a scripted fallback, the red-team server, tool exports for other frameworks |
| `seller/` | pay-per-call API that trusts only the chain |
| `mcp/` | `fuse-mcp`: Claude Code or Claude Desktop use the chip as their wallet |
| `frontend/` | the product UI (Vite, React, Tailwind v4); `dashboard/` is the minimal v1 view |
| `attacks/` | scenario suite and report |
| `video/` | the animated segments of the demo film (Remotion): opener, three beats, LED b-roll, end card; real footage is shot per `docs/demo-script.md` |
| `docs/` | threat model, serial protocol and Borsh layout, v2 spec and deployment, claims ledger, demo script, X post, Windows setup, secure boot and hardware notes, the organisers' track prompts |
| `.github/workflows/ci.yml`, `.devcontainer/` | tests for every package on every push; a Node 22 + Rust devcontainer for the simulator path |

## Honest limits

- A dev-board ESP32 is not a tamper-proof HSM. Flash encryption and secure boot are the production step (`docs/secure-boot.md`) and are not enabled here; until then `fw_sha256` is self-reported.
- The simulator is software and says so in every response. It runs the same decoder and policy logic as the firmware, which is tested on the host.
- The chip has no clock, so the daily cap is enforced onchain and the chip enforces a velocity cap per window.
- Testnet only. The Chain Signatures leg signs for derived Sepolia and Bitcoin testnet4 addresses that a human must fund before anything broadcasts. NEAR Intents is mainnet-only; `fuse intents quote` is a dry quote and needs a partner API key.
- The contract does not yet RLP-decode the EVM transaction to cross-check `to` and `value`; today it trusts the arguments the chip already checked.
- The attack report is self-generated. It is reproducible with one command and every broadcast has an explorer link.
- The attested-decision path is wired end to end but has not run against NEAR AI Cloud yet (no API key during the build); the exact signature response fields are marked [VERIFY] in `agent/src/llm.ts`.
- A v2 chip's receipts (v2 digest) do not verify on the v1 contract: migrate the wallet before reflashing.

## Prior art and how Fuse differs

- **EspWarden** (ESP32 policy signer for Ethereum bots): keys on device, whitelist, gas caps, ethers Signer. Fuse adds NEAR function-call key
  scoping as a protocol-level lock, signed refusal receipts recorded onchain and shared, Chain Signatures, attested model decisions and an MCP server for Claude Code.
- **NEAR Intents Agent API** (official hosted policy wallet): policy on a server, owner approval through a wallet. In Fuse the policy lives in
  silicon you hold plus onchain, and the owner's signature is required to change it. There is no hosted party to trust, and revocation is a cable.
- **Ledger Agent Stack**: agent proposes, human approves on a device. The Fuse chip parses and enforces policy itself, so the human is only
  needed above a threshold and the agent can run unattended within bounds.
- **LeekWallet** (ETHOnline 2026 finalist, ESP32-S3 DIY hardware wallet): "the device decides, the host asks", EVM calldata decoded and shown
  on an OLED, refuse-by-default with a blind-signing override the user can switch on. Fuse is built for an agent, not a person: no screen,
  no blind-signing override at all, a policy instead of a prompt, NEAR function-call key scoping as a lock the firmware cannot loosen, and
  refusals that become onchain evidence.

## Tracks

`security`: spending limits, a policy engine, a sandboxed wallet and a shared counterparty check, with the key physically out of the agent's
reach. `agents`: an agent that buys services and pays on NEAR, usable from Claude Code through MCP, with pay-per-call delivery. `open`: a
hardware key, onchain refusal evidence, attested decisions and cross-chain approval from one chip fit no existing category.

MIT. See `LICENSE`.
