# Taking Fuse to mainnet

Nothing here runs by itself: every mainnet action is signed by the owner in their own wallet, from the setup UI or the
CLI, after they decide to. The hackathon demo stays on testnet.

## What changes between testnet and mainnet
| Piece | Testnet (today) | Mainnet |
| --- | --- | --- |
| Network and RPC | `testnet`, `https://test.rpc.fastnear.com` | `mainnet`, `https://free.rpc.fastnear.com` (or a paid RPC); set from the UI (`POST /config`) |
| Accounts | `fuse.<owner>.testnet`, `agent.<owner>.testnet` | `fuse.<owner>.near`, `agent.<owner>.near`, created by the owner's wallet in the setup wizard |
| Wallet contract | `fuse_wallet_v2.wasm` (sha256 in `contracts/fuse-wallet/res/SHA256SUMS`) | same bytes; build it reproducibly (`cargo near build reproducible-wasm`, Docker) before trusting it with real funds |
| Chain Signatures | `v1.signer-prod.testnet` (contract default) | owner calls `set_chain_sig_contract {"account":"v1.signer","deposit":"1"}`; derived addresses change (different root key) |
| Refusal registry | `registry.fuse-v2-sdgt.testnet` | deploy `fuse_registry.wasm` once (e.g. `registry.fuse.near`), owner sets `set_registry`; trust reputable reporters with `trust` |
| NEAR Intents | dry quotes only | real quotes and swaps through 1Click with a partner key; the chip approves the deposit `pay` like any other payment |
| Chip | dev board, self-reported `fw_sha256` | Secure Boot v2 + flash encryption (`docs/secure-boot.md`), then `set_allowed_fw` with the production hash |
| Owner key | near-cli-rs legacy keychain | the owner's browser or hardware wallet; the chip policy is signed with NEP-413 `signMessage` (scheme `nep413`) |

## Costs (approximate, mainnet, 2026-11)
- Wallet contract storage: ~2.8 NEAR locked for the 278 KB wasm plus records (1e19 yocto per byte). Keep the balance above
  spending plus the lock or `pay` fails with `LackBalanceForState`.
- Agent account: 0.1 NEAR is plenty; it only pays gas for `pay` / `record_refusal` (about 0.001 NEAR per call with a registry report).
- Registry: ~2 NEAR storage for the contract plus ~0.01 NEAR per stored report (paid by the registry account).

## Setup from the UI (what the wizard does, step by step)
1. Connect the owner's wallet (NEAR Wallet Selector: MyNearWallet, Meteor, HOT, Nightly). The network comes from the wallet.
2. Plug the chip in; the bridge reports its public key and firmware hash (`GET /setup/info`).
3. Create the wallet contract: one transaction signed by the owner on `fuse.<owner>`: CreateAccount, Transfer (storage + budget),
   DeployContract (bytes from `GET /artifacts/fuse_wallet_v2.wasm`, hash checked against `/artifacts`), FunctionCall `new`
   with `{owner, agent, chip_pubkey, policy}`.
4. Create the agent account: one transaction on `agent.<owner>`: CreateAccount, Transfer (0.1 NEAR), AddKey (FunctionCall
   permission, receiver `fuse.<owner>`, methods `pay, record_refusal, request_chain_sig`, public key = the chip's). The chip is the
   only key from birth; there is no bootstrap key to delete.
5. Optional owner calls: `set_registry`, `set_allowed_fw`, `set_quorum_threshold`, `set_approvers`, `set_chain_sig_contract`.
6. `POST /config` with network, RPC, owner, wallet, agent, registry: the bridge persists `data/config.json` and switches at once.
7. Chip policy: the UI asks `POST /policy/message` for the exact message, the wallet signs it (NEP-413, recipient `fuse`),
   the UI sends `POST /policy {policy, auth: {scheme: "nep413", seq, nonce, recipient, owner_pubkey, owner_sig}}`, the human
   presses BOOT, the chip binds the owner key. Later changes need the same wallet and a higher seq.

## Operating
- Rotate the chip: owner `set_chip_key` on the wallet, AddKey/DeleteKey on the agent account from the wallet, reflash or
  replace the device, `policy set` with the next seq.
- Pause: owner `pause`; unplug for an immediate stop.
- Audit: `fuse audit` or `GET /audit?format=md`; every receipt re-verifies against the chip key the contract stores.
- Upgrade the contract: `deploy` with `migrate` (v1 to v2 is proven); v2 to v2 code changes deploy without init.

## Not yet done for mainnet
Reproducible wasm build and ABI; per-token daily caps; RLP decoding of EVM payloads in `request_chain_sig`; the TEE decision
path against NEAR AI Cloud; a secure element for the key (docs/hardware.md).
