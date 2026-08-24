import { prisma } from '../db/client';
import { chunkText } from './chunker';
import { embedTexts } from './embeddings';
import { resolveBackend } from './backends';
import { logger } from '../logger';
import type { EngineOverride } from '../chat/engine-resolver';

/**
 * Chunks + (maybe) embeds + writes a document through whatever backend the
 * org has configured, then updates the KbDocument bookkeeping row.
 * Synchronous for MVP — document sizes here are "pasted text / a few
 * pages," not bulk corpora, so this comfortably finishes inside one
 * request instead of needing a queue.
 */
export async function indexDocument(args: {
  orgId: string;
  agentApiName: string;
  documentId: string;
  documentTitle: string;
  text: string;
  engineOverride?: EngineOverride | null;
}): Promise<void> {
  const { orgId, agentApiName, documentId, documentTitle, text } = args;
  try {
    const { backend, config } = await resolveBackend(orgId);
    const isArchon = !config || config.backend === 'archon';
    const rawChunks = chunkText(text);
    if (rawChunks.length === 0) {
      throw new Error('Document has no extractable text.');
    }

    const embeddings = backend.usesEmbeddings ? await embedTexts(rawChunks, args.engineOverride) : [];
    const chunks = rawChunks.map((content, i) => ({
      chunkIndex: i,
      content,
      embedding: embeddings[i],
    }));

    await backend.indexDocument({ orgId, agentApiName, documentId, documentTitle, chunks });

    await prisma.kbDocument.update({
      where: { id: documentId },
      data: {
        status: 'Ready',
        chunkCount: chunks.length,
        errorMessage: null,
        // Only the archon backend gets a cached copy for reindex — see the
        // rawText field comment in schema.prisma for why this is conditional.
        rawText: isArchon ? text : null,
      },
    });
  } catch (err) {
    logger.error({ err, orgId, documentId }, 'kb_index_failed');
    await prisma.kbDocument.update({
      where: { id: documentId },
      data: { status: 'Error', errorMessage: (err as Error).message.slice(0, 2000) },
    }).catch(() => null);
    throw err;
  }
}

export async function reindexDocument(orgId: string, documentId: string, engineOverride?: EngineOverride | null): Promise<void> {
  const doc = await prisma.kbDocument.findFirst({ where: { id: documentId, orgId } });
  if (!doc) throw new Error('Document not found.');
  if (!doc.rawText) {
    throw new Error(
      "This document's original text isn't cached in Archon (its storage backend doesn't retain it here) — re-upload it to reindex.",
    );
  }
  await prisma.kbDocument.update({ where: { id: documentId }, data: { status: 'Indexing' } });
  await indexDocument({
    orgId,
    agentApiName: doc.agentApiName,
    documentId,
    documentTitle: doc.title,
    text: doc.rawText,
    engineOverride,
  });
}

export async function deleteDocument(orgId: string, documentId: string): Promise<void> {
  const { backend } = await resolveBackend(orgId);
  await backend.deleteDocument({ orgId, documentId });
  await prisma.kbDocument.delete({ where: { id: documentId } }).catch(() => null);
}
