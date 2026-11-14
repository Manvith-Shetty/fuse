import { loadConfig, type Config } from './config.js';
import { Near } from './near.js';
import { Log } from './log.js';
import { Fuse } from './fuse.js';
import type { Chip } from './chip.js';
import { SimChip } from './chip-sim.js';
import { SerialChip } from './chip-serial.js';

export async function makeChip(cfg: Config): Promise<Chip> {
  if (cfg.SIMULATE_CHIP === 1 || !cfg.SERIAL_PORT) {
    if (cfg.SIMULATE_CHIP !== 1) console.error('[fuse] SERIAL_PORT not set: using the SIMULATED chip. Set SIMULATE_CHIP=1 to silence this.');
    return new SimChip({ dataDir: cfg.DATA_DIR, agent: cfg.AGENT_ACCOUNT, wallet: cfg.WALLET_CONTRACT, button: cfg.SIM_BUTTON, buttonDelayMs: cfg.SIM_BUTTON_DELAY_MS }).init();
  }
  const chip = new SerialChip(cfg.SERIAL_PORT, cfg.SERIAL_BAUD); await chip.open(); return chip;
}
export async function makeFuse(overrides: Partial<Record<keyof Config, string>> = {}) {
  const cfg = loadConfig(overrides);
  const chip = await makeChip(cfg);
  const log = new Log(cfg.DATA_DIR);
  chip.on('button_required', (i) => log.add({ type: 'button_required', mode: chip.mode, summary: i.summary, timeout_ms: i.timeout_ms }));
  return { cfg, chip, log, fuse: new Fuse(cfg, chip, new Near(cfg.NEAR_RPC_URL), log) };
}
