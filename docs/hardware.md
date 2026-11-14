# Fuse hardware: today's dev board and the v2 device

## Today (hackathon): 7Semi ESP32-S3-DevKitC-1 N16R8
16 MB flash, 8 MB octal PSRAM, native USB (USB-Serial-JTAG) on the socket marked USB, CP2102 UART on the other socket,
WS2812 RGB LED on GPIO48, BOOT button on GPIO0. The chip talks newline-delimited JSON over USB CDC; no radio is used.
LED language: dim green breathe = idle, green flash = signed, red flash = refused, amber = waiting for the button,
solid dim red = no bridge heartbeat.

## v2 device: a thing a team would put on a desk
Goal: the same firmware, in an enclosure, with a real button, a display that still shows the last decision after the
cable is pulled, and the production security steps enabled (docs/secure-boot.md).

| Part | Choice | Why |
| --- | --- | --- |
| MCU | ESP32-S3-WROOM-1-N16R8 module | same silicon as the dev board: no firmware changes; USB-Serial-JTAG built in |
| Secure element (optional, phase 2) | ATECC608B or SE050 over I2C | ed25519 or P-256 key that never enters MCU RAM; ATECC608B does not do ed25519, so phase 2 means NEAR's secp256k1 key type or a SE050 |
| Button | 12 mm tactile with a cap, debounced in firmware, on GPIO0 | the "human finger in the policy"; must be unmistakable |
| Display | 2.13" e-ink (SSD1680, 250x122) over SPI | shows policy hash, last decision, counter; keeps showing it unpowered, which makes the unplug demo visible |
| Status LED | WS2812 behind a diffuser | same semantics as today |
| USB | USB-C receptacle, data to the S3's native D+/D-, 5.1 kΩ CC pull-downs, ESD protection (USBLC6-2) | works with C-to-C cables, which the dev board's socket did not reliably |
| Power | 3.3 V LDO (ME6211 600 mA), 22 µF bulk | USB powered only; no battery, no radio |
| Tamper | lid switch on a GPIO; firmware zeroises the seed when opened while unpowered-detect is set (phase 2) | cheap and visible |
| Enclosure | 3D-printed, 60 x 40 x 18 mm, window for e-ink, button on top, one USB-C opening | fits a keyring, sits flat |

BOM cost at prototype volume (10 units) is in the USD 25 to 35 range per unit, dominated by the e-ink panel and module.

### Firmware additions for the v2 device (no protocol change)
- `ui.cpp`: e-ink driver (GxEPD2) drawing: top line `FUSE <pubkey short>`, middle `policy <hash> seq <n>`, bottom
  `last: SIGNED 0.6 NEAR -> api...` or `REFUSED #14 RECEIVER_NOT_ALLOWED`, refreshed only on state change (e-ink is slow).
- Button: hardware debounce RC plus the existing 30 s wait; a long press (5 s) while idle shows the full policy on the display.
- Build flag `FUSE_EPD=1` selects the display; without it the firmware behaves exactly like today.

### Quorum: two devices
Payments above the contract's `quorum_threshold` (v2) sit as `pending` until a second Fuse device, enrolled as an
approver account with a function-call key for `approve_payment` only, signs the approval after its own button press.
Two people in two cities each hold one. Nothing moves without both fingers.

### What the dev board cannot do, honestly
No Secure Boot, no flash encryption, JTAG exposed, no tamper detection. The firmware's `fw_sha256` is self-reported.
These are exactly the steps in docs/secure-boot.md; they change eFuses, not code.
