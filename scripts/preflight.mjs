#!/usr/bin/env node
// Is this repository shippable right now? Static facts first (artifact hashes, README links, secrets ignored), then the
// test suites. Prints one line per check and a verdict. `--full` also runs the Rust and firmware suites when the
// toolchains are present; by default only the Node suites and the offline story run (about a minute).
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full');
const results = [];
const check = (name, fn) => { try { const r = fn(); results.push({ name, ok: r !== false, note: typeof r === 'string' ? r : '' }); } catch (e) { results.push({ name, ok: false, note: e.message.split('\n')[0].slice(0, 160) }); } };
const has = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const run = (cmd, cwd) => { const r = spawnSync(cmd, { cwd: path.join(root, cwd), shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } }); if (r.status !== 0) throw new Error(strip(r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ')); return strip(r.stdout + r.stderr); };

// 1. artifacts match their checksums
for (const dir of ['contracts/fuse-wallet/res', 'contracts/fuse-registry/res']) {
  check(`checksums in ${dir}`, () => {
    const lines = fs.readFileSync(path.join(root, dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
    for (const l of lines) { const [sum, name] = l.trim().split(/\s+\*?/); const got = createHash('sha256').update(fs.readFileSync(path.join(root, dir, name))).digest('hex'); if (got !== sum) throw new Error(`${name}: ${got.slice(0, 12)} != ${sum.slice(0, 12)}`); }
    return `${lines.length} file(s)`;
  });
}
// 2. every relative link in the README resolves
check('README relative links', () => {
  const md = fs.readFileSync(path.join(root, 'README.md'), 'utf8'); const bad = [];
  for (const m of md.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) { const t = m[1]; if (/^(https?:|mailto:)/.test(t)) continue; if (!fs.existsSync(path.join(root, t))) bad.push(t); }
  if (bad.length) throw new Error('missing: ' + bad.join(', ')); return 'all resolve';
});
// 3. secrets and runtime data are ignored
check('secrets and data ignored by git', () => {
  const must = ['bridge/.env', 'bridge/.env.sim', 'bridge/data/sim-chip-state.json', 'bridge/data/log.jsonl', 'bridge/data-sim/x', 'agent/data/attempts.jsonl', 'seller/data/used.json', 'frontend/.env', 'frontend/temporary screenshots/x.png', 'firmware/.pio/x'];
  const notIgnored = must.filter(p => spawnSync('git', ['check-ignore', '-q', p], { cwd: root }).status !== 0);
  if (notIgnored.length) throw new Error('not ignored: ' + notIgnored.join(', '));
  const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' }).split('\n');
  const leak = tracked.filter(f => !/\.example$/.test(f) && /(^|\/)\.env(\.|$)|sim-chip-state|\.near-credentials|private_key/i.test(f));
  if (leak.length) throw new Error('tracked: ' + leak.join(', ')); return `${must.length} paths ignored, nothing sensitive tracked`;
});
// 4. the README's own numbers: test counts the suites report
check('bridge tests', () => { const out = run('npx vitest run --reporter=dot 2>&1', 'bridge'); const m = out.match(/Tests\s+(\d+) passed/); if (!m) throw new Error('no pass count'); return `${m[1]} passed`; });
check('frontend typecheck + tests', () => { run('npm run typecheck', 'frontend'); const out = run('npx vitest run --reporter=dot 2>&1', 'frontend'); const m = out.match(/Tests\s+(\d+) passed/); if (!m) throw new Error('no pass count'); return `${m[1]} passed`; });
check('offline story (simulator, no network)', () => { const out = run('npm run story --silent', 'bridge'); if (!/Every verdict matched/.test(out)) throw new Error('story reported failures'); return 'every verdict matched'; });
check('agent, seller and mcp typecheck', () => { run('npx tsc -p tsconfig.json --noEmit', 'agent'); run('npm run typecheck', 'seller'); run('npm run build', 'mcp'); return 'ok'; });
if (full) {
  if (has('cargo')) { check('fuse-wallet cargo test', () => { const o = run('cargo test 2>&1', 'contracts/fuse-wallet'); const m = o.match(/test result: ok\. (\d+) passed/); return m ? `${m[1]} passed` : 'ok'; }); check('fuse-registry cargo test', () => { const o = run('cargo test 2>&1', 'contracts/fuse-registry'); const m = o.match(/test result: ok\. (\d+) passed/); return m ? `${m[1]} passed` : 'ok'; }); }
  else results.push({ name: 'contract tests', ok: true, note: 'skipped: cargo not installed' });
  if (has('pio')) check('firmware native tests', () => { const o = run('pio test -e native 2>&1', 'firmware'); const m = o.match(/(\d+) test cases: (\d+) succeeded/); if (!m || m[1] !== m[2]) throw new Error('native tests failed'); return `${m[2]} passed`; });
  else results.push({ name: 'firmware tests', ok: true, note: 'skipped: platformio not installed' });
}
// 5. report
const w = Math.max(...results.map(r => r.name.length));
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(w)}  ${r.note}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed${full ? '' : ' (add --full for the Rust and firmware suites)'}`);
console.log(failed ? 'not shippable: fix the lines marked FAIL' : 'shippable: the repository is consistent and every suite passed');
process.exit(failed ? 1 : 0);
