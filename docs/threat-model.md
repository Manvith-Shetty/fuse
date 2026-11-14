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
