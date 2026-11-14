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
`BUTTON_TIMEOUT`, `REFUSAL_MISMATCH`, `CHAIN_DEST_NOT_ALLOWED`.

Refusal receipt: `ed25519_sign(seed, sha256("FUSE_REFUSAL_V1" || tx_hash(32) || code_byte || counter_u32_le))`.

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
