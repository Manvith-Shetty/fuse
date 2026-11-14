# Fuse v2 contracts: testnet deployment log

Date: 2026-11-14. Fresh accounts only; the live v1 deployment (`fuse.fuse-hack-2026.testnet`,
`agent-s3.fuse-hack-2026.testnet`, `fuse-hack-2026.testnet`) was not touched. RPC: `https://test.rpc.fastnear.com`
(near-cli-rs 0.31.1 `network-config testnet`). No private key is stored in the repo; the accounts' keys live in
`%USERPROFILE%\.near-credentials\testnet\` (legacy keychain) on the build laptop.

Explorer: `https://testnet.nearblocks.io/address/<account>` and `https://testnet.nearblocks.io/txns/<tx>`.

## Accounts

| Account | Role | Funding | Created by tx |
| --- | --- | --- | --- |
| `fuse-v2-sdgt.testnet` | owner | faucet, 10 NEAR | `6yZRRMNQFWo2JbWxMVooxB1uhSnrr8MTiK8ZaNqiGHiS` |
| `fuse-v2-sdgt-fund.testnet` | second faucet account; sent 9.5 NEAR to the owner (10 NEAR did not cover registry 2 + wallet 4 + agent 1 + a 3.5 NEAR v1-migration account + gas) | faucet | create `2oVnEGPMeqaYajbBZc3aB6CmrmLQQvmFYoujBWkCHk9b`, transfer `DbexaiYm2wBpSX4ULEfrP1dfr6fS5AK3vEQf4sTa81Kp` |
| `registry.fuse-v2-sdgt.testnet` | fuse-registry | 2 NEAR | `rZBrGDnJLB6jS32YnzH1DH9r3Wmqt2gS84pgnFm1WkH` |
| `fuse.fuse-v2-sdgt.testnet` | fuse-wallet v2 (fresh `new`) | 4 NEAR | `6cVrcmpnEEq7Vx4UhmoVDuB5beHNWoq4G7ygqwHx63qS` |
| `agent.fuse-v2-sdgt.testnet` | agent account of both wallets (keeps its generated full-access key: no chip was enrolled on this deployment) | 1 NEAR | `3pmhKaSJDjyCr9jRokmGnsN2djnrRoduRVWnitAV9QmB` |
| `fusev1.fuse-v2-sdgt.testnet` | v1 wasm, then upgraded in place with `migrate()` | 3.5 NEAR | `Fit3tmnSsVaEqfwmBBLmPiiix8fFpf6y9Kh5qJePza2X` |
| `api.fuse-v2-sdgt.testnet` | receiver in the policy allowlist | 0.1 NEAR | `FCaZJhyVZ3pj2nAWinbAZMx48oPM8SM3qSj4e7Kr2JWf` |

Init args used for both wallets (same shape as `bridge/scripts/bootstrap.ts`):
```json
{"owner":"fuse-v2-sdgt.testnet","agent":"agent.fuse-v2-sdgt.testnet",
 "chip_pubkey":"ed25519:FewvEQf9D5bUqNkf3EDPUzySFdFKuCGrQ5buiKj3HoHF",
 "policy":{"receiver_allowlist":["api.fuse-v2-sdgt.testnet"],"token_allowlist":["near"],
  "per_tx_cap":"1000000000000000000000000","daily_cap":"3000000000000000000000000",
  "chain_dest_allowlist":[{"chain":"eth-sepolia","to":"0x000000000000000000000000000000000000dead"}],
  "chain_value_cap":"1000000000000000"}}
```

## 1. v1 wallet on `fusev1.fuse-v2-sdgt.testnet` (state to migrate)

| Step | Tx |
| --- | --- |
| deploy `contracts/fuse-wallet/res/fuse_wallet.wasm` (v1 bytes, sha256 `9caf436b...cbba9`) with `new` | `731mYDzqMTffycgFKe6UfZ48GR1i3qQVH6rEHjGCTv45` |
| v1 `pay` 0.01 NEAR to `api.fuse-v2-sdgt.testnet` (signed by `agent.`, memo "v1 before migrate") -> status `ok` | `HyjAyPiHgkwNn1qETSApotJsuQ2P9wFPCunCiZE7XQq` |
| `set_chip_key` to a throwaway test key `f7fda8a117af9a5c71ecb33556037bbce12b9d5570f64e635ffaad7d0630a364` (the real chip is not on this machine; the key lives only in a scratch folder) | `5wUahju9272QEirtDihoLGPGFhRrmNFtbzFTX4K59SzW` |
| v1 `record_refusal` tx_hash `07..07`, code 13, counter 1, v1 receipt signed by the test key (no `receiver`/`version`) | `1SRtoNXZzyZ4h7EU2J8JvxM16cDDxcZGywGkX4bd9Rj` |

