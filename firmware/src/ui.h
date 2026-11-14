#pragma once
#include <stdint.h>
namespace fuse {
// LED + BOOT button. Classic boards: single LED on FUSE_LED_PIN (patterns by blink count).
// S3 boards: onboard WS2812 on FUSE_RGB_PIN (colours). Set exactly one of the two in platformio.ini.
enum class Led { OFF, IDLE, SIGNED, REFUSED, WAITING, NO_BRIDGE, BUSY };
void uiBegin();
void uiSet(Led state);                 // immediate state change (idle/no_bridge/waiting are steady)
void uiBlink(Led state, int times);    // blocking pattern, then returns to the previous steady state
void uiTick(uint32_t nowMs);           // call from loop: breathing / blinking for steady states
bool uiStateIsNoBridge();
bool buttonPressed();                  // debounced, active low
bool waitForButton(uint32_t timeoutMs);// blocks with the WAITING pattern; true if pressed
}
