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
