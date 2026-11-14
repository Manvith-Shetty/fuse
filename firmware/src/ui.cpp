#include "ui.h"
#include <Arduino.h>
namespace fuse {
static Led steady = Led::IDLE;
#ifndef FUSE_BTN_PIN
#define FUSE_BTN_PIN 0
#endif
static void raw(uint8_t r, uint8_t g, uint8_t b) {
#ifdef FUSE_RGB_PIN
  neopixelWrite(FUSE_RGB_PIN, r, g, b);
#elif defined(FUSE_LED_PIN)
  digitalWrite(FUSE_LED_PIN, (r | g | b) ? HIGH : LOW);
#else
  (void)r; (void)g; (void)b;
#endif
}
static void colour(Led s, uint8_t level) {
  switch (s) {
    case Led::OFF: raw(0, 0, 0); break;
    case Led::IDLE: raw(0, level / 6, 0); break;          // dim green breathe
    case Led::SIGNED: raw(0, level, 0); break;            // green
    case Led::REFUSED: raw(level, 0, 0); break;           // red
    case Led::WAITING: raw(level, level / 2, 0); break;   // amber
    case Led::NO_BRIDGE: raw(level / 2, 0, 0); break;     // steady dim red
    case Led::BUSY: raw(0, 0, level); break;              // blue
  }
}
void uiBegin() {
#ifdef FUSE_LED_PIN
  pinMode(FUSE_LED_PIN, OUTPUT);
#endif
  pinMode(FUSE_BTN_PIN, INPUT_PULLUP);
  uiSet(Led::IDLE);
}
void uiSet(Led s) { steady = s; colour(s, 255); }
void uiBlink(Led s, int times) {
  for (int i = 0; i < times; i++) { colour(s, 255); delay(90); raw(0, 0, 0); delay(90); }
  colour(steady, 255);
}
void uiTick(uint32_t now) {
  if (steady == Led::IDLE) { uint8_t lvl = (uint8_t)(128 + 127 * sinf(now / 600.0f)); colour(Led::IDLE, lvl); }
  else if (steady == Led::WAITING) { colour(Led::WAITING, ((now / 250) % 2) ? 255 : 0); }
  else if (steady == Led::NO_BRIDGE) { colour(Led::NO_BRIDGE, 255); }
}
bool uiStateIsNoBridge() { return steady == Led::NO_BRIDGE; }
bool buttonPressed() {
  if (digitalRead(FUSE_BTN_PIN) != LOW) return false;
  delay(30); return digitalRead(FUSE_BTN_PIN) == LOW;
}
bool waitForButton(uint32_t timeoutMs) {
  Led prev = steady; uiSet(Led::WAITING);
  uint32_t start = millis();
  while (digitalRead(FUSE_BTN_PIN) == LOW) { if (millis() - start > 2000) break; delay(5); } // require a fresh press
  bool ok = false;
  while (millis() - start < timeoutMs) { uiTick(millis()); if (buttonPressed()) { ok = true; break; } delay(10); }
  uiSet(prev); return ok;
}
}
