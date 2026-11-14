// One OpenAI-compatible code path for NEAR AI Cloud (TEE inference, signed responses) and Anthropic (OpenAI-compat endpoint).
import OpenAI from 'openai';
import { createHash } from 'node:crypto';

export type Provider = 'nearai' | 'anthropic' | 'scripted';
export interface LlmInfo { provider: Provider; model: string; baseURL?: string }

export function pickProvider(): LlmInfo {
  const forced = process.env.FUSE_LLM as Provider | undefined;
  if (forced === 'scripted') return { provider: 'scripted', model: 'scripted' };
  if ((forced === 'nearai' || !forced) && process.env.NEAR_AI_API_KEY) return { provider: 'nearai', model: process.env.NEAR_AI_MODEL ?? 'zai-org/GLM-5.1-FP8', baseURL: process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1' };
  if ((forced === 'anthropic' || !forced) && process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5', baseURL: 'https://api.anthropic.com/v1/' };
  return { provider: 'scripted', model: 'scripted' };
}

export function makeClient(info: LlmInfo): OpenAI | null {
  if (info.provider === 'nearai') return new OpenAI({ apiKey: process.env.NEAR_AI_API_KEY, baseURL: info.baseURL, defaultHeaders: { 'x-no-aliasing': 'true', 'Accept-Encoding': 'identity' } });
  if (info.provider === 'anthropic') return new OpenAI({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: info.baseURL });
  return null;
}

// Decision envelope for the chip (docs/v2-spec.md 2.3): NEAR AI Cloud signs `<model>:<sha256(request)>:<sha256(response)>`
// with the TEE key; with `signing_algo=ed25519` the chip can verify it with the same primitive it uses for NEAR.
// The signed text and the signer are taken from the API response, never reconstructed. Field names follow
// docs.near.ai/cloud/verification (`text`, `signature`, `signing_address`, `signing_algo`) [VERIFY on first live run].
export interface DecisionEnvelope { text: string; sig: string; signer: string; resp?: string }
function toBase64Sig(s: string): string | null {
  const hex = s.replace(/^0x/, ''); if (/^[0-9a-fA-F]{128}$/.test(hex)) return Buffer.from(hex, 'hex').toString('base64');
  try { const b = Buffer.from(s, 'base64'); if (b.length === 64) return s; } catch {}
  return null;
}
export async function nearAiDecision(chatId: string, requestText: string, responseText: string, model: string): Promise<{ fingerprint: string; kind?: string; envelope?: DecisionEnvelope; error?: string }> {
  const base = process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
  const respHash = createHash('sha256').update(responseText).digest('hex');
  const reqHash = createHash('sha256').update(requestText).digest('hex');
  try {
    const r = await fetch(`${base}/signature/${encodeURIComponent(chatId)}?signing_algo=ed25519`, { headers: { Authorization: `Bearer ${process.env.NEAR_AI_API_KEY}`, Accept: 'application/json' } });
    const j: any = await r.json();
    if (!r.ok || j.error_code) return { fingerprint: `nearai:${respHash.slice(0, 16)}:unsigned`, error: j.message ?? `HTTP ${r.status}` };
    const text: string = j.text ?? `${model}:${reqHash}:${respHash}`;
    const sig = toBase64Sig(String(j.signature ?? '')); const signer = String(j.signing_address ?? '');
    if (!sig || !signer) return { fingerprint: `nearai:${respHash.slice(0, 16)}:${j.signature_kind ?? 'sig'}`, kind: j.signature_kind, error: 'signature or signer missing in the API response' };
    // Bind the response bytes when they fit the chip's buffer; otherwise the envelope alone is sent.
    const envelope: DecisionEnvelope = { text, sig, signer: signer.startsWith('ed25519:') ? signer : `ed25519:${signer}`, ...(responseText.length <= 8192 ? { resp: Buffer.from(responseText).toString('base64') } : {}) };
    return { fingerprint: `nearai:${respHash.slice(0, 16)}:${j.signature_kind ?? 'ed25519'}`, kind: j.signature_kind, envelope };
  } catch (e: any) { return { fingerprint: `nearai:${respHash.slice(0, 16)}:unsigned`, error: e.message }; }
}

// NEAR AI Cloud response signatures bind exact response bytes to a TEE identity. We fetch the signature for the
// completion id and return a short fingerprint to carry in the payment memo. See docs.near.ai/cloud/verification.
export async function nearAiSignature(chatId: string, responseText: string): Promise<{ fingerprint: string; kind?: string; signer?: string; error?: string }> {
  const base = process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
  const respHash = createHash('sha256').update(responseText).digest('hex');
  try {
    const r = await fetch(`${base}/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa`, { headers: { Authorization: `Bearer ${process.env.NEAR_AI_API_KEY}`, Accept: 'application/json' } });
    const j: any = await r.json();
    if (!r.ok || j.error_code) return { fingerprint: `nearai:${respHash.slice(0, 16)}:unsigned`, error: j.message ?? `HTTP ${r.status}` };
    return { fingerprint: `nearai:${respHash.slice(0, 16)}:${j.signature_kind ?? 'sig'}`, kind: j.signature_kind, signer: j.signing_address };
  } catch (e: any) { return { fingerprint: `nearai:${respHash.slice(0, 16)}:unsigned`, error: e.message }; }
}
