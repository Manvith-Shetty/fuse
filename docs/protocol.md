# Protocol: bridge <-> chip, and the bytes the chip decodes

Transport: USB CDC serial, 115200, newline-delimited JSON. The chip has no network. The bridge is untrusted.

## Messages
| Request | Response |
| --- | --- |
| `{"op":"hello"}` | `{"pubkey":"ed25519:<base58>","fw":"0.1.0","policy_hash":"<hex>","counter":N}` |
| `{"op":"sign","tx":"<base64 borsh Transaction>","hint":"pay 2 USDC to api.near"}` | `{"ok":true,"sig":"<base64 64B>","hash":"<base58>"}` or `{"ok":false,"code":"<CODE>","detail":"...","receipt":"<base64>"}` |
| `{"op":"policy_get"}` | policy JSON |
| `{"op":"policy_set","policy":{...}}` | ok after button confirmation, else `BUTTON_TIMEOUT` |
| `{"op":"ping"}` | `{"pong":true,"uptime_ms":N}` (bridge pings every 2 s; 3 misses = REVOKED) |

`hint` is display/log only. The chip never uses it for a decision.

## Refusal codes
`BAD_BORSH`, `TRAILING_BYTES`, `MULTI_ACTION`, `NOT_FUNCTION_CALL`, `WRONG_SIGNER`, `WRONG_KEY`,
`WRONG_RECEIVER`, `METHOD_NOT_ALLOWED`, `DEPOSIT_NOT_ZERO`, `GAS_TOO_HIGH`, `NONCE_REPLAY`,
`BAD_ARGS`, `RECEIVER_NOT_ALLOWED`, `TOKEN_NOT_ALLOWED`, `AMOUNT_OVER_CAP`, `VELOCITY_CAP`,
`BUTTON_TIMEOUT`, `REFUSAL_MISMATCH`, `CHAIN_DEST_NOT_ALLOWED`, `CHAIN_VALUE_OVER_CAP`, `BAD_POLICY`, `TX_TOO_LARGE`
(numbers 1..22 in `firmware/lib/fusecore/codes.h`), plus the v2 codes 23..27 below.

Refusal receipt v1: `ed25519_sign(seed, sha256("FUSE_REFUSAL_V1" || tx_hash(32) || code_byte || counter_u32_le))`.
v2 chips issue receipt v2 (below); the contract verifies v1 or v2 by `version`.

## NEAR Transaction Borsh layout [VERIFY with a near-api-js test vector before trusting]
```
signer_id    : String        = u32 LE length + UTF-8
public_key   : u8 key_type (0 = ed25519) + 32 bytes
nonce        : u64 LE
receiver_id  : String
block_hash   : 32 bytes
actions      : u32 LE count + Action*
Action       : u8 tag
   0 CreateAccount
   1 DeployContract { code: Vec<u8> }
   2 FunctionCall   { method_name: String, args: Vec<u8> (u32 LE len + bytes), gas: u64 LE, deposit: u128 LE }
   3 Transfer       { deposit: u128 LE }
   4 Stake  5 AddKey  6 DeleteKey  7 DeleteAccount  8 Delegate   (all refused)
tx_hash   = sha256(Transaction bytes)
signature = ed25519_sign(seed, tx_hash)                      64 bytes
SignedTransaction = Transaction bytes || u8 0 || signature
Broadcast: JSON-RPC `send_tx`, params { signed_tx_base64, wait_until: "EXECUTED_OPTIMISTIC" }
```

## Firmware policy checks (all must pass)
1. Exactly one action, tag 2, no trailing bytes.
2. signer == AGENT_ACCOUNT, public_key == chip key, receiver == WALLET_CONTRACT.
3. method in {pay, record_refusal, request_chain_sig}; deposit == 0; gas <= 100 Tgas.
4. nonce > last_signed_nonce (persisted in NVS).
5. args JSON: `pay` -> receiver/token allowlisted, amount <= per_tx_cap, velocity <= cap;
   `record_refusal` -> matches a receipt this chip issued; `request_chain_sig` -> (chain,to) allowlisted, value <= cap.
6. amount > button_threshold -> amber, wait <= 30 s for BOOT (GPIO0, active low).
7. On refusal: red pattern, no signature, signed receipt.

## Protocol v2 (chips with `"proto": 2` in `hello`; spec in docs/v2-spec.md section 2)
A v1 bridge talking to a v2 chip: `hello`, `ping`, `sign`, `decode`, `policy_get` unchanged; `policy_set` now needs the
owner signature (below). A v2 bridge talking to a v1 chip: the chip ignores the extra fields.