`get_counts` before migration: `{"payments":1,"refusals":1,"chain_sigs":0}`; `get_payments(0,5)[0].status == "ok"`.
`get_state` (v1): owner `fuse-v2-sdgt.testnet`, chip `ed25519:FewvEQf9D5bUqNkf3EDPUzySFdFKuCGrQ5buiKj3HoHF` before `set_chip_key`, `paused: false`.

## 2. Builds

`cargo near build non-reproducible-wasm --no-abi` (cargo-near 0.23.0 prebuilt; the ABI step links the crate as a
host .dll on Windows and fails on the near-sys externs, so the ABI is skipped). Rust 1.100 stable, near-sdk 5.30.1.

| File | Size | sha256 |
| --- | --- | --- |
| `contracts/fuse-wallet/res/fuse_wallet.wasm` (v1, unchanged) | 252,980 B | `9caf436bd0e3f184b7efd324a6b860ca37d85138c5ce429bd310d85c256cbba9` |
| `contracts/fuse-wallet/res/fuse_wallet_v2.wasm` | 278,412 B | `27428aea1ad6de941ca7b052c88f1ec43cfae65035941726ee681e7953d97867` |
| `contracts/fuse-registry/res/fuse_registry.wasm` | 199,805 B | `0e468d120586ed1628c875150f57f3c17197c420f577fcf1be063298b8f44d41` |

Unit tests: fuse-wallet `45 passed; 0 failed`, fuse-registry `21 passed; 0 failed`.

## 3. fuse-registry on `registry.fuse-v2-sdgt.testnet`

| Step | Tx |
| --- | --- |
| first deploy with 2 NEAR: `Receipt action can't be completed, because the remaining balance will not be enough to cover storage` (200 KB wasm needs ~2 NEAR + state) | `BHegYbf6Z1vBxPBgaBGNQSW39EeLEK7RX3iLNQ6hDPtp` |
| owner tops up +1 NEAR | `2i6kdmfZFVEL51FEg6a1KsMNdNsnoUrvHmWCmVVYeHpT` |
| deploy `fuse_registry.wasm` with `new {"owner":"fuse-v2-sdgt.testnet"}` | `k1CZUsHhy7Xw9sxHW33PGGky9mSqJBJXgwf2iD4REco` |

Views right after deploy:
```
stats -> {"receivers":0,"reporters":0,"reports":0,"trusted":0}
check {"receiver":"attacker.testnet"} -> {"verdict":"allow","reports":0,"distinct_reporters":0,"distinct_chips":0,
  "bound_reports":0,"bound_chips":0,"trusted_reports":0,"bound_weight":0,"last_ts":"0","manual":null,"top_codes":[]}
```
Account after deploy: 2.9967 NEAR, storage 200.1 KB.

## 4. fuse-wallet v2 (fresh) on `fuse.fuse-v2-sdgt.testnet`

| Step | Tx |
| --- | --- |
| deploy `fuse_wallet_v2.wasm` with `new` (init args above) | `GzqyiHCARqdzXi4keMkMzwshUXe36w4bqR8wv1KXk8jb` |
| `set_registry {"registry":"registry.fuse-v2-sdgt.testnet"}` (owner); log `EVENT_JSON:{"standard":"fuse","version":"2.0.0","event":"config_update","data":[{"field":"registry","value":"registry.fuse-v2-sdgt.testnet"}]}` | `6VwBAb8uHXGJg5XYRfZ4CEaepZnETihcW2bEuNAJoxfU` |

Views:
```
get_state  -> {"agent":"agent.fuse-v2-sdgt.testnet","chain_sig_contract":"v1.signer-prod.testnet","chain_sig_deposit":"1",
               "chip_pubkey_b58":"ed25519:FewvEQf9D5bUqNkf3EDPUzySFdFKuCGrQ5buiKj3HoHF",
               "chip_pubkey_hex":"d9bc33dfe5f14f8574680d330ee340cb9296be7a7ec5c2f86039ee1be85f6806",
               "last_refusal_counter":0,"owner":"fuse-v2-sdgt.testnet","paused":false}
get_config -> {"allowed_fw":[],"approvers":[],"quorum_threshold":"0","registry":"registry.fuse-v2-sdgt.testnet"}
get_counts -> {"chain_sigs":0,"payments":0,"pending":0,"refusals":0}
compute_refusal_digest_v2 {"tx_hash":"0102..1f20","code":13,"counter":7,"receiver":"attacker.testnet"}
           -> "3091912debd71ecc48be63e3b950242d42d9f9312bf742ab25a0cfb4b972eae3"   (= the bridge's test vector)
```
Account after deploy: 3.9978 NEAR, storage 279.0 KB (keep the balance above payments + ~2.8 NEAR).
Not done on this deployment: enrolling a chip key on `agent.fuse-v2-sdgt.testnet` (no chip on this machine); the
agent account keeps its generated full-access key, so CLI calls signed as the agent stand in for the chip.

