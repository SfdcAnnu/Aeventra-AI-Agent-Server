/**
 * Default backend — chunks + embeddings live in Archon's own Postgres
 * (KbChunk). Simplest option, no setup required from the customer.
 *
 * `embedding` is an Unsupported("vector(1536)") column in schema.prisma —
 * Prisma Client can't read/write it directly, so every touch of that
 * column goes through raw SQL. Everything else on KbChunk uses the normal
 * Prisma Client API.
 */
import { prisma } from '../../db/client';
import { toVectorLiteral } from '../embeddings';
import type { KbBackend } from './types';

export const archonBackend: KbBackend = {
  usesEmbeddings: true,

  async indexDocument({ orgId, agentApiName, documentId, chunks }) {
    await prisma.kbChunk.deleteMany({ where: { documentId } });
    for (const c of chunks) {
      const row = await prisma.kbChunk.create({
        data: { documentId, orgId, agentApiName, chunkIndex: c.chunkIndex, content: c.content },
      });
      if (c.embedding) {
        await prisma.$executeRawUnsafe(
          `UPDATE "KbChunk" SET embedding = $1::vector WHERE id = $2`,
          toVectorLiteral(c.embedding),
          row.id,
        );
      }
    }
  },

  async deleteDocument({ documentId }) {
    // Also covered by the FK's ON DELETE CASCADE when the KbDocument row
    // itself is removed — explicit here so this backend behaves the same
    // whether or not the caller deletes the parent row.
    await prisma.kbChunk.deleteMany({ where: { documentId } });
  },

  async retrieve({ orgId, agentApiName, queryEmbedding, k }) {
    if (!queryEmbedding) return [];
    const lit = toVectorLiteral(queryEmbedding);
    const rows = await prisma.$queryRawUnsafe<Array<{ content: string; title: string; distance: number }>>(
      `SELECT c.content AS content, d.title AS title, (c.embedding <=> $1::vector) AS distance
       FROM "KbChunk" c
       JOIN "KbDocument" d ON d.id = c."documentId"
       WHERE c."orgId" = $2 AND c."agentApiName" = $3 AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $1::vector ASC
       LIMIT $4`,
      lit,
      orgId,
      agentApiName,
      k,
    );
    return rows.map(r => ({ content: r.content, documentTitle: r.title, score: 1 - r.distance }));
  },
};