### Messages
| Request | Response |
| --- | --- |
| `{"op":"hello"}` | v1 fields plus `"proto":2,"owner_pubkey":"ed25519:<b58>"` or `null`, `"policy_seq":N,"receipt_v":2,"schemes":["raw","nep413"]`; `fw` is `0.2.0` |
| `{"op":"sign","tx":"<b64>","hint":"..","decision":{"text":"<model>:<req_sha256_hex>:<resp_sha256_hex>","sig":"<b64 64B>","signer":"ed25519:<b58>","resp":"<b64, optional, <= 8 KiB>"}}` | ok: v1 fields plus `"decision":"none"` / `"envelope"` / `"bound"`; refusal: v1 fields plus `"receipt_v":2,"receiver":"<pay.receiver or empty>"` |
| `{"op":"policy_set","policy":{...},"seq":N,"owner_pubkey":"ed25519:<b58>","owner_sig":"<b64 64B>"}` (+ `"owner_sig_scheme":"nep413","nonce":"<b64 32B>","recipient":"..","callback_url":".."` for wallet signatures) | `{"ok":true,"policy_hash":"<16 hex>","policy_sha256":"<64 hex>","policy_seq":N,"owner_pubkey":"ed25519:.."}` after the button; else `OWNER_SIG_INVALID` (no button prompt), `BAD_POLICY`, `BUTTON_TIMEOUT` |
| `{"op":"policy_get"}` | `{"ok":true,"policy":{...},"policy_hash":"<16 hex>","policy_seq":N,"owner_pubkey":..}` |
| `{"op":"ping"}` | unchanged |

Every error reply carries `code` (name) and `code_num`.

### Codes 23..27 (append only; mirrored in `bridge/src/codes.ts`)
| # | Name | When |
| --- | --- | --- |
| 23 | `FW_MISMATCH` | `pay` / `request_chain_sig` args carry `fw` that is not this chip's `fw_sha256` (hex, case-insensitive; a non-string `fw` never matches), or policy `require_fw_arg` is true and `fw` is absent. Checked after the method's allowlist and cap checks, before the verdict. |
| 24 | `DECISION_REQUIRED` | policy `decision_signers` is non-empty, the method is `pay`, and the request has no `decision` object |
| 25 | `DECISION_INVALID` | signer not in `decision_signers`; `sig` not 64 bytes or not valid over `sha256(text)`; `resp` over 8 KiB; `sha256(resp)` != the segment after the last `:` of `text` (text needs >= 3 segments); or `resp` does not contain both the pay `receiver` and `amount` strings |
| 26 | `OWNER_SIG_INVALID` | `policy_set` without `seq`/`owner_sig`; no stored owner and no `owner_pubkey`; `seq <= policy_seq`; or the signature does not verify |
| 27 | `APPROVAL_NOT_ALLOWED` | `approve_payment` args `id` missing, negative, fractional, or not a JSON unsigned integer / decimal string |

### Policy fields (v1 fields unchanged; absent = permissive default)
```
"require_fw_arg": false,        // true: pay / request_chain_sig MUST carry "fw" equal to hello.fw_sha256
"decision_signers": [],         // ed25519 keys, base58 with optional "ed25519:" prefix (the firmware serialiser writes the prefix)
"approve_button": true          // approve_payment needs the button
```
`methods` may include `approve_payment`: args `{"id": N}`, N a JSON unsigned integer or a decimal string; summary
`approve payment #N` (leading zeros stripped); `SIGN_WITH_BUTTON` unless `approve_button` is false. The `fw` rule
applies to `pay` and `request_chain_sig` only. A policy stored by `policy_set` is returned by `policy_get` exactly as
sent; the firmware's own serialiser (default policy) always writes the three v2 fields.

