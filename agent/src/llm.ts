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
