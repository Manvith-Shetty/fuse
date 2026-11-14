# Fuse attack suite report

Generated 2026-11-13T14:28:49.243Z against NEAR testnet. Chip: `ed25519:8sJtD4jwcbiMCGWKNwpyEPDH43syeqb6Heibvr34GMW5` (mode **SIMULATED**).
Agent account `agent.fuse-hack-2026.testnet` (its only key is the chip's function-call key), wallet contract `fuse.fuse-hack-2026.testnet`, seller `api.fuse-hack-2026.testnet`.

## Summary

**16/16 attacks stopped (11 by the chip, 3 by the NEAR protocol, 2 by the contract), 0/50 legitimate decisions refused, 2/2 legitimate payments executed onchain.**

Honest caveats: this report is self-generated and reproducible (`npm run attacks`). The chip is the software
**simulator** running the same decoder and policy as the firmware; a real Fuse chip cannot be cloned or put into
the "compromised" mode used for scenarios 13-16. The 50 legitimate decisions were signed but not broadcast
(testnet funds, 3 NEAR daily cap); 2 legitimate payments were broadcast. Testnet, not mainnet.

Legitimate payments broadcast: [executed](https://testnet.nearblocks.io/txns/E4jzmBbKT43C4U2i2c2jEVGrzH3ZP6WJTDM3LPmGDCpS), [executed](https://testnet.nearblocks.io/txns/28zV43STQYXKKcy3CNVhodBB2NRE22nJrpG1GotiED71).

## Scenarios

| # | Attack | Signer | Expected lock | Actual | Result | Refusal receipt onchain | Broadcast |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Decoy recipient | enrolled | chip: `RECEIVER_NOT_ALLOWED` | chip: `RECEIVER_NOT_ALLOWED` | STOPPED | [#43](https://testnet.nearblocks.io/txns/ApVC9N2LtCEJXqJkPS8JkUP3odRLZTYy31io4CRhWypV) |  |
| 2 | Amount cancelling (two actions) | enrolled | chip: `MULTI_ACTION` | chip: `MULTI_ACTION` | STOPPED | [#44](https://testnet.nearblocks.io/txns/3ne45f7beWZNe5k2QksUVhiMPHWD3oxY5xuxhXEwUAmK) |  |
| 3 | Threshold splitting (velocity) | scratch | chip: `VELOCITY_CAP` | chip: `VELOCITY_CAP` | STOPPED | #1000001 (not posted) |  |
| 4 | Method substitution (set_policy) | enrolled | chip: `METHOD_NOT_ALLOWED` | chip: `METHOD_NOT_ALLOWED` | STOPPED | [#45](https://testnet.nearblocks.io/txns/13BkmeyJd5T2p3a8dn6hg2yogdbDb8GmQ9BCzd6kWYoY) |  |
| 5 | Receiver substitution (call another contract) | enrolled | chip: `WRONG_RECEIVER` | chip: `WRONG_RECEIVER` | STOPPED | [#46](https://testnet.nearblocks.io/txns/xDx1kkiXiJw1Apqs9f9xjy8WUPwAZdkRFYWif6wuVzR) |  |
| 6 | Deposit smuggling (1 yocto on a function call) | enrolled | chip: `DEPOSIT_NOT_ZERO` | chip: `DEPOSIT_NOT_ZERO` | STOPPED | [#47](https://testnet.nearblocks.io/txns/FE5BDHp2Jaj9Z333VQHdM4LvNr9LA1KmTkGULBK9m9AE) |  |
| 7 | Gas griefing (gas above the chip gas cap) | enrolled | chip: `GAS_TOO_HIGH` | chip: `GAS_TOO_HIGH` | STOPPED | [#48](https://testnet.nearblocks.io/txns/EHLVqFbXJDz4g1KiLynX2GaLGJB76qiZm55e5db9DWip) |  |
| 8 | Replay (re-sign already signed bytes) | scratch | chip: `NONCE_REPLAY` | chip: `NONCE_REPLAY` | STOPPED | #1000001 (not posted) |  |
| 9 | Post-approval argument change | scratch | protocol: `InvalidSignature` | protocol | STOPPED |  | [tx](https://testnet.nearblocks.io/txns/8ojaEbZrYQrwNEbe6bQz9vnqsqRsNK8uX7ZnRuM8fASk) rejected |
| 10 | Appended action | enrolled | chip: `MULTI_ACTION` | chip: `MULTI_ACTION` | STOPPED | [#49](https://testnet.nearblocks.io/txns/83Q5ZY69LVAkm8iWyrRUCP18LiJwr4SyCtQ72LQ1DewG) |  |
| 11 | Unknown action (Transfer instead of FunctionCall) | enrolled | chip: `NOT_FUNCTION_CALL` | chip: `NOT_FUNCTION_CALL` | STOPPED | [#50](https://testnet.nearblocks.io/txns/6xFYhcT3X6T5w3pDEfBk9sQKnHHDxoT2fEUr9uUWEv4c) |  |
| 12 | Trailing bytes | enrolled | chip: `TRAILING_BYTES` | chip: `TRAILING_BYTES` | STOPPED | [#51](https://testnet.nearblocks.io/txns/AjGNd778V2jkoyLzG3NCv5MPNJt4to8R7sMsS7NrgicC) |  |
| 13 | LOCK 1: receiver substitution with a compromised chip | compromised | protocol: `ReceiverMismatch` | protocol | STOPPED |  | [tx](https://testnet.nearblocks.io/txns/DGkNEmQrJSiQSYcEjer7BnTzHDE3uVfUvbgACExGLG6c) rejected |
| 14 | LOCK 1: deposit smuggling with a compromised chip | compromised | protocol: `DepositWithFunctionCall` | protocol | STOPPED |  | [tx](https://testnet.nearblocks.io/txns/CjAkGGL7JVi8hbBaKqS4Z4HxxPkHf8Xu1iacQCU7TYUN) rejected |
| 15 | LOCK 3: receiver not in contract allowlist, compromised chip | compromised | contract: `receiver not in allowlist` | contract | STOPPED |  | [tx](https://testnet.nearblocks.io/txns/7HKQvAEqayrbkGmia7oVvmMEq11KJxGMaHwgqWPr2uCQ) rejected |
| 16 | LOCK 3: over per-tx cap, compromised chip | compromised | contract: `amount over per-tx cap` | contract | STOPPED |  | [tx](https://testnet.nearblocks.io/txns/815tmMeddKhU45vtjHdmU7oaLLqrYDmZjicAY8dupMhe) rejected |

Locks: **chip** = firmware/simulator decodes the bytes and refuses, signing a refusal receipt; **protocol** = NEAR rejects
the signed transaction because the agent account's only key is a function-call key scoped to the wallet contract;
**contract** = the fuse-wallet contract re-checks the policy onchain and panics.

## Details

### 1. Decoy recipient
- Paper/ref: 2610.21063 §4.1 decoy recipient
- Signer: enrolled chip
- Expected: chip `RECEIVER_NOT_ALLOWED`
- Actual: chip `RECEIVER_NOT_ALLOWED` (receiver attacker.testnet)
- Tx hash (of the crafted bytes): `DzU2nZvgJ9DtEGfBcXoB7ese1HDDGLiVHygWubaEp52u`
- Note: The bridge hint names the seller; the bytes name the attacker. The chip only reads the bytes.

### 2. Amount cancelling (two actions)
- Paper/ref: 2610.21063 §4.2 amount cancelling
- Signer: enrolled chip
- Expected: chip `MULTI_ACTION`
- Actual: chip `MULTI_ACTION` (structural)
- Tx hash (of the crafted bytes): `BwK4EMwdrHnfzdbgKQLQ1aC3JSiUbJqcpQxzzcfGaUGD`

### 3. Threshold splitting (velocity)
- Paper/ref: 2610.21063 §4.3 threshold splitting
- Signer: scratch chip
- Expected: chip `VELOCITY_CAP`
- Actual: chip `VELOCITY_CAP` (too many signatures in window)
- Tx hash (of the crafted bytes): `52zkeEcQ339vVQbDR5fRwzM5jRSABdN9o7U91sqEd14G`
- Note: Scratch chip policy velocity_cap=3: the 4th small payment inside the window is refused. The contract daily cap is the second net.

### 4. Method substitution (set_policy)
- Paper/ref: privilege escalation via allowed contract
- Signer: enrolled chip
- Expected: chip `METHOD_NOT_ALLOWED`
- Actual: chip `METHOD_NOT_ALLOWED` (method set_policy)
- Tx hash (of the crafted bytes): `EpTksqWTbc37jpBN4yAtmnGoGDHRVVQr8GJY6akrKAB8`

### 5. Receiver substitution (call another contract)
- Paper/ref: key-scope escape
- Signer: enrolled chip
- Expected: chip `WRONG_RECEIVER`
- Actual: chip `WRONG_RECEIVER` (receiver wrap.testnet)
- Tx hash (of the crafted bytes): `NFxL1LcinoHtEQLoXJCCmqCn8cX5QAy4sW5K9BaFPan`

### 6. Deposit smuggling (1 yocto on a function call)
- Paper/ref: value hidden in attached deposit
- Signer: enrolled chip
- Expected: chip `DEPOSIT_NOT_ZERO`
- Actual: chip `DEPOSIT_NOT_ZERO` (deposit attached)
- Tx hash (of the crafted bytes): `9hkkYW8UkxU4yw5coyNjdYYrk9CaRVE5PSX2JZ874LBP`

### 7. Gas griefing (gas above the chip gas cap)
- Paper/ref: denial-of-wallet, 2609.28585
- Signer: enrolled chip
- Expected: chip `GAS_TOO_HIGH`
- Actual: chip `GAS_TOO_HIGH` (gas over cap)
- Tx hash (of the crafted bytes): `DWsmPLUuL7rD75nhyWyoQyikbsWbK1v7EpeDAsi3VhBr`
- Note: Gas is read from the enrolled chip policy (gas_cap) and exceeded by 1 Tgas, so the scenario tracks policy changes.

### 8. Replay (re-sign already signed bytes)
- Paper/ref: replay
- Signer: scratch chip
- Expected: chip `NONCE_REPLAY`
- Actual: chip `NONCE_REPLAY` (nonce not increasing)
- Tx hash (of the crafted bytes): `8SxaTFzioLtudW2ja5936xmrHe3pyDrZj7iVo1CJDyvx`
- Note: The scratch chip signs once; the identical bytes are presented again.

### 9. Post-approval argument change
- Paper/ref: 2610.21063 §5 args changed after approval (4 of 8 runtimes)
- Signer: scratch chip
- Expected: protocol `InvalidSignature`
- Actual: protocol
  - error: `Invalid transaction signature | {}`
- Tx hash (of the crafted bytes): `8ojaEbZrYQrwNEbe6bQz9vnqsqRsNK8uX7ZnRuM8fASk`
- Note: The chip signs legitimate bytes; the bridge then flips one byte of the args and broadcasts the old signature. The signature binds the bytes, so NEAR rejects it. Stopped by the expected layer but the error text differs from 'InvalidSignature'.

### 10. Appended action
- Paper/ref: hidden second action
- Signer: enrolled chip
- Expected: chip `MULTI_ACTION`
- Actual: chip `MULTI_ACTION` (structural)
- Tx hash (of the crafted bytes): `GDAN2b6npcNdi9Rb6W8Q8T1Q668emHLzjEpV6ZjJJxv3`

### 11. Unknown action (Transfer instead of FunctionCall)
- Paper/ref: action-type confusion
- Signer: enrolled chip
- Expected: chip `NOT_FUNCTION_CALL`
- Actual: chip `NOT_FUNCTION_CALL` (structural)
- Tx hash (of the crafted bytes): `3KnKGQNdEpVUeWoQbm5eJsHETZ3jDL5qdyrXBZhGxPaG`

### 12. Trailing bytes
- Paper/ref: parser differential
- Signer: enrolled chip
- Expected: chip `TRAILING_BYTES`
- Actual: chip `TRAILING_BYTES` (structural)
- Tx hash (of the crafted bytes): `4dW8QChy9vHQtNS8KYt2m9UiZkxi7RqHYPaLvTid7E2v`

### 13. LOCK 1: receiver substitution with a compromised chip
- Paper/ref: function-call key scope
- Signer: compromised chip
- Expected: protocol `ReceiverMismatch`
- Actual: protocol
  - error: `Access key receiver fuse.fuse-hack-2026.testnet does not match transaction receiver wrap.testnet | {}`
- Tx hash (of the crafted bytes): `DGkNEmQrJSiQSYcEjer7BnTzHDE3uVfUvbgACExGLG6c`
- Note:  Stopped by the expected layer but the error text differs from 'ReceiverMismatch'.

### 14. LOCK 1: deposit smuggling with a compromised chip
- Paper/ref: function-call keys cannot attach deposits
- Signer: compromised chip
- Expected: protocol `DepositWithFunctionCall`
- Actual: protocol
  - error: `Deposit is not allowed with function call | {}`
- Tx hash (of the crafted bytes): `CjAkGGL7JVi8hbBaKqS4Z4HxxPkHf8Xu1iacQCU7TYUN`
- Note:  Stopped by the expected layer but the error text differs from 'DepositWithFunctionCall'.

### 15. LOCK 3: receiver not in contract allowlist, compromised chip
- Paper/ref: onchain policy
- Signer: compromised chip
- Expected: contract `receiver not in allowlist`
- Actual: contract
  - error: `{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"WebAssembly trap: An 'unreachable' opcode was executed."}}}}`
- Tx hash (of the crafted bytes): `7HKQvAEqayrbkGmia7oVvmMEq11KJxGMaHwgqWPr2uCQ`
- Note:  Stopped by the expected layer but the error text differs from 'receiver not in allowlist'. The contract panicked but the panic message was lost (wasm trap). Known cause: wasm built with Rust >= 1.87 loses panic strings on the NEAR VM; rebuild the contract with the 1.86 toolchain to get readable messages.

### 16. LOCK 3: over per-tx cap, compromised chip
- Paper/ref: onchain policy
- Signer: compromised chip
- Expected: contract `amount over per-tx cap`
- Actual: contract
  - error: `{"ActionError":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"WebAssembly trap: An 'unreachable' opcode was executed."}}}}`
- Tx hash (of the crafted bytes): `815tmMeddKhU45vtjHdmU7oaLLqrYDmZjicAY8dupMhe`
- Note:  Stopped by the expected layer but the error text differs from 'amount over per-tx cap'. The contract panicked but the panic message was lost (wasm trap). Known cause: wasm built with Rust >= 1.87 loses panic strings on the NEAR VM; rebuild the contract with the 1.86 toolchain to get readable messages.

