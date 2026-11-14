# contracts/fuse-wallet

The onchain lock of Fuse. Holds the agent's funds, re-checks the chip's policy, counts daily spend,
records the chip's signed refusal receipts, and forwards cross-chain signing requests to the NEAR Chain
Signatures (MPC) contract. v2 adds a firmware-hash allowlist, a quorum (large payments wait for an
approver), receiver-bound refusal receipts and a fire-and-forget report to `fuse-registry`.

Rust, near-sdk 5.30.1. 45 unit tests. Built wasms in `res/`: `fuse_wallet.wasm` (v1, deployed at
`fuse.fuse-hack-2026.testnet`) and `fuse_wallet_v2.wasm` (v2, `docs/v2-deploy.md`); `res/SHA256SUMS`.

Compatibility: a v1 chip calls `pay` without `fw` and `record_refusal` without `receiver`/`version`;
both keep working. Every v2 check is off until the owner turns it on (`set_allowed_fw`,
`set_quorum_threshold`, `set_registry`). `migrate()` upgrades a v1 deployment in place.

## Account model

| Account | Keys | Role |
| --- | --- | --- |
| `<owner>.testnet` | your wallet's full-access key | owner: deploys, funds, sets policy, pauses, withdraws |
| `fuse.<owner>.testnet` | owner's deploy key (may be removed after deploy) | this contract, holds the funds |
| `agent.<owner>.testnet` | **only** the chip's function-call key -> `fuse.<owner>.testnet`, methods `pay,record_refusal,request_chain_sig`, unlimited allowance | the AI agent's identity |

Because the agent account has one function-call key, every `pay`, `record_refusal` and
`request_chain_sig` that reaches this contract was signed by the chip. The contract checks
`predecessor_account_id == agent` and nothing else about the caller.

## Interface

