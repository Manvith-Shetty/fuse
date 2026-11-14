// Thin client for the bridge API. The agent never sees a key; it can only propose.
export class BridgeClient {
  constructor(public baseUrl = process.env.FUSE_BRIDGE_URL ?? 'http://127.0.0.1:7777') {}
  private async req(method: string, path: string, body?: unknown) {
    const r = await fetch(this.baseUrl + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json: any; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    if (!r.ok) return { http: r.status, ...json };
    return json;
  }
  status() { return this.req('GET', '/status'); }
  onchain() { return this.req('GET', '/onchain'); }
  // decision: an attested model decision envelope (protocol v2); the bridge forwards it to the chip.
  pay(p: { receiver: string; token: string; amount: string; memo?: string; decision?: unknown }) { return this.req('POST', '/pay', p); }
  // Shared refusal registry verdict for a receiver: allow / warn / block.
  check(receiver: string) { return this.req('GET', `/check?receiver=${encodeURIComponent(receiver)}`); }
}
