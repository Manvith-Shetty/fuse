// Every fetch in the app goes through here. Dev: Vite proxies /api/bridge -> bridge, /api/agent -> agent service (vite.config.ts).
import type { Attempts, AttemptResult, CheckVerdict, ConfigPatch, ConfigResponse, LogEntry, Onchain, PayRequest, PayResult, PolicyAuth, PolicyMessage, PolicySetResult, SetupInfo, Status } from './types';

export const BRIDGE = '/api/bridge';
export const AGENT = '/api/agent';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) { super(message); this.name = 'ApiError'; }
}
/** True when an endpoint is missing or its service is down (404 from the bridge, or the dev proxy could not reach its target). */
export function isNotAvailable(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 404 || e.status === 500 || e.status === 502 || e.status === 504 || e.status === 0;
  return e instanceof TypeError;
}
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | string | undefined;
    if (typeof b === 'string' && b.trim()) return b.slice(0, 200);
    if (b && typeof b === 'object') return b.error ?? b.message ?? e.message;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(url, { ...init, headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...(init?.headers ?? {}) } });
  } catch (e) { throw new ApiError(0, `network: ${(e as Error).message}`); }
  const text = await r.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!r.ok) throw new ApiError(r.status, `${r.status} ${r.statusText || ''} ${url}`.trim(), body);
  return body as T;
}
const get = <T,>(url: string) => request<T>(url);
const post = <T,>(url: string, body: unknown) => request<T>(url, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  status: () => get<Status>(`${BRIDGE}/status`),
  log: (limit = 100) => get<LogEntry[]>(`${BRIDGE}/log?limit=${limit}`),
  onchain: () => get<Onchain>(`${BRIDGE}/onchain`),
  pay: (body: PayRequest) => post<PayResult>(`${BRIDGE}/pay`, body),
  approve: (id: number | string) => post<PayResult>(`${BRIDGE}/approve`, { id }),
  check: (receiver: string) => get<CheckVerdict>(`${BRIDGE}/check?receiver=${encodeURIComponent(receiver)}`),
  audit: () => get<unknown>(`${BRIDGE}/audit`),
  attempts: (limit = 20) => get<Attempts>(`${AGENT}/attempts?limit=${limit}`),
  attempt: (text: string, task?: string) => post<AttemptResult>(`${AGENT}/attempt`, task ? { text, task } : { text }),
  setupInfo: () => get<SetupInfo>(`${BRIDGE}/setup/info`),
  artifact: async (name: string): Promise<ArrayBuffer> => { const r = await fetch(`${BRIDGE}/artifacts/${encodeURIComponent(name)}`); if (!r.ok) throw new ApiError(r.status, `${r.status} artifact ${name}`); return r.arrayBuffer(); },
  config: () => get<ConfigResponse>(`${BRIDGE}/config`),
  saveConfig: (patch: ConfigPatch) => post<ConfigResponse>(`${BRIDGE}/config`, patch),
  policyMessage: (policy: object, seq?: number) => post<PolicyMessage>(`${BRIDGE}/policy/message`, seq === undefined ? { policy } : { policy, seq }),
  policySet: (policy: object, auth: PolicyAuth) => post<PolicySetResult>(`${BRIDGE}/policy`, { policy, auth }),
  eventsUrl: () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${BRIDGE}/events`,
};
