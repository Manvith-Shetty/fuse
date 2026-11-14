# Morning runbook (2026-11-15 IST; submission deadline 2026-11-14 23:59 UTC = 05:29 IST on the 15th)

Everything below was prepared overnight on the Windows laptop with the board unplugged. Nothing has been committed,
pushed, published, posted or submitted. Each step says what to expect; stop at the first mismatch and read the error.

## 0. Before plugging the board in (10 min)
1. Read `FUSE_HANDOFF.md` section 12 (last entry) and `docs/v2-deploy.md` (accounts and tx hashes of the v2 contracts).
2. Check the two background jobs that may still be running or finished overnight:
   - `pio run -e esp32s3_usb` in `firmware/` (toolchain download + compile). It must end with `SUCCESS` and print flash/RAM.
     If it never finished: `cd firmware; pio run -e esp32s3_usb` (resumes the download). Without this build there is no reflash.
   - `pio test -e native` in `firmware/` (needs gcc from scoop). Expect 20 tests passing. The same sources already pass under MSVC.
3. `cd bridge; npm test` → 19 passed. `cd frontend; npm run typecheck; npm test; npm run build` → all green.

## 1. Decide: v1 demo or v2 demo
- **Safe path (v1)**: skip steps 2 and 3. Plug the board in, `cd bridge; npm run fuse -- hello` → `mode HARDWARE`, no `proto`.
  The v2 bridge, frontend, red-team page, seller, audit and MCP all work with the v1 chip and the live v1 contract
  (`fw` is not sent to a v1 chip; receipts stay v1). Record the demo on this path first as the backup.
- **Full path (v2)**: steps 2 then 3, in that order. A v2 chip's receipts do not verify on the v1 contract.

## 2. Migrate the live wallet contract to v2 (owner key `fuse-hack-2026.testnet` is in the legacy keychain)
```powershell
cd contracts\fuse-wallet\res; Get-FileHash fuse_wallet_v2.wasm -Algorithm SHA256     # compare with SHA256SUMS
near contract deploy fuse.fuse-hack-2026.testnet use-file fuse_wallet_v2.wasm with-init-call migrate json-args {} prepaid-gas 100Tgas attached-deposit 0NEAR network-config testnet sign-with-legacy-keychain send
near contract call-function as-read-only fuse.fuse-hack-2026.testnet get_config json-args {} network-config testnet now
#   expect: allowed_fw [], approvers [], quorum_threshold "0", registry null  (v1 behaviour until you set them)
near contract call-function as-transaction fuse.fuse-hack-2026.testnet set_registry json-args '{"registry":"<registry account from docs/v2-deploy.md>"}' prepaid-gas 30Tgas attached-deposit 0NEAR sign-as fuse-hack-2026.testnet network-config testnet sign-with-legacy-keychain send
```
Add `REGISTRY_CONTRACT=<registry account>` to `bridge\.env`. Wallet balance must stay above payments + 2.7 NEAR (storage).

## 3. Reflash the board with firmware v2 (NVS keeps the key, counter and policy)
```powershell
cd firmware; pio run -e esp32s3_usb -t upload          # board on the USB socket, COM5; no button needed on the native port
cd ..\bridge; npm run fuse -- hello                    # expect proto 2, owner_pubkey null, policy_seq 0, receipt_v 2, same pubkey FewvEQ…HoHF
npm run fuse -- policy set ..\firmware\policy.s3.json  # signed by OWNER_ACCOUNT's key; LED amber → press BOOT; expect ok, policy_seq 1, owner_pubkey set
npm run fuse -- hello                                  # policy_hash unchanged (b8cebd9a572382b5) if the file is the same policy
npx tsx scripts\chip-smoke.ts                          # decode + sign on the chip; signature verifies
```
Optional v2 features, each one command: `set_allowed_fw ["<fw_sha256 from hello>"]`, `set_quorum_threshold "2000000000000000000000000"`
plus an approver (second chip or the simulator in a second bridge with `enroll --role approver`), `set_approvers [...]`.

## 4. Bring everything up (one window each)
```powershell
cd bridge;   npm run fuse -- serve
cd agent;    npx tsx src\index.ts serve
cd seller;   $env:WALLET_CONTRACT='fuse.fuse-hack-2026.testnet'; npm start
cd frontend; npm run dev          # http://localhost:3000
```
Checks: Live page heartbeat green, three locks green; `POST /pay` 0.001 NEAR → green LED; red-team page with the poisoned
invoice → red LED, BLOCK stamp, receipt on nearblocks; Counterparty page `attacker.testnet` → block or warn (registry);
`cd agent; $env:SELLER_URL='http://127.0.0.1:7779'; npx tsx src\index.ts run` → PAID then delivery 200; Audit page download.

## 5. Evidence to collect for the claims ledger (screenshots + tx hashes)
Unplug → AGENT REVOKED banner and a 503 (claim 7 becomes REAL). First v2 refusal receipt onchain (claim 15). First signed
policy_set on hardware (claim 14). Red-team attempt logged (claim 20). Seller delivery (claim 21). Sepolia: fund
`0x172F154aBe679a7777200911980eD05136ACc664` from a faucet, then `npm run fuse -- chain-sig pay --to 0x000000000000000000000000000000000000dead --value-wei 1000000000000 --broadcast`.
NEAR AI: claim the free credits at nearbuilders.org/dashboard, put `NEAR_AI_API_KEY` in `bridge\.env`, rerun the agent: the
log should show `decision attested=true`; then add the TEE signer to `decision_signers` in the policy for the strict mode.

## 6. Record (docs/demo-script.md, v2 cut), then publish
1. Repo public with LICENSE (push from the Mac clone or `git init` + push from here, after copying the overnight changes; the
   local `.git` here holds only a staged baseline). Run the GitHub Actions workflow once and link the green run in the README.
2. X post (docs/x-post.md), tags @NEARProtocol #NEARHackathon, video attached. Copy the post URL.
3. Mainnet payout account created in a wallet.
4. Submission payload per docs/event/submission.md: tracks `security`, `agents`, `open`; print, confirm, send once.

## Addendum (04:00 IST): what is already proven, and the exact v2 accounts
- Registry to use: `registry.fuse-v2-sdgt.testnet` (owner `fuse-v2-sdgt.testnet`, key in the legacy keychain). Template v2 wallet: `fuse.fuse-v2-sdgt.testnet`.
- Every v2 flow has run on testnet with the simulator (docs/v2-deploy.md, bottom section), so the morning is only about the real chip.
- Four services from last night are still running against the fresh `fuse-sim-5607` deployment: bridge 7777 (`.env.sim`), agent 7778,
  seller 7779, frontend 3000. Open http://localhost:3000 to see v2 live. Stop them (close the windows or kill node) before `serve`
  on the real board, because the board's bridge also wants port 7777.
- Firmware binary: `firmware/.pio/build/esp32s3_usb/firmware.bin` (built 03:11 IST). `pio run -e esp32s3_usb -t upload` reflashes.
- For the live wallet after migration, set the registry: `set_registry {"registry":"registry.fuse-v2-sdgt.testnet"}`; optionally
  `set_allowed_fw` with the `fw_sha256` the reflashed chip reports, and a quorum threshold below the chip's per-tx cap (1 NEAR) if you
  want the second-chip beat with the simulator as approver (`enroll --role approver` from a second bridge with its own DATA_DIR).
