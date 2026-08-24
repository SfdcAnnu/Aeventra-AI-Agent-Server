/**
 * BYO vector store — the customer's OWN Postgres (their own Render/Supabase/
 * RDS/whatever, as long as it can run the `vector` extension). Only their
 * connection string ever touches Archon's database (KbStorageConfig); every
 * document, chunk, and embedding lives entirely in THEIR instance.
 *
 * Archon owns a small fixed table (`archon_kb_chunks`) it creates on first
 * use — the customer doesn't need to pre-provision any schema themselves,
 * just hand us a Postgres connection string with CREATE privileges.
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../../logger';
import { toVectorLiteral } from '../embeddings';
import type { KbBackend } from './types';

const TABLE = 'archon_kb_chunks';

// One pooled client per distinct connection string, reused across calls —
// spinning up a fresh client (and its connection pool) on every chat turn
// would be needlessly slow. Closed only when the org reconfigures storage.
const clientCache = new Map<string, PrismaClient>();

function getClient(connectionUrl: string): PrismaClient {
  let client = clientCache.get(connectionUrl);
  if (!client) {
    client = new PrismaClient({ datasources: { db: { url: connectionUrl } } });
    clientCache.set(connectionUrl, client);
  }
  return client;
}

/** Called when an org saves/changes its external Postgres URL, so a stale pool never lingers. */
export async function closeExternalClient(connectionUrl: string): Promise<void> {
  const client = clientCache.get(connectionUrl);
  if (!client) return;
  clientCache.delete(connectionUrl);
  await client.$disconnect().catch(() => null);
}

async function ensureSchema(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      agent_api_name TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      document_title TEXT NOT NULL,
      embedding vector(1536),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS archon_kb_chunks_org_agent_idx ON ${TABLE}(org_id, agent_api_name)`,
  );
  await client.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS archon_kb_chunks_hnsw_idx ON ${TABLE} USING hnsw (embedding vector_cosine_ops)`,
  );
}

/**
 * Validates a customer-supplied Postgres URL: connects, confirms/creates
 * the vector extension + table. Thrown errors carry the real Postgres
 * message back up (surfaced verbatim to the admin in the UI) — no point
 * masking "extension vector is not available" behind a generic failure.
 */
export async function testExternalPostgresConnection(connectionUrl: string): Promise<void> {
  const client = new PrismaClient({ datasources: { db: { url: connectionUrl } } });
  try {
    await ensureSchema(client);
  } finally {
    await client.$disconnect().catch(() => null);
  }
}

export function externalPostgresBackend(connectionUrl: string): KbBackend {
  return {
    usesEmbeddings: true,

    async indexDocument({ orgId, agentApiName, documentId, documentTitle, chunks }) {
      const client = getClient(connectionUrl);
      await ensureSchema(client);
      await client.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE document_id = $1`, documentId);
      for (const c of chunks) {
        const id = `${documentId}:${c.chunkIndex}`;
        const vec = c.embedding ? toVectorLiteral(c.embedding) : null;
        await client.$executeRawUnsafe(
          `INSERT INTO ${TABLE} (id, document_id, org_id, agent_api_name, chunk_index, content, document_title, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
          id, documentId, orgId, agentApiName, c.chunkIndex, c.content, documentTitle, vec,
        );
      }
    },

    async deleteDocument({ documentId }) {
      const client = getClient(connectionUrl);
      await client.$executeRawUnsafe(`DELETE FROM ${TABLE} WHERE document_id = $1`, documentId).catch(err => {
        // Table may not exist yet if nothing was ever indexed — not an error worth surfacing.
        logger.warn({ err, documentId }, 'external_pg_delete_skipped');
      });
    },

    async retrieve({ orgId, agentApiName, queryEmbedding, k }) {
      if (!queryEmbedding) return [];
      const client = getClient(connectionUrl);
      const lit = toVectorLiteral(queryEmbedding);
      const rows = await client.$queryRawUnsafe<Array<{ content: string; document_title: string; distance: number }>>(
        `SELECT content, document_title, (embedding <=> $1::vector) AS distance
         FROM ${TABLE}
         WHERE org_id = $2 AND agent_api_name = $3 AND embedding IS NOT NULL
         ORDER BY embedding <=> $1::vector ASC
         LIMIT $4`,
        lit, orgId, agentApiName, k,
      );
      return rows.map(r => ({ content: r.content, documentTitle: r.document_title, score: 1 - r.distance }));
    },
  };
}
