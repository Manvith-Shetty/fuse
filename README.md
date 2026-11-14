# Fuse

**Give your agent a budget, not your keys.**

Coding agents and autonomous agents now pay for things: an API call, a dataset, a minute of compute. Today that means
either no payments at all, or a wallet file on the machine that one poisoned web page can drain. Fuse is a small chip on
your desk that holds the only key of your agent's NEAR account. It reads every transaction itself, says no to anything
outside the budget you set, asks for your thumb above a limit, writes every refusal onchain as evidence, and is revoked
by pulling the cable. Vendors get paid per call with no accounts and no API keys, because the payment receipt on the
chain is the proof.

Built for NEAR HACKATHON 2026 in the `security`, `agents` and `open` tracks. Everything runs on testnet, and every claim
in this file says whether it ran on the real ESP32-S3, on the labelled software simulator, or has not been shown yet.

---

## What happens when an agent buys something

1. The agent (Claude Code through MCP, or any agent with the `fetch_paid_api` tool) calls a vendor URL.
2. The vendor answers `402 Payment Required` with a price and its NEAR account.
3. Fuse asks the shared refusal registry whether other chips have refused that vendor (allow, warn or block).
4. The bridge builds the NEAR transaction and hands the raw bytes to the chip. The chip decodes them itself, checks the
   vendor, token and amount against its policy, and signs. Above the thumb threshold it lights amber and waits up to
   30 seconds for the button. Outside the policy it refuses and signs a receipt instead.
5. The bridge broadcasts the signed transaction; the wallet contract re-checks the policy, counts the daily budget and
   pays the vendor. The agent retries the URL with the transaction hash, the vendor verifies it on the chain and serves.
6. If an injected instruction tried to redirect the money, step 4 ended in a refusal, the receipt is stored and verified
   by the contract, and the registry answers `block` for that address from then on, for every Fuse user.

All of this ran on the real chip on 14 November 2026. The transactions are linked further down.

## How the pieces fit

```mermaid
flowchart LR
    subgraph laptop [Your laptop]
        agent[Agent<br/>Claude Code via MCP,<br/>or the purchasing agent]
        bridge[Bridge<br/>builds transactions,<br/>holds no keys]
        ui[Frontend<br/>live view, red team,<br/>setup wizard]
    end
    subgraph chip [Fuse chip  ESP32-S3]
        fw[Firmware<br/>decodes raw bytes,<br/>enforces policy, button]
        key[(ed25519 key<br/>never leaves)]
    end
    subgraph near [NEAR testnet]
        acct[Agent account<br/>one function-call key]
        wallet[fuse-wallet contract<br/>policy, daily cap,<br/>verified refusal receipts,<br/>quorum]
        registry[fuse-registry<br/>shared refusal evidence]
        mpc[Chain Signatures<br/>Sepolia, Bitcoin]
    end
    vendor[Vendor API<br/>HTTP 402, verifies<br/>payment onchain]

    agent -- "propose: pay, fetch" --> bridge
    ui --> bridge
    bridge -- "raw transaction bytes" --> fw
    fw --- key
    fw -- "signature, or signed refusal" --> bridge
    bridge -- "broadcast" --> acct
    acct -- "pay / record_refusal" --> wallet
    wallet -- "refusal evidence" --> registry
    wallet -- "request_chain_sig" --> mpc
    bridge -- "check vendor" --> registry
    agent -- "402, then retry with tx hash" --> vendor
    vendor -- "reads the payment" --> wallet
```

Three independent locks enforce the same budget, so any one of them failing still bounds the loss:

- **Protocol.** The agent account has exactly one access key, a NEAR function-call key scoped to the wallet contract and
  three methods. Even a stolen chip cannot transfer NEAR, call another contract or add a key.
- **Silicon.** The firmware decodes the Borsh bytes itself and never trusts the laptop's description. Allowlisted vendors
  and tokens, a per-payment cap, a velocity cap, the button above a threshold, the firmware hash in every payment, and a
  policy that only the owner's signed message can change.
- **Contract.** The onchain wallet re-checks the policy, enforces the daily cap, can be paused, verifies every refusal
  receipt before storing it, parks large payments until a second chip approves, and forwards counterparty refusals to
  the shared registry.

The verdict words are the ones the organisers used: **allow** (inside the budget, the chip signs), **warn** (above the
thumb threshold or the quorum line, a human or a second chip is needed), **block** (refused, receipt onchain).

## Try it in five minutes, no hardware

You need Node 22 and `near-cli-rs` (`npm i -g near-cli-rs`). No Rust: the contract bytes deployed on testnet are
committed under `contracts/fuse-wallet/res/` with checksums.

