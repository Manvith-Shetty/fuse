import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export interface LogEntry { ts: string; type: string; mode: 'HARDWARE' | 'SIMULATED' | 'BRIDGE'; [k: string]: unknown }

// Append-only JSONL log + in-memory ring, broadcast to dashboard websockets.
export class Log extends EventEmitter {
  private file: string; private ring: LogEntry[] = [];
  constructor(dataDir: string) { super(); fs.mkdirSync(dataDir, { recursive: true }); this.file = path.join(dataDir, 'log.jsonl'); this.loadTail(); }
  private loadTail() { if (!fs.existsSync(this.file)) return; const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-200); for (const l of lines) { try { this.ring.push(JSON.parse(l)); } catch {} } }
  add(e: Omit<LogEntry, 'ts'>): LogEntry {
    const entry = { ts: new Date().toISOString(), ...e } as LogEntry;
    this.ring.push(entry); if (this.ring.length > 500) this.ring.shift();
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    this.emit('entry', entry); return entry;
  }
  recent(limit = 100) { return this.ring.slice(-limit); }
}
