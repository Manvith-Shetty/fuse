# Fuse v2: from "a chip that says no" to the trust root for agent money

Status: specification, 2026-11-14. Implemented in parallel by three streams (firmware, contracts, bridge/agent/dashboard).
Every stream follows this file. Where a stream must deviate, it edits this file first and says so in its report.

Compatibility rule: a v1 chip (today's flashed firmware, receipt v1, no `fw` arg) must keep working against the v2
contract and the v2 bridge. New checks are opt-in through policy fields and owner settings that default to "off".

## 1. Codes (append only; `firmware/lib/fusecore/codes.h`, `bridge/src/codes.ts`, dashboard `CODES`)

| # | Name | Meaning |
| --- | --- | --- |
| 0..22 | unchanged | see docs/protocol.md |
| 23 | `FW_MISMATCH` | `pay`/`request_chain_sig` args carry `fw` that is not this chip's `fw_sha256`, or policy `require_fw_arg` is set and `fw` is absent |
| 24 | `DECISION_REQUIRED` | policy `decision_signers` is non-empty and the `sign` request has no `decision` |
| 25 | `DECISION_INVALID` | the attached decision does not verify (bad signature, unknown signer, response hash mismatch, receiver/amount not in the response) |
| 26 | `OWNER_SIG_INVALID` | `policy_set` without a valid owner signature, or with a non-increasing `seq` |
| 27 | `APPROVAL_NOT_ALLOWED` | `approve_payment` id missing or malformed |

## 2. Serial protocol v2 (`docs/protocol.md` gets this section verbatim)

`hello` adds: `"proto": 2`, `"owner_pubkey": "ed25519:<b58>" | null`, `"policy_seq": N`, `"receipt_v": 2`.

### 2.1 Policy (JSON the chip stores; hash = hex of first 8 bytes of sha256(policy JSON bytes exactly as sent))
Existing fields unchanged. New optional fields, all default to the permissive value:
```
"require_fw_arg": false,            // true: pay/request_chain_sig args MUST carry "fw" equal to this chip's fw_sha256
"decision_signers": [],             // non-empty: pay MUST carry an attested decision signed by one of these ed25519 keys (base58, "ed25519:" prefix optional)
"approve_button": true              // approve_payment always needs the button when true
```
`methods` may now include `approve_payment`.

### 2.2 `policy_set` (owner-signed)
```
{"id":"r1","op":"policy_set","policy":{...},"seq":N,"owner_pubkey":"ed25519:<b58>","owner_sig":"<base64 64B>"}
```
- `owner_sig = ed25519_sign(owner_seed, sha256("FUSE_POLICY_V1" || sha256(policy_json_bytes) || seq_u32_le))`.
  `policy_json_bytes` are the exact bytes of the `policy` value as the chip received them (the bridge sends the
  policy pre-serialised with `JSON.stringify` and the chip re-serialises with ArduinoJson; to avoid mismatch the
  chip hashes `serializeJson(policy)` of what it parsed, and the bridge computes the hash on the string it would get
  from `JSON.stringify(JSON.parse(policyString))` with no spaces). Both sides use compact JSON with no whitespace,
  keys in the order the bridge wrote them. The chip replies with `policy_hash` so the bridge can confirm.
- First `policy_set` on a chip with no owner stored: `owner_pubkey` required, verified against `owner_sig`, then stored
  in NVS with `seq`. Button required (as today).
- Later `policy_set`: `owner_pubkey` ignored; `owner_sig` verified against the stored key; `seq` must be greater than
  the stored one; button required. Failure code `OWNER_SIG_INVALID`, no button prompt.
- Reply: `{"id":..,"ok":true,"policy_hash":"..","policy_sha256":"..","policy_seq":N,"owner_pubkey":".."}`.
  Firmware note (2026-11-14): `policy_hash` keeps the v1 16-hex convention (first 8 bytes of sha256 of the stored
  policy bytes, same value `hello` reports) and `policy_sha256` is the full hash of the bytes that went into `owner_sig`;
  the chip stores the received compact bytes verbatim, so both equal the bridge's own hash of `JSON.stringify(policy)`.
  `policy_get` also returns `policy_seq` and `owner_pubkey`. `seq` must be > the stored `policy_seq` (0 on a fresh chip),
  so the first set needs `seq >= 1`.
- A chip flashed with v1 state (no owner) behaves like "first policy_set".

### 2.3 `sign` with an attested decision
```
{"id":"r2","op":"sign","tx":"<b64>","hint":"...",
 "decision":{"text":"<model>:<req_sha256_hex>:<resp_sha256_hex>","sig":"<base64 64B ed25519>","signer":"ed25519:<b58>","resp":"<base64 response bytes, optional, <= 8 KiB>"}}
```
Chip checks, only when `policy.decision_signers` is non-empty and the method is `pay`:
1. `signer` is in `decision_signers`, else `DECISION_INVALID`.
2. `ed25519_verify(sig, sha256(text_bytes), signer)`, else `DECISION_INVALID`. (NEAR AI Cloud signs the text with
   `signing_algo=ed25519`; the bridge/agent is responsible for fetching `/v1/signature/<chat_id>?signing_algo=ed25519`
   and for the exact text format; the chip only verifies "this text was signed by an allowed TEE key".)
3. If `resp` is present: `sha256(resp) == third segment of text`, and `resp` contains the pay `receiver` string and the
   pay `amount` string as substrings, else `DECISION_INVALID`. If `resp` is absent the chip accepts the envelope alone
   and reports `"decision":"envelope"` in the reply; with `resp` it reports `"decision":"bound"`.
4. Missing `decision` → `DECISION_REQUIRED`.
In SIMULATED mode the bridge's simulator implements the same checks; a `SIM_DECISION_SIGNER` dev key labelled
SIMULATED can sign decisions for tests.

### 2.4 `fw` argument
When the bridge builds `pay` or `request_chain_sig` it adds `"fw": "<fw_sha256 hex from hello>"` to the args. The
chip, on `pay`/`request_chain_sig`: if `fw` is present it must equal its own `fw_sha256` (`FW_MISMATCH`); if
`require_fw_arg` and absent → `FW_MISMATCH`. The signature covers the whole tx, so the chain sees which firmware signed.

### 2.5 `approve_payment`
Args `{"id": N}` (N is a JSON number or decimal string). Allowed when `approve_payment` is in `policy.methods`.
Verdict `SIGN_WITH_BUTTON` when `approve_button` (default true). Summary `approve payment #N`. Bad/missing id → `APPROVAL_NOT_ALLOWED`.

### 2.6 Refusal receipt v2
```
digest_v2 = sha256("FUSE_REFUSAL_V2" || tx_hash(32) || code(1) || counter_u32_le(4) || receiver_hash(32))
receiver_hash = sha256(receiver_account_id_utf8) if the decoded tx was `pay` with a parseable `receiver`, else 32 zero bytes
receipt = ed25519_sign(seed, digest_v2)
```
Refusal reply adds `"receipt_v":2,"receiver":"<account or empty>"`. The bridge passes `receiver` and `version: 2` to
`record_refusal`. The chip's `record_refusal` matching (REFUSAL_MISMATCH check) is unchanged (hash, code, counter).

### 2.7 Output discipline (bug fix)
`send()` must never block forever. Replace `Serial.flush()` with a bounded drain: wait at most 50 ms for the TX
buffer, and skip entirely when the host is away. Root cause: a host that closes the port right after a reply left the
firmware stuck in `flush()` until reset (seen on Windows, 2026-11-14).
Firmware note (2026-11-14): "host away" is detected as "no byte received for 5 s" (the bridge pings every 2 s), not
with `!Serial`: the USB-Serial-JTAG peripheral has no DTR line the sketch can read, and arduino-esp32 3.x's
`HWCDC::operator bool()` probes by writing a NUL byte into the stream, which would corrupt the newline-delimited JSON
the bridge parses. Replies are written with a single `Serial.write` (bounded by the core's per-write TX timeout).

## 3. Contracts

### 3.1 fuse-wallet v2 (same crate, `migrate()` from v1 state)
New state: `allowed_fw: Vec<String>` (hex sha256), `approvers: Vec<AccountId>`, `quorum_threshold: u128` (0 = off),
`pending: IterableMap<u64, PaymentRecord>` (status `pending`; IterableMap rather than LookupMap so `get_pending` can
page without scanning `payments`), `registry: Option<AccountId>`.

Methods (agent):
- `pay(receiver, token, amount, memo, fw: Option<String>) -> PromiseOrValue<bool>`:
  - if `allowed_fw` non-empty: `fw` required and must be in the list (`"pay: firmware not allowed"`).
  - if `quorum_threshold > 0 && amount > quorum_threshold`: record with status `pending`, insert into `pending`,
    count against the daily cap now, emit `pay_pending {id}`, return `Value(false)`. No transfer yet.
  - else as v1.
- `approve_payment(id: u64) -> Promise`: predecessor must be in `approvers`; record must be `pending`; executes the
  transfer with the existing callback; status → `ok`/`failed`; emit `pay_approved {id, by}`.
- `cancel_pending(id)`: owner only; refunds the daily counter; status `cancelled`.
- `record_refusal(tx_hash, code, counter, receipt_sig, receiver: Option<AccountId>, version: Option<u8>)`:
  version 2 (or `receiver` present) verifies `digest_v2`, else `digest_v1`. Stores `receiver` and `version` in
  `RefusalRecord` (new optional fields). If `registry` is set and `receiver` is present (the registry indexes by
  receiver, so unbound refusals have nothing to report), fire-and-forget cross-call
  `registry.report(chip_pubkey_hex, receiver, tx_hash_hex, code, counter, receipt_sig, version)` with 20 Tgas.
  The bridge attaches >= 50 Tgas to `record_refusal` (30 Tgas was the v1 default and is too tight with the report).
  `RefusalRecord` gained two optional fields, so `migrate()` copies v1 records into a new vector (`RefusalsV2` key).
- `request_chain_sig(..., fw: Option<String>)`: same `allowed_fw` rule.

Methods (owner): `set_allowed_fw(Vec<String>)`, `set_approvers(Vec<AccountId>)`, `set_quorum_threshold(U128)`,
`set_registry(Option<AccountId>)`, existing ones unchanged. Arg names: `allowed_fw`, `approvers`, `quorum_threshold`,
`registry`.

Views: `get_pending(from, limit) -> Vec<PaymentRecord>`, `get_config() -> {allowed_fw, approvers, quorum_threshold, registry}`,
`compute_refusal_digest_v2(tx_hash, code, counter, receiver?) -> hex`; `get_counts()` gains `pending`.

Events (`EVENT_JSON`, standard `fuse`, version `2.0.0`): `pay_pending`, `pay_approved`, `pay_cancelled`,
`config_update {field, value}`, `migrate`; existing events keep their names (`refusal` gains `receiver`, `version`).

`migrate()`: `#[private] #[init(ignore_state)]`, reads the v1 struct with the old field set and fills the new fields
with defaults. Unit-tested with a v1 struct serialised in the test.

### 3.2 fuse-registry (new crate `contracts/fuse-registry`)
Shared refusal evidence. Anyone can report; verdicts weigh distinct reporters and chips; the registry owner can
curate.
```
new(owner)
report(chip_pubkey: String, receiver: AccountId, tx_hash: String, code: u8, counter: u32, receipt_sig: String, version: u8)
   -> verifies the receipt (v2 digest requires receiver; v1 accepted but stored as `unbound`), stores
      Report { id, reporter: predecessor, chip_pubkey_hex, receiver, code, tx_hash_hex, counter, bound: bool, version, timestamp_ns }
      indexed by receiver. Replay guard: (chip_pubkey_hex, counter) unique (panics on duplicate). Returns the id.
      Storage is paid by the registry (the wallet's call attaches no deposit); at most 4096 reports per receiver.
report_manual(receiver, reason: String)        owner only; a curated block entry
clear_manual(receiver)                          owner only
trust(reporter: AccountId) / untrust(reporter)  owner only; trusted reporters' reports weigh double
check(receiver) -> Verdict { verdict: "allow" | "warn" | "block", reports, distinct_reporters, distinct_chips, bound_reports, bound_chips, trusted_reports, bound_weight, last_ts, manual: Option<String>, top_codes: Vec<(u8, u32)> }
   block: manual entry present, or bound_chips >= 2 (distinct chips among bound reports), or trusted_reports >= 1 with code RECEIVER_NOT_ALLOWED (13), or bound_weight >= 3
   warn : any report
   allow: none
   "weigh double" = bound_weight counts a trusted reporter's bound report as 2, others as 1 (so one trusted + one
   untrusted bound report from a single chip blocks; raw counts stay in bound_reports/trusted_reports). top_codes is
   the 5 most frequent (code, count), ties by code.
get_reports(receiver, from, limit), get_report(id), get_manual(receiver), get_trusted(), get_owner(),
stats() -> { receivers, reports, reporters, trusted }, compute_digest_v1/v2 helpers.
Events (standard `fuse-registry`, version `1.0.0`): `report`, `manual`, `trust`.
```

## 4. Bridge, agent, dashboard

- `Near.build` adds `fw` to `pay`/`request_chain_sig` args when the chip's `hello` has `fw_sha256` and the policy or
  env `FUSE_FW_ARG=1` asks for it (default on for HARDWARE, off for SIMULATED unless the sim reports a fw hash).
- `fuse policy set <file> [--seq N]` signs with the owner key from the legacy keychain (`OWNER_ACCOUNT`) and sends
  `owner_pubkey`, `owner_sig`, `seq` (default: chip `policy_seq + 1`).
- `fuse check <receiver>` queries the registry (`REGISTRY_CONTRACT` env). `POST /pay` runs the check first and
  returns it in the response (`counterparty: {verdict,...}`); it does not block (the chip decides) but the dashboard
  shows the verdict, and the agent's `pay` tool shows it to the model.
- `fuse approve <id>` and `POST /approve {id}` build `approve_payment` through the chip (for the approver chip's bridge).
- `fuse audit [--since ISO] [--out dir]` writes `audit.json` and `audit.md`: payments, refusals (with receipt
  verification result), chain sigs, pending, config, policy hashes seen in the local log, firmware hashes seen in
  `hello`. `GET /audit` returns the JSON; the dashboard has a download button.
- Agent: `agent serve --port 7778` exposes `POST /attempt {text, task?}` → runs the agent with `text` as the untrusted
  document, returns `{events:[...], decision, provider}`; one attempt at a time, 20 s cooldown, text ≤ 4 KiB, appends
  to `agent/data/attempts.jsonl`; `GET /attempts?limit=` returns the leaderboard data (counts by code, recent attempts
  with tx links). Uses NEAR AI when `NEAR_AI_API_KEY` is set, else SCRIPTED (labelled).
- Agent, NEAR AI: after each completion fetch the ed25519 signature and pass `decision` to `POST /pay` →
  bridge forwards it in `sign`. Memo keeps the fingerprint.
- Dashboard: tabs `Live` (today's view), `Red team` (attempt box, transcript, leaderboard, chip LED state), `Audit`
  (download), `Counterparty` (check box). `vite.config.ts` proxies `/attempt`, `/attempts` to 7778.
- Seller: `seller/` tiny HTTP service: `GET /weather?city=&payment_id=` verifies `get_payments` onchain (receiver = seller,
  status ok, memo contains the order id) before answering. The agent calls it after paying. Pay-per-call end to end.
- Tools: `agent/src/tools/langchain.ts` and `agent/src/tools/openai-schema.json` export the `pay` tool for other agent
  frameworks; `docs/agent-market.md` holds the listing manifest text.
- Chain sig: `fuse chain-sig address --chain btc-testnet4` derives the Bitcoin address (chainsig.js); Sepolia broadcast
  when funded. `fuse intents quote` runs a 1Click `dry: true` quote on mainnet (no funds move; Q-007).

## 5. Reproducibility and docs
- `contracts/fuse-wallet/res/fuse_wallet.wasm` + `SHA256SUMS` committed; `bootstrap.ts` falls back to it.
- `.devcontainer/devcontainer.json` + `Dockerfile` (Node 22, near-cli-rs) for the simulator path.
- `.github/workflows/ci.yml`: bridge tests, contract tests (both crates), firmware native tests, dashboard typecheck.
- `docs/secure-boot.md`: exact espefuse/esptool procedure for Secure Boot v2 + flash encryption on the S3, with the
  irreversibility warnings. `docs/hardware.md`: v2 board (USB-C, big button, e-ink strip), BOM, enclosure.
- `docs/threat-model.md` gains the residual risks table for v2. `docs/claims-ledger.md` gains rows for every new claim,
  SIMULATED/UNVERIFIED until the chip is back.
- README: allow / warn / block table in the organisers' words, the screener path, the red-team page, the registry.
