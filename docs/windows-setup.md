# Running Fuse from a Windows laptop

The chip keeps its key, policy and firmware in its own flash, so moving the laptop changes nothing on the board or
onchain. What moves: the repo, two secret folders that are not in git, and the tooling.

## 1. Tools (one-time, about 15 minutes)
- **Node 22 LTS** (nodejs.org) and **Git for Windows**.
- **near-cli-rs**: `npm i -g near-cli-rs`. Its legacy keychain lives in `%USERPROFILE%\.near-credentials\`.
- **Claude Code**: install for Windows, open a terminal in the repo folder, run `claude`. `CLAUDE.md` tells it to read
  `FUSE_HANDOFF.md` first; section 12 of that file is the status log and the list of what is still open.
- **PlatformIO** only if you need to reflash: `pip install platformio` (Python 3) or the VS Code extension. The board is
  already flashed; nothing in the demo needs this.
- **Rust + cargo-near** only to rebuild the contract. It is deployed; the demo does not need it.
- **Drivers**: Windows 10/11 recognise the ESP32-S3's native USB port ("USB JTAG/serial debug unit") as a COM port with no
  install. The board's other socket (CP2102) needs Silicon Labs' CP210x driver.

## 2. Secrets to copy by hand (never commit these)
| From (Mac) | To (Windows) |
| --- | --- |
| `~/.near-credentials/testnet/` (the `fuse-hack-2026.testnet*`, `fuse.fuse-hack-2026.testnet*`, `api.fuse-hack-2026.testnet*`, `agent-s3.fuse-hack-2026.testnet*` files and folders) | `%USERPROFILE%\.near-credentials\testnet\` |
| `bridge/.env` | `bridge\.env` in the clone, then edit `SERIAL_PORT` (see below) |

Optional: `bridge/data/sim-chip-state.json` holds the simulator's software key. It is only needed to keep running the
simulator against the dev accounts; the contract now trusts the real chip, so skip it.

## 3. Serial port
Plug the board into the socket marked **USB** (the chip's own port). In Device Manager under *Ports (COM & LPT)* it
appears as `USB JTAG/serial debug unit (COMn)`. Put that in `bridge/.env`:
```
SIMULATE_CHIP=0
SERIAL_PORT=COM5
AGENT_ACCOUNT=agent-s3.fuse-hack-2026.testnet
NEAR_RPC_URL=https://test.rpc.fastnear.com
```
On Windows the bridge uses the `serialport` library (the file-based transport is macOS only). If you use the CP2102
"COM" socket instead, also set `SERIAL_UART_BRIDGE=1` so the bridge releases DTR/RTS and does not hold the board in reset.
That socket also needs the UART firmware build (`pio run -e esp32s3 -t upload`); the flashed build talks on the USB socket.

## 4. Run
```powershell
cd bridge;   npm i; npm run fuse -- hello        # expect mode HARDWARE, board esp32s3, the chip pubkey ed25519:FewvEQ...
npx tsx scripts/chip-smoke.ts                      # decode + sign a real pay tx on the chip, verified locally, nothing broadcast
npm run fuse -- serve                              # bridge API on 127.0.0.1:7777 (keep this terminal open)
cd ..\dashboard; npm i; npm run dev                # http://127.0.0.1:5173
cd ..\agent;     npm i; npx tsx src/index.ts run --inject
cd ..\mcp;       npm i; npm run build; npm run smoke
```
Only one process can hold the serial port: while `serve` runs, pay through it (dashboard, agent, MCP, `POST /pay`),
not with the CLI `pay`.

`attacks/node_modules` is a symlink to `bridge/node_modules` on macOS. On Windows either enable Developer Mode (symlinks
work after `git clone -c core.symlinks=true`) or run `cd attacks && npm i` to install its own copy.

## 5. Known differences
- `firmware/flash-s3.sh` is a bash script for the CP2102 socket's manual bootloader entry. On the USB socket plain
  `pio run -e esp32s3_usb -t upload` works and needs no button.
- Paths in the READMEs use `/`; PowerShell accepts them inside npm scripts.

## 6. Board stops answering after a CLI command (fixed in the bridge)
On the native USB socket the S3 goes silent after the host closes the port right after a reply: the firmware's
`Serial.flush()` waits for a transfer the host never collects, the LED freezes, and no bytes come back until the board
is reset. The bridge now waits 300 ms before closing, and on open it pings the chip and pulses a reset over RTS/DTR
(EN low 150 ms, keys and counter are in flash) if it gets no answer, then waits for `ready`. You will see
`chip silent after open: pulsing reset` once in the `serve` log in that case. If a command still times out, press the
board's **RST** button (not BOOT) and re-run. BOOT is only for approving a payment above the button threshold (amber LED)
or a policy update.

Vite prints `http://localhost:5173/`; use that hostname (it may bind IPv6 only, so `127.0.0.1:5173` can fail).
