#!/usr/bin/env bash
# Flash the Fuse firmware onto an ESP32-S3-DevKitC-1 whose CP2102 auto-download circuit does not work
# (7Semi N16R8 and similar clones). Usage: ./flash-s3.sh [/dev/cu.usbserial-XXXX]
# Hold BOOT, tap RST, release BOOT; the ROM then waits in download mode and this script flashes and resets.
set -euo pipefail
PORT="${1:-$(ls /dev/cu.usbserial-* /dev/cu.usbmodem* 2>/dev/null | head -1)}"
[ -n "$PORT" ] || { echo "no serial port found"; exit 1; }
ESPTOOL="$HOME/.platformio/packages/tool-esptool/esptool"
cd "$(dirname "$0")"
echo "port: $PORT"
echo "waiting for the chip in download mode (hold BOOT, tap RST, release BOOT)..."
WAIT="${FUSE_WAIT:-60}"
for i in $(seq 1 "$WAIT"); do
  if "$ESPTOOL" --chip esp32s3 --port "$PORT" --baud 115200 --before no-reset --after no-reset --connect-attempts 1 chip-id >/dev/null 2>&1; then
    echo "chip answered"; break
  fi
  [ "$i" -eq "$WAIT" ] && { echo "chip never entered download mode"; exit 1; }
  sleep 1
done
pio run -e esp32s3_manualboot -t upload --upload-port "$PORT"
echo "flashed. The chip was hard-reset; open the monitor with: pio device monitor -p $PORT -b 115200"