```sh
cd bridge && npm i && npm test
#   see: 21 tests passed (decoder, policy, simulated chip, protocol v2)
npx tsx scripts/bootstrap.ts fuse-judge-$RANDOM
#   creates <prefix>.testnet from the faucet, deploys the wallet contract, enrols the simulated chip, writes bridge/.env
npm run fuse -- keys
#   see: exactly one key on the agent account, permission FunctionCall, receiver fuse.<prefix>.testnet
npm run fuse -- pay -r api.<prefix>.testnet -t near -a 100000000000000000000000 -m "api call"
#   see: {"ok":true,"mode":"SIMULATED","explorer":"https://testnet.nearblocks.io/txns/..."}
npm run fuse -- pay -r attacker.testnet -t near -a 1000000000000000000000
#   see: {"ok":false,"code":"RECEIVER_NOT_ALLOWED","refusal":{"recorded":true,...}}
npm run fuse -- audit
#   see: data/audit/audit-<time>.md with every receipt re-verified against the chip key
```

Then the live pieces, each in its own terminal:

```sh
cd bridge && npm run fuse -- serve                  # bridge API on 127.0.0.1:7777
cd seller && npm i && npm start                     # a vendor that charges per call over HTTP 402
cd agent && npm i && npx tsx src/index.ts serve     # the red-team endpoint
cd frontend && npm i && npm run dev                 # the product UI on http://localhost:3000
```

Open the UI. The Live page pays the vendor with one click and injects an attack with another. The Red team page lets
anyone paste a document and watch the chip decide. Stop the bridge and the page says AGENT REVOKED within two seconds.

### With Claude Code

```sh
cd mcp && npm i && npm run build && claude mcp add fuse -- node "$PWD/dist/index.js"
```

Then ask Claude Code: "Call fuse_budget, then fetch http://127.0.0.1:7779/service/weather?city=Bengaluru with fuse_fetch."
It reads its budget in plain words, gets a 402 with a price, the chip signs 0.001 NEAR, and the vendor serves the data
after reading the payment from the chain. Paste `agent/fixtures/poisoned-invoice.md` and ask it to follow the invoice:
the chip refuses the 0.5 NEAR to attacker.testnet and the receipt lands onchain.

### With the chip