### Agent-only (predecessor must be the agent account, contract not paused)
| Method | Args | Effect |
| --- | --- | --- |
| `pay` | `receiver: AccountId, token: AccountId, amount: U128, memo: Option<String>, fw: Option<String>` | if `allowed_fw` is non-empty, `fw` (hex sha256 of the firmware, from `hello.fw_sha256`) must be in it (`pay: firmware not allowed`); allowlists + per-tx cap + daily cap; if `quorum_threshold > 0 && amount > quorum_threshold`: record status `pending`, count the daily cap now, emit `pay_pending`, return `false` (no transfer); else `token == "near"` transfers NEAR, else `ft_transfer` on `token` (1 yocto, 30 Tgas); records `PaymentRecord`; emits `pay`; callback `on_pay_result` marks `ok`/`failed` and refunds the daily budget on failure |
| `approve_payment` | `id: u64` | predecessor must be in `approvers` (an approver's chip signs this through its own agent account); the `pending` record is released with the same transfer + callback; emits `pay_approved {id, by}` |
| `record_refusal` | `tx_hash: String (hex or base58, 32 B), code: u8, counter: u32, receipt_sig: String (base64, 64 B), receiver: Option<AccountId>, version: Option<u8>` | v1 (no `receiver`, `version` absent or 1): digest `sha256("FUSE_REFUSAL_V1" ‖ tx_hash ‖ code ‖ counter_le)`; v2 (`version` 2 or `receiver` present): `sha256("FUSE_REFUSAL_V2" ‖ tx_hash ‖ code ‖ counter_le ‖ receiver_hash)` with `receiver_hash = sha256(receiver)` or 32 zero bytes; verifies `ed25519(chip_pubkey)`; `counter` must strictly increase; stores `RefusalRecord {.., receiver, version}`; emits `refusal`; if `registry` is set and `receiver` is present, fire-and-forget `registry.report(chip_pubkey_hex, receiver, tx_hash_hex, code, counter, receipt_sig, version)` with 20 Tgas (attach >= 50 Tgas to `record_refusal`) |
| `request_chain_sig` (payable) | `path: String, payload: String (base64), domain_id: u32 (0 ecdsa / 1 eddsa), chain: String, to: String, value: U128, fw: Option<String>` | same `fw` rule as `pay`; `(chain, lowercase(to))` must be in `chain_dest_allowlist`, `value <= chain_value_cap`; calls MPC `sign` with `{"request": {"path", "payload_v2": {"Ecdsa"\|"Eddsa": hex}, "domain_id"}}` (1 yocto, 200 Tgas); callback `on_chain_sig` stores the raw result JSON; emits `chain_sig_request` then `chain_sig` |

### Owner-only
`set_policy(policy)`, `set_chip_key(chip_pubkey: String hex|base58|"ed25519:..")` (resets the refusal
counter), `set_agent(agent)`, `set_chain_sig_contract(account, deposit: U128)`,
`withdraw(token, amount, to)`, `pause()`, `unpause()`.

v2: `set_allowed_fw(allowed_fw: Vec<String>)` (hex sha256 list, lowercased and deduplicated; empty = off),
`set_approvers(approvers: Vec<AccountId>)`, `set_quorum_threshold(quorum_threshold: U128)` (0 = off),
`set_registry(registry: Option<AccountId>)`, `cancel_pending(id)` (status `cancelled`, refunds that day's
budget). Each emits `config_update {field, value}`.

### Views
`get_policy()`, `get_state()`, `get_payments(from_index, limit)`, `get_refusals(from_index, limit)`,
`get_daily_spent()` (today, UTC day of the current block, summed across tokens),
`get_chain_sig_result(id)`, `get_counts()` (`{payments, refusals, chain_sigs, pending}`),
`compute_refusal_digest(tx_hash, code, counter)` (hex; use it to check the firmware's and bridge's encoding).

v2: `get_config() -> {allowed_fw, approvers, quorum_threshold, registry}`, `get_pending(from, limit)`
(records with status `pending`, oldest first), `compute_refusal_digest_v2(tx_hash, code, counter, receiver?)`.

### Upgrade from v1
`migrate()` is `#[private] #[init(ignore_state)]`: it reads the v1 state, keeps every field and
collection, copies the refusal records into a v2 vector (two new optional fields) and sets the new
fields to "off". Deploy the v2 wasm to the v1 account with
`with-init-call migrate json-args {}` (see `docs/v2-deploy.md` for the live run). The agent account's
function-call key may also need `approve_payment` in its method list if that chip will approve.

### Policy
```json
{
  "receiver_allowlist": ["api.testnet"],
  "token_allowlist": ["near", "usdc.fakes.testnet"],
  "per_tx_cap": "5000000",
  "daily_cap": "20000000",
  "chain_dest_allowlist": [{ "chain": "eth-sepolia", "to": "0x1111111111111111111111111111111111111111" }],
  "chain_value_cap": "1000000000000000"
}
```
Amounts are atomic units as strings (U128). The daily cap is one coarse number across tokens on purpose.
Chain destination addresses must be lowercase.

### Events (NEP-297, `EVENT_JSON:` log prefix, `standard: "fuse"`, `version: "2.0.0"`)
| event | data |
| --- | --- |
| `pay` | `{id, receiver, token, amount, memo, day, daily_total}` |
| `pay_pending` | same fields as `pay`; the transfer waits for `approve_payment` |
| `pay_approved` | `{id, by}` |
| `pay_cancelled` | `{id, by}` |
| `pay_result` | `{id, ok}` |
| `refusal` | `{id, tx_hash, code, counter, receiver, version}` |
| `config_update` | `{field, value}` |
| `migrate` | `{from, refusals}` |
| `chain_sig_request` | `{id, path, chain, to, value, domain_id}` |
| `chain_sig` | `{id, status}` |
| `policy_update`, `chip_key_update`, `agent_update`, `pause` | small objects |

## Build and test

```sh
cargo test                                  # 45 unit tests (near-sdk unit-testing backed by nearcore host fns)
cargo near build non-reproducible-wasm      # -> target/near/fuse_wallet.wasm (+ ABI)
# Windows: add --no-abi (the ABI step links the crate as a host .dll and fails on near-sys externs)
# fallback without cargo-near: cargo build --target wasm32-unknown-unknown --release, then wasm-opt -Oz
```
cargo-near 0.16 prints "wasm compiled with 1.87.0 or newer ... not compatible with nearcore VM". This is
stale: near-sdk 5.30 requires Rust 1.95 and its changelog drops the rust-version workarounds "now that MSRV
is 1.93 / PV 84" (nearcore protocol version 84). The wasm-opt post-step runs. Treat the first testnet
deploy below as the live check; if a call fails with `CompilationError(PrepareError(Deserialization))`,
pin `rust-toolchain.toml` to `1.86.0` and `near-sdk = "5.26.0"`.

## Deploy on testnet (near-cli-rs 0.31)

Replace `OWNER` with your owner account name (without `.testnet`) and `CHIP_PK` with the chip's public key
printed by the firmware `hello` (`ed25519:...`).

```sh
# 0. owner account (once)
near account create-account sponsor-by-faucet-service OWNER.testnet autogenerate-new-keypair save-to-keychain network-config testnet create

# 1. contract account, funded by the owner
near account create-account fund-myself fuse.OWNER.testnet '5 NEAR' autogenerate-new-keypair save-to-keychain sign-as OWNER.testnet network-config testnet sign-with-keychain send

# 2. agent account, funded for gas (the chip key only caps gas, the account still pays it)
near account create-account fund-myself agent.OWNER.testnet '2 NEAR' autogenerate-new-keypair save-to-keychain sign-as OWNER.testnet network-config testnet sign-with-keychain send

# 3. deploy + init
near contract deploy fuse.OWNER.testnet use-file ./target/near/fuse_wallet.wasm \
  with-init-call new json-args '{
    "owner": "OWNER.testnet",
    "agent": "agent.OWNER.testnet",
    "chip_pubkey": "CHIP_PK",
    "policy": {
      "receiver_allowlist": ["api.testnet"],
      "token_allowlist": ["near"],
      "per_tx_cap": "100000000000000000000000",
      "daily_cap":  "500000000000000000000000",
      "chain_dest_allowlist": [],
      "chain_value_cap": "0"
    }
  }' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send

# 4. add the chip key to the agent account as a function-call key (no --allowance = unlimited gas allowance)
near account add-key agent.OWNER.testnet grant-function-call-access \
  --contract-account-id fuse.OWNER.testnet \
  --function-names pay,record_refusal,request_chain_sig \
  use-manually-provided-public-key CHIP_PK network-config testnet sign-with-keychain send

# 5. remove the owner-generated full-access key so the chip key is the ONLY key.
#    Get it with: near account list-keys agent.OWNER.testnet network-config testnet now
near account delete-keys agent.OWNER.testnet public-keys ed25519:<THE_FULL_ACCESS_KEY> network-config testnet sign-with-keychain send
```
After step 5 the agent account cannot transfer NEAR, add keys or call anything but this contract. It also
cannot recover itself; the owner recovers by redeploying a new agent account and calling `set_agent`.
Keep the per-tx cap below the agent account's gas budget needs: gas is paid from `agent.OWNER.testnet`'s
own balance (top it up with a plain transfer from the owner).

### Smoke calls
```sh
# view state and policy
near contract call-function as-read-only fuse.OWNER.testnet get_state json-args '{}' network-config testnet now
near contract call-function as-read-only fuse.OWNER.testnet get_policy json-args '{}' network-config testnet now

# a payment, signed by the chip through the bridge in normal operation. For a CLI smoke test before the
# chip exists, sign with the agent's key from the keychain (only possible before step 5 removes it):
near contract call-function as-transaction fuse.OWNER.testnet pay \
  json-args '{"receiver":"api.testnet","token":"near","amount":"10000000000000000000000","memo":"smoke"}' \
  prepaid-gas '60 Tgas' attached-deposit '0 NEAR' sign-as agent.OWNER.testnet network-config testnet sign-with-keychain send

# refusal digest for a given hash/code/counter (to cross-check firmware + bridge)
near contract call-function as-read-only fuse.OWNER.testnet compute_refusal_digest \
  json-args '{"tx_hash":"0707070707070707070707070707070707070707070707070707070707070707","code":13,"counter":1}' network-config testnet now
# v2 digest (receiver bound)
near contract call-function as-read-only fuse.OWNER.testnet compute_refusal_digest_v2 \
  json-args '{"tx_hash":"0707070707070707070707070707070707070707070707070707070707070707","code":13,"counter":1,"receiver":"attacker.testnet"}' network-config testnet now

# v2 config (owner): pin the firmware, require a second approver above 0.5 NEAR, share refusals
near contract call-function as-transaction fuse.OWNER.testnet set_allowed_fw json-args '{"allowed_fw":["<fw_sha256 from hello>"]}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as OWNER.testnet network-config testnet sign-with-legacy-keychain send
near contract call-function as-transaction fuse.OWNER.testnet set_approvers json-args '{"approvers":["agent2.OWNER.testnet"]}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as OWNER.testnet network-config testnet sign-with-legacy-keychain send
near contract call-function as-transaction fuse.OWNER.testnet set_quorum_threshold json-args '{"quorum_threshold":"500000000000000000000000"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as OWNER.testnet network-config testnet sign-with-legacy-keychain send
near contract call-function as-transaction fuse.OWNER.testnet set_registry json-args '{"registry":"registry.OWNER.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as OWNER.testnet network-config testnet sign-with-legacy-keychain send
near contract call-function as-read-only fuse.OWNER.testnet get_config json-args '{}' network-config testnet now
near contract call-function as-read-only fuse.OWNER.testnet get_pending json-args '{"from":0,"limit":10}' network-config testnet now
```

## Chain Signatures leg

- Testnet MPC contract: `v1.signer-prod.testnet` (NEAR docs, implementation page; mainnet `v1.signer`).
  Stored in state; change with `set_chain_sig_contract`.
- Call shape verified against `near/mpc` `near-mpc-crypto-types::SignRequestArgs` (2026-11-13):
  `{"path": String, "payload_v2": {"Ecdsa": hex32} | {"Eddsa": hex}, "domain_id": 0|1}`; deposit constant
  `SIGN_DEPOSIT_YOCTONEAR = 1`. The response JSON is stored opaquely in `result_json`; the bridge parses
  `big_r` / `s` / `recovery_id` (ECDSA) or the EdDSA signature from it.
- Follow-up (not done): RLP-decode an EVM `payload` onchain and cross-check `to`/`value` against the
  policy, so the contract does not trust the caller's `chain`/`to`/`value` meta. Today those fields are
  checked against the allowlist as given; the chip performs the same check on its side.

## Notes
- `set_chain_sig_contract`'s first argument is named `account`, not `contract`: the near-sdk ABI macro
  generates an identifier called `contract` and a parameter with that name fails to compile under
  `cargo near build` (which enables `near-sdk/__abi-embed`).
- No `#[payable]` on `pay`: deposits are rejected explicitly, and function-call keys cannot attach them anyway.
- `near-workspaces` sandbox integration tests are a follow-up; unit tests use near-sdk's nearcore-backed mock,
  so `env::ed25519_verify` and `sha256_array` are the real host functions.
