import { prisma } from '../db/client';
import { embedQuery } from './embeddings';
import { resolveBackend } from './backends';
import type { EngineOverride } from '../chat/engine-resolver';
import type { KbRetrievedChunk } from './backends/types';

const DEFAULT_K = 6;

/** True when this (org, agent) has at least one indexed document ready to search. */
export async function hasReadyKbDocuments(orgId: string, agentApiName: string): Promise<boolean> {
  const count = await prisma.kbDocument.count({
    where: { orgId, agentApiName, status: 'Ready' },
  });
  return count > 0;
}

// THE "HAS ANY KB?" QUESTION WAS ASKED OF POSTGRES ON EVERY TURN.
//
// buildKbBlock caches its result per (org, agent, QUERY) -- and the query
// is the person's message, so every new message missed and re-ran the
// count above. One Postgres round trip costs ~230-470ms from where this
// server runs, and it was the last per-turn read left once the others
// were cached: buildPrompt measured 233ms on a turn where everything else
// read 0, for an agent that has no documents at all.
//
// The answer changes when a document becomes Ready or is removed, both of
// which happen in kb/indexer.ts and invalidate here. The TTL bounds any
// site that was missed. The uncached function above stays for the admin
// route, which should see the truth.
const KB_READY_TTL_MS = 5 * 60_000;
const kbReadyCache = new Map<string, { ready: boolean; at: number }>();

export async function hasReadyKbDocumentsCached(orgId: string, agentApiName: string): Promise<boolean> {
  const key = `${orgId}|${agentApiName}`;
  const hit = kbReadyCache.get(key);
  if (hit && Date.now() - hit.at < KB_READY_TTL_MS) return hit.ready;
  const ready = await hasReadyKbDocuments(orgId, agentApiName);
  kbReadyCache.set(key, { ready, at: Date.now() });
  return ready;
}

/** A document became Ready or went away. Without an agent, the whole org
 *  is forgotten -- deleteDocument knows only the org. */
export function invalidateKbReady(orgId: string, agentApiName?: string): void {
  if (agentApiName) { kbReadyCache.delete(`${orgId}|${agentApiName}`); return; }
  for (const k of kbReadyCache.keys()) if (k.startsWith(`${orgId}|`)) kbReadyCache.delete(k);
}

/** Tests only. */
export function _clearKbReadyCache(): void { kbReadyCache.clear(); }

export async function retrieveKb(args: {
  orgId: string;
  agentApiName: string;
  query: string;
  k?: number;
  engineOverride?: EngineOverride | null;
}): Promise<KbRetrievedChunk[]> {
  const { orgId, agentApiName, query } = args;
  const { backend } = await resolveBackend(orgId);
  const queryEmbedding = backend.usesEmbeddings ? await embedQuery(query, args.engineOverride) : undefined;
  return backend.retrieve({
    orgId,
    agentApiName,
    query,
    queryEmbedding,
    k: args.k ?? DEFAULT_K,
  });
}

/** Formats retrieved chunks into a labeled context block for the system prompt. */
export function formatKbContext(chunks: KbRetrievedChunk[]): string {
  if (chunks.length === 0) return '';
  return chunks
    .map((c, i) => `[${i + 1}] (from "${c.documentTitle}")\n${c.content}`)
    .join('\n\n---\n\n');
}
