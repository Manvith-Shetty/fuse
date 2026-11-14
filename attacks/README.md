# attacks

Scenario suite that tries to get money out of the Fuse agent account the way a prompt-injected agent or a
compromised laptop would, and records which of the three locks stopped each attempt. Output:
`report.md` (human) and `report.json` (machine), both regenerated on every run.

## Run

```sh
# from the repo root; needs bridge/.env (SIMULATE_CHIP=1) and the testnet accounts from the bridge README
npm run attacks
# or, without touching testnet (chip-layer scenarios only; protocol/contract scenarios are skipped)
npm run attacks:dry
```

If `rpc.testnet.near.org` answers 429 (it is deprecated), point the run at another provider:
`NEAR_RPC_URL=https://test.rpc.fastnear.com npm run attacks`.

How it runs: `cd bridge && npx tsx ../attacks/src/run.ts`. The suite imports the bridge sources directly
(`../bridge/src/*.js`) and reuses `bridge/node_modules` through the `attacks/node_modules` symlink that the
npm script creates. Scenarios run sequentially because the chip tracks nonces.

## What it does

1. **Legitimate baseline.** Two real 0.001 NEAR payments through the enrolled chip (broadcast, explorer links in
   the report), then 50 legitimate `pay` decisions signed by a clone of the chip but **not broadcast**
   (testnet funds and the 3 NEAR daily cap make 50 real payments pointless). False refusals are counted.
2. **Scenarios 1-12: chip lock.** Crafted bytes are sent to the chip. Expected: the chip decodes them, refuses with
   a specific code, and signs a refusal receipt. For scenarios signed by the enrolled chip the receipt is posted
   onchain through `record_refusal` (the chip only signs that call for refusals it issued). Scenario 9 lets the
   chip sign legitimate bytes, then the bridge flips one byte of the args and broadcasts the old signature:
   NEAR rejects it, which shows the signature binds the exact bytes.
3. **Scenarios 13-16: protocol and contract locks.** A **COMPROMISED** clone of the simulated chip (same seed,
   signs anything, no decoding, no policy) is used on purpose. 13 and 14 show NEAR itself rejecting the
   transaction because the agent account's only key is a function-call key scoped to the wallet contract
   (receiver mismatch, deposit on a function call). 15 and 16 show the wallet contract refusing a payment the
   chip lock would have stopped (receiver not in allowlist, over the per-transaction cap).

| # | Attack | Expected lock |
| --- | --- | --- |
| 1 | Decoy recipient (hint says seller, bytes say attacker) | chip `RECEIVER_NOT_ALLOWED` |
| 2 | Amount cancelling (pay + transfer in one tx) | chip `MULTI_ACTION` |
| 3 | Threshold splitting (many small pays) | chip `VELOCITY_CAP` (contract daily cap behind it) |
| 4 | Method substitution (`set_policy`) | chip `METHOD_NOT_ALLOWED` |
| 5 | Receiver substitution (`ft_transfer` on another contract) | chip `WRONG_RECEIVER` |
| 6 | Deposit smuggling (1 yocto on a function call) | chip `DEPOSIT_NOT_ZERO` |
| 7 | Gas griefing (300 Tgas) | chip `GAS_TOO_HIGH` |
| 8 | Replay (same bytes twice) | chip `NONCE_REPLAY` |
| 9 | Post-approval argument change | protocol `InvalidSignature` |
| 10 | Appended action | chip `MULTI_ACTION` |
| 11 | Transfer instead of FunctionCall | chip `NOT_FUNCTION_CALL` |
| 12 | Trailing bytes | chip `TRAILING_BYTES` |
| 13 | Compromised chip calls another contract | protocol `ReceiverMismatch` |
| 14 | Compromised chip attaches a deposit | protocol `DepositWithFunctionCall` |
| 15 | Compromised chip pays a non-allowlisted receiver | contract panic |
| 16 | Compromised chip pays over the per-tx cap | contract panic |

## Honest caveats

- Self-generated and reproducible. Anyone can rerun it against the live testnet accounts.
- The chip under test is the **software simulator** (`bridge/src/chip-sim.ts`), which runs the same strict
  Borsh decoder and policy engine as the firmware (`firmware/lib/fusecore`, unit-tested against the same
  near-api-js vector). The firmware itself is not exercised by this suite until a board is attached.
- The compromised-chip mode (`unsafeSignAnything`) exists only in the simulator, is not reachable from `.env`
  or the CLI, and works only because the simulator's seed is a file. A real Fuse chip cannot be cloned or put
  into this mode; its policy is compiled into the firmware and its seed never leaves NVS.
- 50 legitimate decisions were signed, not broadcast. 2 legitimate payments were broadcast.
- Testnet, not mainnet. Refusal receipts for clone-signed scenarios (3, 8, 9) are not posted onchain because
  only the enrolled chip's receipts verify against the chip key stored in the contract.
- Contract panics currently surface as `WebAssembly trap` without the panic string (wasm built with Rust 1.87+
  on the current NEAR VM). The refusal still happens; rebuilding the contract with the Rust 1.86 toolchain
  restores readable messages.
