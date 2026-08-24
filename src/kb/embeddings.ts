/**
 * Embeddings — OpenAI `text-embedding-3-small` (1536 dims, matches the
 * `vector(1536)` column on KbChunk and whatever schema a BYO Postgres
 * backend is told to create).
 *
 * Uses the SAME credential resolution chat/flows already use (resolveEngine)
 * — requires the customer's own OpenAI-type AiEngineConnection__c; there is
 * no shared/server-side fallback key (see engine-resolver.ts). Orgs that
 * only have a Claude/Gemini connection configured get resolveEngine's
 * actionable error ("Add one under AI Engine Setup...") — there is no
 * Claude/Gemini embeddings API, an OpenAI-type connection is required
 * specifically for KB indexing even if it isn't used for chat.
 */
import OpenAI from 'openai';
import { resolveEngine } from '../chat/engine-resolver';
import type { EngineOverride } from '../chat/engine-resolver';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;
const BATCH_SIZE = 96; // OpenAI allows up to 2048 inputs/call; keep batches modest

export async function embedTexts(texts: string[], engineOverride?: EngineOverride | null): Promise<number[][]> {
  if (texts.length === 0) return [];
  const creds = resolveEngine('openai', engineOverride);
  const client = new OpenAI({ apiKey: creds.apiKey });

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await client.embeddings.create({ model: EMBEDDING_MODEL, input: batch });
    out.push(...res.data.map(d => d.embedding));
  }
  return out;
}

export async function embedQuery(query: string, engineOverride?: EngineOverride | null): Promise<number[]> {
  const [vec] = await embedTexts([query], engineOverride);
  return vec;
}

/** Format a pgvector literal — `'[0.1,0.2,...]'::vector`. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