`firmware/README.md` covers flashing (`pio run -e esp32s3_usb -t upload` on the board's native USB port). After that,
point the bridge at the serial port, send the policy (signed by the owner, confirmed with the button) and enrol the
chip as the agent account's only key. Every command above then reports `mode: HARDWARE`. `docs/windows-setup.md` has the
Windows specifics and the LED language.

### Setting up from the UI, no env files

The frontend has a setup wizard. You connect your NEAR wallet (Meteor, MyNearWallet, HOT or Nightly), plug the chip in,
and your wallet signs two transactions: one creates the wallet contract and deploys it, the other creates the agent
account with the chip's public key as its only key from the first block. The accounts are saved to the bridge, and the
wallet signs the chip's policy as a NEP-413 message before you press the button. The same flow works on mainnet;
`docs/mainnet.md` lists what changes and what it costs.

## What is real

| Claim | Status | Evidence |
| --- | --- | --- |
| The agent account has one key, generated on the ESP32-S3, scoped to the wallet contract | Real chip | [enrol tx](https://testnet.nearblocks.io/txns/GmXiVtRXmm2m9cAw6ysWJehmZsNv1RnBnqUMd3D15RDj), [account](https://testnet.nearblocks.io/address/agent-s3.fuse-hack-2026.testnet) |
| A payment signed by the chip executed onchain, carrying the firmware hash the contract allowlists | Real chip | [FRNvNcrF…](https://testnet.nearblocks.io/txns/FRNvNcrFuznSzdvzBneBWuJt8znonrt6wxK6HHHxkSr4) |
| An injected payment was refused, the receipt verified and stored, and forwarded to the shared registry | Real chip | [receipt #17](https://testnet.nearblocks.io/txns/AEDpx3pH4F3ZLnGEVdjgxGpAEYHr7XLgVYsYqhb8ysaa); registry says block for attacker.testnet from three chips |
| Claude Code bought a pay-per-call API through the chip with one tool, and the vendor verified the payment | Real chip | [2HFVg7zi…](https://testnet.nearblocks.io/txns/2HFVg7zizUBmRMKwJVkWHzEJTSUeVhRMybxJBMCAeT1m) |
| A free-text attack pasted on the Red team page died at the chip while the legitimate purchase went through | Real chip | [receipt #19](https://testnet.nearblocks.io/txns/DTLb2Q9FTFpdP7qLn1P5SCzPSTNw9FqBQQJL2eZkWATw) |
| Payments above a threshold need the physical button; a missed press is refused and recorded | Real chip | [0.6 NEAR after the press](https://testnet.nearblocks.io/txns/AnP5Q2Zz9aY3NKGPewhXUVjYqP6EHRckEQzHseARah5a) |
| The chip's policy is signed by the owner's key and only changes with a higher sequence plus the button | Real chip | policy_seq 1 bound on hardware; the wallet-style NEP-413 signature verified on the chip |
| A payment above the quorum line was parked and released only by a second chip | Real chain, two simulators | [parked](https://testnet.nearblocks.io/txns/36xNoegsxUzyaxZjcDZ8Pcw19erNV6czq5kvqKZo2cnt), [approved](https://testnet.nearblocks.io/txns/4PG3Qem51KvyC3FqFkgJTuhdTxsmnJo4rThg5Ptvvyx7) |
| The setup wizard's transactions are accepted by the chain exactly as the UI builds them | Real chain | [create + deploy](https://testnet.nearblocks.io/txns/GVoNnH4eZP2s1a3D9qMHPRqPr5vCNcsjYtvNbYKivX2q), [agent with one key](https://testnet.nearblocks.io/txns/7yJFspBcvtapStXAdR4NNn7ZiS5e5S9GUoXPbf3Ei6qc) |
| 16 attack scenarios stopped, 0 of 50 legitimate decisions refused | Simulator, self-generated | `attacks/report.md`, regenerate with `npm run attacks` |
| The same chip signs for Ethereum Sepolia and Bitcoin testnet4 through Chain Signatures | Derived, unfunded | MPC signature recovered to the derived Sepolia address; Bitcoin address `tb1q46t7q…gp6` |
| The chip verifies that a TEE-attested model actually made the decision | Simulator only | wired end to end, not yet run against NEAR AI Cloud |

The complete list, with every transaction, is `docs/claims-ledger.md`. The live accounts are
[fuse.fuse-hack-2026.testnet](https://testnet.nearblocks.io/address/fuse.fuse-hack-2026.testnet) (wallet contract, v2),
[agent-s3.fuse-hack-2026.testnet](https://testnet.nearblocks.io/address/agent-s3.fuse-hack-2026.testnet) (agent) and
[registry.fuse-v2-sdgt.testnet](https://testnet.nearblocks.io/address/registry.fuse-v2-sdgt.testnet) (registry).

## Where things live

- `firmware/` is the ESP32 signer: a strict Borsh decoder and policy engine tested on the host, the serial protocol, the
  key store in flash, the LED and the button. 21 native tests including a 200,000-case mutation fuzz.
- `contracts/fuse-wallet/` is the onchain lock, written in Rust with near-sdk, 46 tests, with a migration from the
  first version. `contracts/fuse-registry/` is the shared refusal registry, 27 tests. `res/` holds the deployed bytes.
- `bridge/` is the untrusted relay: it builds transactions, talks to the chip over USB, broadcasts, serves the local API,
  runs the simulator for the no-hardware path, exports audits and holds the setup endpoints. 21 tests.
- `agent/` is the purchasing agent (NEAR AI Cloud or a labelled scripted fallback), the red-team server and tool exports
  for other frameworks. `seller/` is a vendor that charges per call and trusts only the chain. `mcp/` lets Claude Code use
  the chip as its wallet.
- `frontend/` is the product UI: the story, the live view, the red-team page, audit, counterparty, policy and the setup
  wizard. `dashboard/` is the older minimal view. `attacks/` is the scenario suite.
- `docs/` holds the threat model, the serial protocol and byte layouts, the v2 specification and deployments, the claims
  ledger, the demo script, the use case, the mainnet path, the hardware roadmap and secure-boot notes, and the
  organisers' track prompts.

## Honest limits

A development board is not a hardware security module: secure boot and flash encryption are the production step and
are documented, not enabled, so the firmware hash the chip reports is self-asserted for now. The simulator is software
and says so in every response. The chip has no clock, so the daily cap lives onchain and the chip enforces a velocity
window. Everything is on testnet; the cross-chain legs sign for addresses a human still has to fund, and NEAR Intents is
mainnet-only, so the bridge only produces dry quotes. The attack report is self-generated and reproducible. The
TEE-decision path is wired but has not run against NEAR AI Cloud. The shared registry is advisory and can be gamed
without trusted reporters.

## Where this stands next to other work

EspWarden put a policy signer on an ESP32 for Ethereum bots; Fuse adds NEAR's function-call key scoping as a
protocol-level lock, refusals as shared onchain evidence, owner-signed policy, quorum, attested decisions and the MCP
path for coding agents. NEAR's own Intents Agent API keeps the policy on a hosted server; in Fuse it lives in silicon
you hold plus the contract, with no hosted party to trust and revocation by cable. Ledger's agent stack has a human
approve each transaction on a device; the Fuse chip enforces the policy itself, so the human is only needed above a
threshold and the agent runs unattended within bounds. LeekWallet is a do-it-yourself hardware wallet for people; Fuse
is a budget key for agents, with no screen, no blind-signing override, and a policy instead of a prompt.

MIT licence. See `LICENSE`.