### Owner-signed `policy_set`
```
policy_json = compact JSON of the "policy" value: no whitespace, keys in the order the bridge wrote them
            = JSON.stringify(policy) on the bridge; serializeJson(parsed "policy" object) on the chip
msg         = sha256("FUSE_POLICY_V1" || sha256(policy_json) || seq_u32_le)
owner_sig   = ed25519_sign(owner_seed, msg)
```
That is scheme `"raw"` (default when `owner_sig_scheme` is absent). Browser wallets can only sign NEP-413 messages, so
`policy_set` also accepts `"owner_sig_scheme":"nep413"` with `nonce` (base64, exactly 32 bytes), `recipient` (string) and
optional `callback_url`:
```
message = "FUSE_POLICY_V1:" + lowercase_hex(sha256(policy_json)) + ":" + decimal(seq)      // built by the chip, never read from the request
hash    = sha256(u32_le(2147484061) || borsh_string(message) || nonce[32] || borsh_string(recipient)
                 || (callback_url absent ? 0x00 : 0x01 || borsh_string(callback_url)))      // borsh_string = u32_le(len) || utf8
owner_sig = ed25519_sign(owner_key, hash)                                                   // what wallet.signMessage returns
```
Unknown scheme, nonce not 32 bytes or missing recipient -> `OWNER_SIG_INVALID`, no button prompt. `hello` lists the
accepted schemes as `"schemes":["raw","nep413"]`; the policy_set reply echoes `owner_sig_scheme`. Vector (owner key
`ed25519:G7qZoG55gG8SEHMbtFeKJHN6ZTzUSL8itaWbXWq2f5DG`, the policy whose sha256 is
`4c27cb469ff311d40b7bbeaab6269934a586aeb75034b7c88f5e271e33d3118e`, seq 3, nonce `0102..20`, recipient `fuse`, no
callback): hash `7b9bb2069af44c1881b713ba999c280f4303cb20752eee8bb2a5c522f8b00107`, owner_sig
`ViwqijYJQscNadIHMpJRhqYWCRc1YXztOtdbFs6c/dR6UMClSFvd8VKURT17dHAlo1SbPVrkRt3zCnvWZfVnAw==`.

First `policy_set` on a chip with no owner stored: `owner_pubkey` required, verified, stored with `seq` after the button.
Later sets: `owner_pubkey` ignored, `owner_sig` verified against the stored key, `seq` must exceed the stored
`policy_seq` (0 on a fresh chip). The chip stores `policy_json` byte for byte, so `hello.policy_hash` and
`policy_get.policy_hash` (first 8 bytes of sha256, hex) equal the first 16 hex chars of the reply's `policy_sha256`,
and both equal the bridge's hash of `JSON.stringify(policy)`. The two serialisers agree for everything a policy holds:
key order is preserved, booleans print `true`/`false`, integers below 2^53 print as plain digits, strings escape the
quote, the backslash and the five named control characters identically. They can differ only for floats, integers
>= 2^53 and other control characters (ArduinoJson writes them raw, JSON.stringify as a `\u` escape); a policy never
needs any of these. The bridge compares the returned hash with its own to detect a mismatch.

### Attested decision on `sign` (only when `decision_signers` is non-empty and the method is `pay`)
1. `signer` must parse to a key in `decision_signers`, else `DECISION_INVALID`.
2. `ed25519_verify(sig, sha256(text_bytes), signer)`, else `DECISION_INVALID`.
3. No `resp`: accepted, reply `"decision":"envelope"`. With `resp` (base64, <= 8 KiB): `sha256(resp)` must equal the
   segment after the last `:` of `text` (hex, case-insensitive) and `resp` must contain the pay `receiver` and `amount`
   as substrings, else `DECISION_INVALID`; reply `"decision":"bound"`.
4. Missing `decision` object: `DECISION_REQUIRED`.
The check runs after the policy passed and before the button prompt. Refusals here issue a receipt like any other.

### Refusal receipt v2
```
receiver_hash = sha256(utf8(pay.receiver)) if the decoded tx is `pay` with a string `receiver` in its args, else 32 zero bytes
digest_v2     = sha256("FUSE_REFUSAL_V2" || tx_hash(32) || code(1) || counter_u32_le(4) || receiver_hash(32))
receipt       = ed25519_sign(seed, digest_v2)
```
The reply adds `"receipt_v":2,"receiver":"<same string or empty>"`; the bridge passes both to `record_refusal`. The
chip's own `record_refusal` matching (tx_hash, code, counter) is unchanged. Shared test vector (firmware, bridge and
contract tests): tx_hash = `0102..20` (byte i = i+1), code 13, counter 7, receiver `attacker.testnet` ->
`3091912debd71ecc48be63e3b950242d42d9f9312bf742ab25a0cfb4b972eae3`; same inputs with an empty receiver ->
`0fcda75ba09d9b7c9279548dc9a5b6691a2b311457f98b0534e1e2f0a3e2ef9e`.

### `fw` argument
The bridge adds `"fw":"<hello.fw_sha256>"` to `pay` / `request_chain_sig` args. The chip compares it with its own app
descriptor hash: `FW_MISMATCH` if different, or if absent while `require_fw_arg` is set. The signature covers the args,
so the chain sees which firmware signed.

### Output discipline
A reply is written with one `Serial.write`, then the chip waits for the USB TX buffer to drain for at most 50 ms, and
not at all when no byte has arrived from the host for 5 s (the bridge pings every 2 s). Nothing blocks on a host that
closed the port. Request lines over 20 000 bytes are dropped.