## 5. Migration v1 -> v2 on `fusev1.fuse-v2-sdgt.testnet`

| Step | Tx |
| --- | --- |
| redeploy with `near contract deploy fusev1.fuse-v2-sdgt.testnet use-file contracts/fuse-wallet/res/fuse_wallet_v2.wasm with-init-call migrate json-args {} prepaid-gas 100Tgas attached-deposit 0NEAR`; log `EVENT_JSON:{"standard":"fuse","version":"2.0.0","event":"migrate","data":[{"from":"1.0.0","refusals":1}]}` | `J3HBBSqu6KajukHd97gEyHgewGiFrdwmWzukPuyvqe3k` |

Views after `migrate`:
```
get_config   -> {"allowed_fw":[],"approvers":[],"quorum_threshold":"0","registry":null}
get_counts   -> {"chain_sigs":0,"payments":1,"pending":0,"refusals":1}
get_state    -> owner fuse-v2-sdgt.testnet, agent agent.fuse-v2-sdgt.testnet, chip f7fda8a1...a364 (the test key), last_refusal_counter 1
get_payments -> [{"amount":"10000000000000000000000","memo":"v1 before migrate","status":"ok", ...}]      (v1 record kept)
get_refusals -> [{"id":0,"code":13,"counter":1,"tx_hash_hex":"07..07","receiver":null,"version":1, ...}]  (v1 record copied, tagged version 1)
```

### Live registry cross-call on the migrated wallet
| Step | Tx |
| --- | --- |
| `set_registry` (owner) | `aWhykmuZJEgReCPw9eud4CaZr9Mv3k7pc3Ru9aLvfTR` |
| `record_refusal` v2 signed as the agent, 50 Tgas: tx_hash `0102..1f20`, code 13, counter 2, `receiver: "attacker.testnet"`, `version: 2`, receipt signed by the test chip key over `digest_v2 = 374978de314efc14300385cd6e8719b66ce9637bd9bd2f43fd82c7c12a4870e1` | `UFyV2yo2fBcjwterNtuHGHekAToJkaZdc8STiKx5iij` |

Logs of that tx (wallet, then the registry receipt):
```
EVENT_JSON:{"standard":"fuse","version":"2.0.0","event":"refusal","data":[{"id":1,"tx_hash":"0102...1f20","code":13,"counter":2,"receiver":"attacker.testnet","version":2}]}
EVENT_JSON:{"standard":"fuse-registry","version":"1.0.0","event":"report","data":[{"id":0,"receiver":"attacker.testnet","reporter":"fusev1.fuse-v2-sdgt.testnet","chip_pubkey_hex":"f7fda8a1...a364","code":13,"counter":2,"bound":true,"trusted":false}]}
```
Registry afterwards:
```
check {"receiver":"attacker.testnet"} -> {"verdict":"warn","reports":1,"distinct_reporters":1,"distinct_chips":1,"bound_reports":1,
  "bound_chips":1,"trusted_reports":0,"bound_weight":1,"last_ts":"1794605748758356635","manual":null,"top_codes":[[13,1]]}
get_reports {"receiver":"attacker.testnet","from":0,"limit":5} -> one Report, reporter fusev1.fuse-v2-sdgt.testnet, bound true, version 2
stats -> {"receivers":1,"reporters":1,"reports":1,"trusted":0}
```
`fusev1.get_refusals(1,1)` -> `{"code":13,"counter":2,"receiver":"attacker.testnet","version":2}`.

## Notes for the other streams
- `record_refusal` with a registry set needs >= 50 Tgas prepaid (20 Tgas go to `report`); the bridge default of 30 Tgas
  is too tight. The chip's `GAS_TOO_HIGH` cap must allow it.
- `approve_payment` must be added to the agent key's method list (and the chip policy `methods`) for chips that approve.
- A `pending` payment returns `false` from `pay` and emits `pay_pending`; the bridge should show `get_pending`.

## 2026-11-14 03:30 IST: counterparty-code filter, redeploys, and a full bridge integration run

