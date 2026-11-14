# firmware

The Fuse chip. An ESP32 that holds the agent's only NEAR key, decodes every transaction's raw Borsh bytes itself,
enforces policy, needs a button press above a threshold, and signs over USB serial. **No network.**

Layout:
- `lib/fusecore/` platform-independent core: `borsh.cpp` strict NEAR Transaction decoder, `policy.cpp` rules
  (incl. the v2 `fw` check, `approve_payment`, the attested-decision check, receipt v2 and policy_set digests),
  `util.cpp` base58/base64/decimal compare, `codes.h` refusal codes (mirrored in `bridge/src/codes.ts`),
  `crypto_iface.h` the two primitives the core needs (sha256, ed25519 verify).
- `src/` Arduino shell: `main.cpp` serial protocol v2 + sign path, `keystore.cpp` NVS seed/nonce/counter/policy/owner key,
  `crypto_board.cpp` rweather/Crypto behind `crypto_iface.h`, `ui.cpp` LED patterns + BOOT button.
- `test/test_native/` unit tests that run on the laptop (no board): the near-api-js vector, trailing bytes,
  multi-action, every refusal code, refusal matching, policy JSON round-trip (v1 and v2 fields), encodings, the
  shared receipt-v2 digest vector, fw-argument cases, approve_payment, decision check with a fixed ed25519 vector,
  owner policy_set digest, and a 200,000-case deterministic mutation fuzz of the decoder + policy.
  `crypto_host.cpp` is the host implementation of `crypto_iface.h` (FIPS SHA-2 plus a TweetNaCl-derived ed25519
  verifier, test code only).

## Build and test (no board needed)
```sh
pio test -e native          # 21 tests, ~1 s (needs a host gcc/clang: Xcode CLT on macOS; `scoop install gcc` on Windows)
pio run -e esp32dev         # classic ESP32 (WROOM-32 DevKitC / NodeMCU-32S): LED GPIO2, BOOT GPIO0
pio run -e esp32s3_usb      # ESP32-S3-DevKitC-1, cable in the native "USB" port (what we use)
pio run -e esp32s3          # ESP32-S3-DevKitC-1, cable in the UART/"COM" port (CP2102)
```

## Flash (board needed)

The board used for the demo is a 7Semi ESP32-S3-DevKitC-1 **N16R8** (16 MB flash, 8 MB octal PSRAM). The S3 envs
are configured for it (`qio_opi`, 16 MB partitions). Two USB-C ports:

| Port | Mac sees | env | Notes |
| --- | --- | --- | --- |
| native "USB" (chip's own USB) | Espressif `USB JTAG/serial debug unit`, `/dev/cu.usbmodem*` | `esp32s3_usb` | esptool enters the bootloader itself, no button. **Use this one.** |
| UART/"COM" (CP2102) | `Silicon Labs CP2102`, `/dev/cu.usbserial-*` | `esp32s3` | on this clone the auto-download circuit does not pull BOOT: hold BOOT, tap RST, then `./flash-s3.sh` (uses `esp32s3_manualboot`) |

```sh
pio device list                                             # find the port
pio run -e esp32s3_usb -t upload --upload-port /dev/cu.usbmodem1101
pio device monitor -p /dev/cu.usbmodem1101 -b 115200        # boot prints {"event":"ready","pubkey":"ed25519:..."}
```
Serial quirks the firmware handles: every reply is one `Serial.write` followed by a bounded (<= 50 ms) wait for the USB
TX buffer to drain, skipped when the host has been silent for 5 s (native USB CDC otherwise holds short writes until
the next host write; an unbounded `Serial.flush()` used to wedge the board when the host closed the port). The RX
buffer is 16 KB (a sign request is about 450 bytes, up to ~12 KB with a bound decision, and arrives in USB bursts;
the 256-byte default overflowed).

## Enrol (board needed)
In `bridge/.env`: `SIMULATE_CHIP=0`, `SERIAL_PORT=/dev/cu.usbmodem1101`, `AGENT_ACCOUNT=<fresh agent sub-account>`.
```sh
cd ../bridge
npm run fuse -- hello                             # mode HARDWARE, board esp32s3, the chip's pubkey
npx tsx scripts/chip-smoke.ts                     # decode + sign (or refuse) a real pay tx on the chip, verified locally, nothing broadcast
near contract call-function as-transaction fuse.<owner>.testnet set_chip_key json-args '{"chip_pubkey":"<pubkey from hello>"}' \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <owner>.testnet network-config testnet sign-with-legacy-keychain send
near contract call-function as-transaction fuse.<owner>.testnet set_agent json-args '{"agent":"<agent account>"}' ...   # if the agent account changed
npm run fuse -- enroll                            # agent account: add the chip key, delete the bootstrap key (one tx)
npm run fuse -- policy set ../firmware/policy.s3.json   # owner-signed (protocol v2); LED blinks amber: press BOOT within 30 s
npm run fuse -- pay -r api.<owner>.testnet -t near -a 100000000000000000000000 -m "first hardware payment"
```
Why a fresh agent account: once enrolled, the agent account's only key is the chip's function-call key, which
cannot add or delete keys. Rotating to a new chip therefore means a new agent sub-account (owner creates it with a
bootstrap key, `set_agent` on the contract, enrol) and `set_chip_key` so refusal receipts verify against the new key.
`set_chip_key` resets the contract's refusal counter.

## Firmware attestation
`hello` returns `fw_sha256`: the SHA-256 of the firmware ELF, read from the app descriptor the bootloader keeps next to
the image. Build the firmware yourself, then compare:
```sh
~/.platformio/packages/tool-esptool/esptool --chip esp32s3 image-info .pio/build/esp32s3_usb/firmware.bin | grep SHA256
cd ../bridge && npm run fuse -- hello | grep fw_sha256
```
Builds are not byte-reproducible across machines (paths, timestamps), so the check proves the chip runs the image you
just built and flashed, not that two laptops produce identical bytes.

## LED language
| Pattern | Meaning |
| --- | --- |
| slow green breathe | idle, bridge heartbeat OK |
| 3 fast green | signed |
| 5 fast red | refused (receipt issued) |
| amber blink | waiting for the BOOT button (30 s) |
| solid dim red | no bridge heartbeat for 6 s |
| blue | busy (decoding/signing) |

## Security notes (honest)
- Seed: generated on first boot from the hardware RNG with the bootloader RNG enabled (the radio is off), mixed
  with ADC noise; stored in NVS; there is no serial op that returns it.
- A dev board is not a tamper-proof HSM. Flash encryption and secure boot are the production step and are not
  enabled here (irreversible on a dev board).
- The chip has no clock, so the daily cap is enforced onchain; the chip enforces a velocity cap per window since boot.
