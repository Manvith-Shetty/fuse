# contracts/fuse-registry

Shared refusal evidence for Fuse wallets. A Fuse chip signs a receipt every time it refuses to pay;
a fuse-wallet v2 forwards bound (v2) receipts here, anyone else may report one too. The registry
verifies each receipt against the chip key named in the report, indexes it by the refused receiver
and answers `check(receiver)` with `allow` / `warn` / `block`. The owner curates: manual blocks and
trusted reporters.

Rust, near-sdk 5.30.1. 21 unit tests. Built wasm: `res/fuse_registry.wasm` (see `res/SHA256SUMS`).

## What the registry does and does not trust

- A report is accepted only when `ed25519_verify(receipt_sig, digest, chip_pubkey)` holds, so the
  refusal itself (hash, code, counter and, for v2, the receiver) is the chip's word, not the reporter's.
- Anyone can mint a key and sign "refusals" about anyone. The registry therefore weighs distinct chips
  and trusted reporters, and `block` needs more than one voice (or the owner).
- A v1 receipt (`version: 1`) proves a refusal with that hash/code/counter but not which receiver it
  was about: it is stored `bound: false` and never contributes to a `block`.
- Replay guard: `(chip_pubkey_hex, counter)` is unique, so the same receipt counts once no matter how
  many accounts report it.
- Storage is paid by the registry account (no deposit required: the wallet's fire-and-forget call
  cannot attach one). Keep it funded; at most 4096 reports per receiver.

## Interface

### Anyone
| Method | Args | Effect |
| --- | --- | --- |
| `report` | `chip_pubkey: String (hex\|base58\|"ed25519:..."), receiver: AccountId, tx_hash: String (hex\|base58), code: u8, counter: u32, receipt_sig: String (base64 64 B), version: u8 (1\|2)` | verifies the receipt (`version` 2: `sha256("FUSE_REFUSAL_V2" ‖ tx_hash ‖ code ‖ counter_le ‖ sha256(receiver))`, `version` 1: `sha256("FUSE_REFUSAL_V1" ‖ tx_hash ‖ code ‖ counter_le)`), replay guard, stores `Report {id, reporter, chip_pubkey_hex, receiver, code, tx_hash_hex, counter, bound, version, timestamp_ns}`, emits `report`; returns the id |

### Owner
`report_manual(receiver, reason)` (curated block), `clear_manual(receiver)`, `trust(reporter)`,
`untrust(reporter)` (trusted reporters' reports weigh double).

### Views
| Method | Returns |
| --- | --- |
| `check(receiver)` | `Verdict {verdict, reports, distinct_reporters, distinct_chips, bound_reports, bound_chips, trusted_reports, bound_weight, last_ts, manual, top_codes: [[code, count], ...]}` |
| `get_reports(receiver, from, limit)` | `Vec<Report>` in report order |
| `get_report(id)`, `get_manual(receiver)`, `get_trusted()`, `get_owner()` | |
| `stats()` | `{receivers, reports, reporters, trusted}` |
| `compute_digest_v2(tx_hash, code, counter, receiver)`, `compute_digest_v1(tx_hash, code, counter)` | hex, to check a reporter's encoding |

### Verdict rules
| verdict | when |
| --- | --- |
| `block` | a manual entry exists, **or** `bound_chips >= 2` (two different chips refused this receiver with bound receipts), **or** a trusted reporter reported code 13 `RECEIVER_NOT_ALLOWED`, **or** `bound_weight >= 3` (bound reports, a trusted reporter's counting 2) |
| `warn` | any report |
| `allow` | none |

`distinct_chips` counts all reports; `bound_chips` only bound ones (the block rule uses the latter).

### Events (NEP-297, `EVENT_JSON:` log prefix, `standard: "fuse-registry"`, `version: "1.0.0"`)
`report {id, receiver, reporter, chip_pubkey_hex, code, counter, bound, trusted}`, `manual {receiver, reason|null}`,
`trust {reporter, trusted}`.

## Build and test

```sh
cargo test                                   # 21 unit tests (ed25519-dalek signs, the nearcore host fn verifies)
cargo near build non-reproducible-wasm       # -> target/near/fuse_registry.wasm
```

## Deploy on testnet (near-cli-rs 0.31)

```sh
near account create-account fund-myself registry.OWNER.testnet '2 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as OWNER.testnet network-config testnet sign-with-legacy-keychain send
near contract deploy registry.OWNER.testnet use-file ./res/fuse_registry.wasm \
  with-init-call new json-args '{"owner":"OWNER.testnet"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send
# point the wallet at it (owner)
near contract call-function as-transaction fuse.OWNER.testnet set_registry json-args '{"registry":"registry.OWNER.testnet"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as OWNER.testnet network-config testnet sign-with-legacy-keychain send
# ask about a counterparty
near contract call-function as-read-only registry.OWNER.testnet check json-args '{"receiver":"attacker.testnet"}' network-config testnet now
```
`docs/v2-deploy.md` lists the live testnet deployment.

## Notes
- The wallet reports with 20 Tgas attached; `record_refusal` on the wallet therefore needs about 50 Tgas
  prepaid (the bridge's default of 30 Tgas is too tight once a registry is set).
- `by_receiver` is a `LookupMap<AccountId, Vec<u64>>`: one storage read per `check`, bounded by
  `MAX_REPORTS_PER_RECEIVER`. A `check` over thousands of reports would be slow; per-receiver
  aggregates kept on write are the follow-up.
