// One WebSocket to the bridge (/events) shared by the whole app, seeded from GET /log. Heartbeat comes every second.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { Heartbeat, LogEntry } from '../lib/types';

export type BridgeLink = 'connecting' | 'online' | 'offline';
export interface EventsState {
  log: LogEntry[];
  heartbeat: Heartbeat | null;
  link: BridgeLink;
  /** true: chip responding. false: revoked or bridge gone. null: not known yet. */
  alive: boolean | null;
}
const Ctx = createContext<EventsState>({ log: [], heartbeat: null, link: 'connecting', alive: null });

const keyOf = (e: LogEntry) => `${e.ts}|${e.type}|${String(e.hash ?? '')}|${String(e.counter ?? '')}`;
export function mergeLog(prev: LogEntry[], incoming: LogEntry[], cap = 300): LogEntry[] {
  const seen = new Set(prev.map(keyOf));
  const add = incoming.filter(e => e && typeof e.ts === 'string' && !seen.has(keyOf(e)));
  if (add.length === 0) return prev;
  return [...prev, ...add].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-cap);
}

export function EventsProvider({ children }: { children: ReactNode }) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [heartbeat, setHeartbeat] = useState<Heartbeat | null>(null);
  const [link, setLink] = useState<BridgeLink>('connecting');
  const lastHb = useRef(0);

  useEffect(() => {
    let closed = false; let ws: WebSocket | null = null; let retry: ReturnType<typeof setTimeout> | undefined;
    // A single dropped socket is not a revocation: the bridge counts as offline only after 3 s without a connection.
    let offlineTimer: ReturnType<typeof setTimeout> | undefined;
    const armOffline = () => { if (offlineTimer === undefined) offlineTimer = setTimeout(() => { offlineTimer = undefined; setLink('offline'); }, 3000); };
    api.log(100).then(l => { if (!closed && Array.isArray(l)) setLog(prev => mergeLog(prev, l)); }).catch(() => {});
    const connect = () => {
      ws = new WebSocket(api.eventsUrl());
      ws.onopen = () => { if (offlineTimer !== undefined) { clearTimeout(offlineTimer); offlineTimer = undefined; } setLink('online'); };
      ws.onmessage = (m) => {
        let e: LogEntry & Partial<Heartbeat>;
        try { e = JSON.parse(String(m.data)); } catch { return; }
        if (e.type === 'heartbeat') {
          lastHb.current = Date.now();
          setHeartbeat({ alive: !!e.alive, misses: Number(e.misses ?? 0), lastOk: Number(e.lastOk ?? 0), revokedSince: Number(e.revokedSince ?? 0), mode: e.mode, ts: e.ts });
          return;
        }
        setLog(prev => mergeLog(prev, [e]));
      };
      ws.onclose = () => { if (!closed) { armOffline(); retry = setTimeout(connect, 1200); } };
      ws.onerror = () => ws?.close();
    };
    connect();
    // if the bridge itself disappears, four seconds of heartbeat silence counts as dead
    const guard = setInterval(() => {
      if (lastHb.current && Date.now() - lastHb.current > 4000) setHeartbeat(h => (h && h.alive ? { ...h, alive: false } : h));
    }, 1000);
    return () => { closed = true; clearTimeout(retry); clearTimeout(offlineTimer); clearInterval(guard); ws?.close(); };
  }, []);

  const value = useMemo<EventsState>(() => ({
    log, heartbeat, link,
    alive: heartbeat ? heartbeat.alive : link === 'offline' ? false : null,
  }), [log, heartbeat, link]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useEvents = () => useContext(Ctx);
