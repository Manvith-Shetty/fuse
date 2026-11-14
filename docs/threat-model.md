# Threat model

## Assets
- Funds held by `fuse.<owner>.testnet` (NEAR and one NEP-141 token).
- The chip's ed25519 private key (the agent account's only key).
- The owner's full-access key (in the owner's wallet, never on the laptop or chip).
- The integrity of the policy (chip NVS + contract state).

## Adversaries
1. Prompt-injected or compromised agent process: issues malicious `pay` requests.
2. Compromised bridge/laptop: can forge any bytes sent to the chip, lie in `hint`, replay, reorder, drop.
3. Thief with the chip: has physical access, can plug it into their own laptop.
4. Compromised firmware or chip bug.
5. Network adversary: RPC manipulation, stale block hashes.

## Controls (the three locks)
| Adversary | Protocol key scope | Firmware | Contract |
| --- | --- | --- | --- |
| 1, 2 | can only target one contract, 3 methods, no deposits | parses bytes; allowlists; caps; nonce; button | allowlists; daily cap; pause |
| 3 | cannot transfer NEAR or add keys | caps and button still apply | daily cap; owner removes the key |
| 4 | cannot escape the contract | n/a | daily cap; owner pauses and rotates `set_chip_key` |
| 5 | n/a | nonce monotonic | chain validity window |

## Out of scope / not protected
- Physical extraction of the seed from a dev board without flash encryption (documented production step).
- A malicious owner. The owner is trusted.
- Availability: unplugging the chip stops the agent (by design).
- Correctness of the agent's purchasing decisions within policy.

## Open questions
- Should the chip require the button for policy updates? (v1: yes, button-confirmed over serial)
- Daily cap on chip without a clock: velocity cap since boot on chip, daily cap authoritative onchain.

## v2 additions (docs/v2-spec.md)
| Control | Adversary it addresses | Residual risk |
| --- | --- | --- |
| Owner-signed policy (`policy_set` needs the owner's NEAR key signature + button + increasing seq) | 2, 3: a compromised laptop or a thief cannot loosen the policy even with the button in reach | owner key compromise is out of scope (owner is trusted) |
| fw attestation argument (`fw` in `pay`, contract `allowed_fw`) | 4: a chip running unknown firmware cannot produce signatures the contract accepts | `fw_sha256` is self-reported until Secure Boot is enabled (docs/secure-boot.md) |
| Attested decisions (chip verifies the NEAR AI TEE signature over the model response that proposed the payment) | 2: a compromised bridge cannot invent "the agent decided to pay"; 1 is bounded to what the model actually emitted | the chip checks envelope and response bytes; it does not understand the model's reasoning; TEE trust is NEAR AI Cloud's |
| Receipt v2 binds the refused receiver; shared refusal registry | 1 across many agents: an attacker address that fooled one agent is flagged for every other Fuse user | a registry is advisory; verdict thresholds can be gamed by someone running many chips, hence trusted reporters and bound-receipt weighting |
| Quorum (`quorum_threshold`, `approve_payment` by a second chip) | 3, and a single coerced human: large payments need two devices, two buttons | both approvers coerced; availability cost |
| Bounded serial output | reliability: a host that closes the port mid-reply no longer wedges the chip | none (bug fix) |
| Audit export | accountability: every payment and refusal re-verified from public data | relies on the chain and the chip key the contract stores |

Open questions carried forward: a per-token daily cap in the contract; RLP decoding of EVM payloads in `request_chain_sig`
so the contract cross-checks `to`/`value`; a secure element for the key (docs/hardware.md).
