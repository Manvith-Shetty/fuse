import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SerialPort } from 'serialport';
import { Chip, type HelloResult, type SignResult, type DecisionEnvelope, type PolicyAuth, type PolicySetResult } from './chip.js';
import type { Policy } from './policy.js';

// Newline-delimited JSON over a serial device (docs/protocol.md). One outstanding request per id.
//
// Two transports behind one interface:
//  - `fs`: open the device like a file, blocking reads on the libuv threadpool. Used by default on macOS, where the
//    serialport binding's kqueue-based poller never wakes for the ESP32-S3's native USB CDC device (replies only
//    arrived when the port was closed). Baud and raw mode are set with stty; USB CDC ignores the baud anyway.
//  - `serialport`: the usual binding, used elsewhere or with SERIAL_TRANSPORT=serialport.
interface Transport { open(): Promise<void>; write(s: string): void; close(): Promise<void>; resetPulse?(): Promise<void>; onLine: (l: string) => void; onClose: () => void; onError: (m: string) => void; }

class FsTransport implements Transport {
  onLine: (l: string) => void = () => {}; onClose: () => void = () => {}; onError: (m: string) => void = () => {};
  private fd = -1; private acc = ''; private closed = false; private timer: NodeJS.Timeout | null = null;
  constructor(private path: string, private baud: number) {}
  async open() {
    try { execFileSync('stty', ['-f', this.path, 'raw', '-echo', '-echoe', '-echok', 'clocal', String(this.baud)], { stdio: 'ignore' }); } catch { /* some devices reject stty; keep going */ }
    // Non-blocking: a blocking read parked on the libuv threadpool would stop the process from ever exiting.
    this.fd = fs.openSync(this.path, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
    const buf = Buffer.alloc(4096);
    const poll = () => {
      if (this.closed) return;
      let n = 0;
      try { n = fs.readSync(this.fd, buf, 0, buf.length, null); }
      catch (e: any) { if (e.code !== 'EAGAIN') { this.onError(e.message); this.closed = true; this.onClose(); return; } }
      if (n > 0) {
        this.acc += buf.toString('utf8', 0, n);
        let i; while ((i = this.acc.indexOf('\n')) >= 0) { const line = this.acc.slice(0, i).replace(/\r$/, ''); this.acc = this.acc.slice(i + 1); if (line) this.onLine(line); }
      }
      this.timer = setTimeout(poll, n > 0 ? 0 : 8);
    };
    poll();
  }
  write(s: string) {
    // O_NONBLOCK writes return EAGAIN while the USB CDC buffer drains; wait 1 ms and retry (up to ~2 s) rather than drop bytes.
    let off = 0; const b = Buffer.from(s); const deadline = Date.now() + 2000; const sleeper = new Int32Array(new SharedArrayBuffer(4));
    // 64-byte chunks with a short pause: USB CDC hands the chip a full-speed burst and small firmware RX buffers overflow.
    while (off < b.length) {
      try { off += fs.writeSync(this.fd, b, off, Math.min(64, b.length - off)); Atomics.wait(sleeper, 0, 0, 2); }
      catch (e: any) { if (e.code !== 'EAGAIN' || Date.now() > deadline) { this.onError(`write: ${e.message}`); return; } Atomics.wait(sleeper, 0, 0, 1); }
    }
  }
  async close() { if (this.closed) return; this.closed = true; if (this.timer) clearTimeout(this.timer); const fd = this.fd; this.fd = -1; try { fs.closeSync(fd); } catch { /* ignore */ } }
}

class SerialPortTransport implements Transport {
  onLine: (l: string) => void = () => {}; onClose: () => void = () => {}; onError: (m: string) => void = () => {};
  private port: SerialPort; private acc = '';
  constructor(path: string, baudRate: number) {
    this.port = new SerialPort({ path, baudRate, autoOpen: false });
    this.port.on('data', (d: Buffer) => { this.acc += d.toString('utf8'); let i; while ((i = this.acc.indexOf('\n')) >= 0) { const line = this.acc.slice(0, i).replace(/\r$/, ''); this.acc = this.acc.slice(i + 1); if (line) this.onLine(line); } });
    this.port.on('close', () => this.onClose());
    this.port.on('error', (e) => this.onError(e.message));
  }
  async open() {
    await new Promise<void>((res, rej) => this.port.open(e => e ? rej(e) : res()));
    // External UART bridge (CP2102/CH340): DTR/RTS drive IO0/EN, so release both or the board sits in reset.
    // Native USB CDC: the chip only transmits once the host raises DTR, so assert it.
    // Windows names every port COMn, so the kind cannot be read from the path: set SERIAL_UART_BRIDGE=1 for a CP2102/CH340 port.
    const uartBridge = process.env.SERIAL_UART_BRIDGE === '1' || /usbserial|ttyUSB|wchusb/i.test(this.port.path);
    await new Promise<void>((res, rej) => this.port.set({ dtr: !uartBridge, rts: !uartBridge }, e => e ? rej(e) : res()));
  }
  write(s: string) { this.port.write(s); }
  async close() { if (this.port.isOpen) await new Promise<void>(r => this.port.close(() => r())); }
  // Hard reset into the app: RTS drives EN and DTR drives IO0 (native USB-Serial-JTAG and the classic auto-reset circuit alike),
  // so EN low for 150 ms with IO0 high reboots the firmware. Keys, counter and policy live in flash, so nothing is lost.
  async resetPulse() {
    const set = (o: { dtr: boolean; rts: boolean }) => new Promise<void>((res, rej) => this.port.set(o, e => e ? rej(e) : res()));
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const uartBridge = process.env.SERIAL_UART_BRIDGE === '1' || /usbserial|ttyUSB|wchusb/i.test(this.port.path);
    await set({ dtr: false, rts: false }); await sleep(50);
    await set({ dtr: false, rts: true }); await sleep(150);
    await set({ dtr: false, rts: false }); await sleep(100);
    await set({ dtr: !uartBridge, rts: !uartBridge });
  }
}

export class SerialChip extends Chip {
  readonly mode = 'HARDWARE' as const;
  private t!: Transport; private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0; private readyWaiters: Array<() => void> = []; private closing = false; private reconnectTimer: NodeJS.Timeout | null = null;
  constructor(private path: string, private baudRate: number) {
    super();
    this.t = this.makeTransport();
  }
  private makeTransport(): Transport {
    const which = process.env.SERIAL_TRANSPORT ?? (process.platform === 'darwin' ? 'fs' : 'serialport');
    const t = which === 'fs' ? new FsTransport(this.path, this.baudRate) : new SerialPortTransport(this.path, this.baudRate);
    t.onLine = (line) => this.onLine(line);
    t.onClose = () => {
      this.emit('disconnected'); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('serial closed')); } this.pending.clear();
      if (!this.closing) this.scheduleReconnect(); // unplugged: keep trying to reopen so plugging the chip back in restores the heartbeat
    };
    t.onError = (m) => this.emit('raw', `serial error: ${m}`);
    return t;
  }
  private scheduleReconnect() {
    if (this.reconnectTimer || this.closing) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closing) return;
      if (!(await this.deviceExists())) return this.scheduleReconnect();
      try { this.t = this.makeTransport(); await this.t.open(); await this.bringUp(); this.emit('raw', 'serial reconnected'); }
      catch (e: any) { this.emit('raw', `serial reopen failed: ${e.message}`); this.scheduleReconnect(); }
    }, 2000);
  }
  // Windows names ports COMn, which is not a filesystem path: ask the serialport binding whether the device is present.
  private async deviceExists() {
    if (process.platform !== 'win32') return fs.existsSync(this.path);
    try { return (await SerialPort.list()).some(p => p.path.toUpperCase() === this.path.toUpperCase()); } catch { return false; }
  }
  private waitReady(ms: number) { return new Promise<void>(res => { const t = setTimeout(res, ms); this.readyWaiters.push(() => { clearTimeout(t); res(); }); }); }
  // Opening the port may reset the board (UART bridges) and the firmware prints `ready` on boot: wait for it briefly.
  async open() {
    // A missing or busy device at startup is not fatal for `serve`: report it, keep polling, and come up when it appears.
    try { await this.t.open(); } catch (e: any) { this.emit('raw', `serial open failed: ${e.message}; retrying every 2 s`); this.scheduleReconnect(); return; }
    await this.bringUp();
  }
  // Terminate any half line a previous session left in the firmware's buffer, wait briefly for `ready`, then probe with a ping.
  // A silent chip gets a reset pulse: the firmware's `Serial.flush()` after a reply never returns when the previous host closed
  // the port mid-transfer (seen on Windows with the S3's native USB), and only a reset clears it.
  private async bringUp() {
    this.t.write('\n');
    await this.waitReady(1500);
    await new Promise(r => setTimeout(r, 100));
    try { await this.ping(); return; } catch { /* silent: fall through */ }
    if (!this.t.resetPulse) return;
    this.emit('raw', 'chip silent after open: pulsing reset');
    await this.t.resetPulse();
    await this.waitReady(6000);
    await new Promise(r => setTimeout(r, 200));
  }
  private onLine(line: string) {
    this.emit('raw', line);
    let msg: any; try { msg = JSON.parse(line); } catch { return; }
    if (msg.event === 'button_required') { this.emit('button_required', { id: msg.id, summary: msg.summary, timeout_ms: msg.timeout_ms }); return; }
    if (msg.event === 'ready') { const w = this.readyWaiters.splice(0); for (const f of w) f(); return; }
    const p = msg.id ? this.pending.get(msg.id) : undefined; if (!p) return;
    clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg);
  }
  private request<T>(body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`chip timeout on ${body.op}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.t.write(JSON.stringify({ id, ...body }) + '\n');
    });
  }
  hello() { return this.request<HelloResult>({ op: 'hello' }, 3000); }
  ping() { return this.request<{ pong: true; uptime_ms: number }>({ op: 'ping' }, 1500); }
  sign(txBytes: Uint8Array, hint: string, decision?: DecisionEnvelope) { return this.request<SignResult>({ op: 'sign', tx: Buffer.from(txBytes).toString('base64'), hint, ...(decision ? { decision } : {}) }, 45_000); }
  decode(txBytes: Uint8Array) { return this.request<any>({ op: 'decode', tx: Buffer.from(txBytes).toString('base64') }, 3000); }
  policyGet() { return this.request<{ policy: Policy; policy_hash: string }>({ op: 'policy_get' }, 3000); }
  // v2 chips need seq + owner_sig (+ owner_pubkey on the first set); a v1 chip ignores the extra fields.
  policySet(policy: Policy, auth?: PolicyAuth) {
    // Wire names (docs/protocol.md v2): the bridge's `scheme` travels as `owner_sig_scheme`.
    const { scheme, ...rest } = auth ?? ({} as PolicyAuth);
    return this.request<PolicySetResult>({ op: 'policy_set', policy, ...rest, ...(scheme ? { owner_sig_scheme: scheme } : {}) }, 45_000);
  }
  async close() {
    this.closing = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    // Give the firmware time to finish the `Serial.flush()` of its last reply: closing mid-transfer wedges the S3's USB CDC until a reset.
    await new Promise(r => setTimeout(r, 300));
    await this.t.close();
  }
}
