# Secure Boot v2 and flash encryption on the Fuse ESP32-S3 (production step)

Status: documented procedure, NOT enabled on the hackathon dev board. Both features burn eFuses and are irreversible.
Do this on a board you are willing to dedicate. Read Espressif's current pages first; they are the source of truth:
https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/security/secure-boot-v2.html and
https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/security/flash-encryption.html.

## Why it matters for Fuse
- Today `hello` reports `fw_sha256`, the hash the bootloader stores in the app descriptor. Without Secure Boot a modified
  firmware could report any hash. With Secure Boot v2 only images signed by your RSA-3072 key boot, so the reported hash
  is backed by the boot chain, and the contract's `allowed_fw` list (v2) means something.
- Without flash encryption the chip's seed in NVS can be read with a flash dump. With it, NVS is ciphertext bound to a
  key the CPU never exposes. Combined with Secure Boot, the key cannot be extracted by reflashing a reader firmware.
- A dev board has no tamper detection and exposes the USB-JTAG interface. Production boards disable JTAG via eFuse
  (`DIS_USB_JTAG`, `DIS_PAD_JTAG`) once provisioning is complete.

## Procedure (PlatformIO + esptool/espefuse; ESP32-S3)
1. Generate the signing key once, keep it offline: `espsecure.py generate_signing_key --version 2 --scheme rsa3072 secure_boot_signing_key.pem`.
2. In `firmware/platformio.ini`, for the production env: `board_build.embed_txtfiles` is not needed; enable
   `-DCONFIG_SECURE_BOOT_V2_ENABLED` style options through the Arduino core is not possible, so build the bootloader
   with ESP-IDF menuconfig (`Security features` → `Enable hardware Secure Boot in bootloader`, scheme RSA, and
   `Enable flash encryption on boot`, `Release` mode) or sign out of band:
   `espsecure.py sign_data --version 2 --keyfile secure_boot_signing_key.pem --output firmware-signed.bin firmware.bin`.
3. Burn the Secure Boot digest: `espsecure.py digest_sbv2_public_key --keyfile secure_boot_signing_key.pem --output digest.bin`,
   then `espefuse.py --chip esp32s3 burn_key SECURE_BOOT_DIGEST0 digest.bin SECURE_BOOT_DIGEST0` and
   `espefuse.py --chip esp32s3 burn_efuse SECURE_BOOT_EN`.
4. Flash encryption, release mode: `espefuse.py --chip esp32s3 burn_key BLOCK_KEY0 flash_encryption_key.bin XTS_AES_128_KEY`
   (or let the chip generate it on first boot with Development mode, then move to Release), then
   `espefuse.py --chip esp32s3 burn_efuse SPI_BOOT_CRYPT_CNT 7` and `DIS_DOWNLOAD_MANUAL_ENCRYPT`.
5. Lock down: `espefuse.py burn_efuse DIS_USB_JTAG DIS_PAD_JTAG DIS_DOWNLOAD_ICACHE DIS_DOWNLOAD_DCACHE`.
6. Verify: `espefuse.py summary` shows SECURE_BOOT_EN=1, SPI_BOOT_CRYPT_CNT=7; the board boots the signed image and
   refuses an unsigned one; `hello` still reports `fw_sha256`; `esptool read_flash` returns ciphertext.
7. Register the production `fw_sha256` on the wallet contract: `set_allowed_fw ["<hex>"]` (v2). From then on `pay`
   carries `fw` and the contract rejects any other firmware's signatures.

## Residual risks after this step
Physical fault injection and side channels on the ESP32-S3 are documented research topics; a dedicated secure element
(ATECC608 or similar) holding the ed25519 key would be the next hardware step. Fuse's three-lock design means even a
fully compromised chip is still bounded by the function-call key scope and the contract's caps and pause.