Change: the wallet forwards only counterparty refusal codes (13 RECEIVER_NOT_ALLOWED, 14 TOKEN_NOT_ALLOWED, 19 CHAIN_DEST_NOT_ALLOWED)
to the registry; the registry rejects any other code (`allowed_codes` view) and the owner can `clear_reports(receiver)`.
Tests: fuse-wallet 46 passed, fuse-registry 27 passed.

| Artifact | Size | sha256 |
| --- | --- | --- |
| `contracts/fuse-wallet/res/fuse_wallet_v2.wasm` | 278,493 B | `42c124c8f365c6b990aa06387963e70174c8df03859aafd36ec75cc70b0f12df` |
| `contracts/fuse-registry/res/fuse_registry.wasm` | 202,221 B | `46fea6e5528eb8a955e4189d365c2b20541fd98ff27ddfab46cf469bc745cc9d` |

Redeploys in place (state kept): registry `4XiGV8u4kn1Z9r8iU3WX5sQrzekHxbN3uFcwAvJGmwfm`, `fuse.fuse-v2-sdgt.testnet` `7o6z1VvwPdnxvcQwsghrqrHXPaWDdisXnzfknPyp5h5R`,
`fuse.fuse-sim-5607.testnet` `C6BCes91jdSpzZMFVYMTtiZt8oijENTGw1ff7mHM595Q`. `clear_reports api.fuse-sim-5607.testnet` removed the one stray
AMOUNT_OVER_CAP report made before the filter existed.

### Bridge integration run on a fresh deployment (`bridge/scripts/bootstrap.ts fuse-sim-5607`, SIMULATED chip, v2 wasm)
Accounts: owner `fuse-sim-5607.testnet`, wallet `fuse.fuse-sim-5607.testnet`, agent `agent.fuse-sim-5607.testnet` (simulator key
`ed25519:En9fY4LSKgNEmDB3yzC2QkJDbLGvsxB8Jxbr9jT6h4h7`, enrol `BNrUf6aaqTf9AEngxrT689NzmJZWZ86d4h2ZML8HXQqA`), seller `api.fuse-sim-5607.testnet`,
approver `approver.fuse-sim-5607.testnet` (second simulator `ed25519:5sKhxKuAMpGUvD1BNZAGCLVHNA8rGWofn92T4F6aTm51`, function-call key for
`approve_payment` only, enrol `3n7fwJ9YiiJgTBJkdNcQ3dn93HRMc1mUJgaykkPBU9ae`). Owner config: `set_registry registry.fuse-v2-sdgt.testnet`,
`set_allowed_fw ["77c3af83…aecf"]` (the simulator's attested hash), `set_quorum_threshold 0.6 NEAR`, `set_approvers [approver]`.

| Step | Result | Tx |
| --- | --- | --- |
| pay 0.1 NEAR to the seller (bridge adds `fw`) | ok, counterparty allow | `DYc1EzUKaMorAx5ccHKugnQ5xHiagJguq9e2pp12PwVa` |
| pay to attacker.testnet | RECEIVER_NOT_ALLOWED, receipt v2 (receiver bound) recorded | `JA9vZ2BUaTz46WjQdsoG8wPF7U8cmUS5BYDZvMqX7D9h` |
| same, after `set_registry` | recorded and forwarded; registry `check attacker.testnet` → **block** (2 distinct chips: this wallet and `fusev1.fuse-v2-sdgt`) | `74isMJVzEnMCyKEKU48B1y3nSZBbJicj5oYxA2r9Y9NJ` |
| pay 0.1 NEAR with `allowed_fw` active | ok | `5Tssu5zfxHpUdZV5pWqAZuZ11HiF8J4Mwr387R1nxdKK` |
| pay 0.8 NEAR (above quorum 0.6 and button 0.5, under per-tx cap 1) | signed after the button, contract parked it: `pending: true`, `get_pending` lists id 2 | `36xNoegsxUzyaxZjcDZ8Pcw19erNV6czq5kvqKZo2cnt` |
| `fuse approve 2` from the approver chip's bridge | approved after its button; payment 2 status `ok` | `4PG3Qem51KvyC3FqFkgJTuhdTxsmnJo4rThg5Ptvvyx7` |

Bootstrap fixes for Windows found on the way: `near`/`npx` are `.cmd` shims that `execFileSync` cannot spawn (now the real `near.exe`
and `node + tsx` are used); `DATA_DIR`/`FUSE_DATA_DIR` must be Windows paths (`D:/...`), a POSIX `/d/...` path resolves to `D:\d\...`.
