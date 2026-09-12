/**
 * Knowledge Base API — sessionAuth, org-scoped.
 *
 * Storage backend is a per-org choice (KbStorageConfig): Archon-hosted
 * (default), the customer's own Postgres, or the customer's own Salesforce
 * org. See kb/backends/ for what each one actually does with the content.
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { prisma } from '../db/client';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { indexDocument, reindexDocument, deleteDocument } from '../kb/indexer';
import { testExternalPostgresConnection, closeExternalClient } from '../kb/backends/external-postgres';
import { extractTextFromUpload } from '../kb/file-extract';
import { hasReadyKbDocuments, retrieveKb, formatKbContext } from '../kb/retriever';

export const kbRouter = Router();

function engineOverrideFromBody(body: unknown): { engineType?: string; apiKey?: string; endpoint?: string; defaultModel?: string; connectionId?: string } | undefined {
  const o = (body as { engineOverride?: unknown })?.engineOverride;
  return o && typeof o === 'object' ? (o as Record<string, string>) : undefined;
}

// ── Storage config ────────────────────────────────────────────────────

/** connectionUrl is never returned in full — only enough to confirm what's configured. */
function maskConnectionUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? u.username + '@' : ''}${u.hostname}${u.pathname}`;
  } catch {
    return '••••••••';
  }
}

kbRouter.get('/api/kb/storage-config', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const cfg = await prisma.kbStorageConfig.findUnique({ where: { orgId } });
  res.json({
    backend: cfg?.backend ?? 'archon',
    connectionUrlMasked: maskConnectionUrl(cfg?.connectionUrl),
    hasConnectionUrl: !!cfg?.connectionUrl,
  });
});

kbRouter.post('/api/kb/storage-config', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const backend = String(req.body?.backend ?? 'archon');
  const connectionUrl = req.body?.connectionUrl ? String(req.body.connectionUrl) : null;

  if (!['archon', 'external_pg', 'salesforce'].includes(backend)) {
    res.status(400).json({ error: 'invalid_backend' });
    return;
  }
  if (backend === 'external_pg') {
    if (!connectionUrl) {
      res.status(400).json({ error: 'missing_connection_url', message: 'A Postgres connection string is required for this backend.' });
      return;
    }
    try {
      await testExternalPostgresConnection(connectionUrl);
    } catch (err) {
      logger.warn({ err, orgId }, 'kb_external_pg_test_failed');
      res.status(400).json({ error: 'connection_failed', message: (err as Error).message });
      return;
    }
  }

  const existing = await prisma.kbStorageConfig.findUnique({ where: { orgId } });
  if (existing?.connectionUrl && existing.connectionUrl !== connectionUrl) {
    await closeExternalClient(existing.connectionUrl);
  }

  const saved = await prisma.kbStorageConfig.upsert({
    where: { orgId },
    create: { orgId, backend, connectionUrl },
    update: { backend, connectionUrl },
  });
  logger.info({ orgId, backend }, 'kb_storage_config_saved');
  res.json({ backend: saved.backend, connectionUrlMasked: maskConnectionUrl(saved.connectionUrl) });
});

kbRouter.post('/api/kb/test-connection', sessionAuth, async (req, res) => {
  const connectionUrl = String(req.body?.connectionUrl ?? '');
  if (!connectionUrl) {
    res.status(400).json({ error: 'missing_connection_url' });
    return;
  }
  try {
    await testExternalPostgresConnection(connectionUrl);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, message: (err as Error).message });
  }
});

// ── Documents ────────────────────────────────────────────────────────

kbRouter.get('/api/kb/documents', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const agentApiName = String(req.query.agentApiName ?? '');
  if (!agentApiName) {
    res.status(400).json({ error: 'missing_agentApiName' });
    return;
  }
  const docs = await prisma.kbDocument.findMany({
    where: { orgId, agentApiName },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, title: true, sourceType: true, status: true,
      chunkCount: true, errorMessage: true, createdAt: true, updatedAt: true,
    },
  });
  res.json({ documents: docs });
});

/**
 * Retrieval test — runs the EXACT path a turn runs, so what comes back is
 * literally what the agent would be handed for that question, not an
 * approximation of it. Same embedding, same backend, same top-k, same
 * formatting (retriever.ts). A KB you cannot query is a KB you cannot
 * trust: this is how you find out that the answer is missing, or that the
 * wrong passage wins, without spending a live turn to discover it.
 */
kbRouter.post('/api/kb/search', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const agentApiName = String(req.body?.agentApiName ?? '');
  const query = String(req.body?.query ?? '').trim();
  if (!agentApiName || !query) {
    res.status(400).json({ error: 'missing_agentApiName_or_query' });
    return;
  }
  const k = Math.min(Math.max(Number(req.body?.k) || 6, 1), 20);

  try {
    const ready = await hasReadyKbDocuments(orgId, agentApiName);
    if (!ready) {
      res.json({ chunks: [], formatted: '', note: 'No indexed documents for this agent yet.' });
      return;
    }
    const chunks = await retrieveKb({
      orgId,
      agentApiName,
      query,
      k,
      engineOverride: req.body?.engineOverride ?? null,
    });
    res.json({ chunks, formatted: formatKbContext(chunks) });
  } catch (err) {
    // Embedding needs the org's own provider key; say so rather than 500.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ orgId, agentApiName, err: message }, 'kb_search_failed');
    res.status(400).json({ error: 'kb_search_failed', message });
  }
});

kbRouter.post('/api/kb/documents', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const agentApiName = String(req.body?.agentApiName ?? '');
  const title = String(req.body?.title ?? '').trim();
  const fileBase64 = req.body?.fileBase64 ? String(req.body.fileBase64) : null;
  const fileName   = req.body?.fileName ? String(req.body.fileName) : null;
  const rawText = req.body?.text ? String(req.body.text) : null;

  if (!agentApiName || !title) {
    res.status(400).json({ error: 'missing_fields', message: 'agentApiName and title are required.' });
    return;
  }

  let text: string;
  if (fileBase64) {
    try {
      text = await extractTextFromUpload(fileBase64, fileName);
    } catch (err) {
      logger.warn({ err, fileName }, 'kb_file_extract_failed');
      res.status(400).json({ error: 'extract_failed', message: err instanceof Error ? err.message : 'Could not read that file.' });
      return;
    }
  } else {
    text = rawText ?? '';
  }
  if (!text.trim()) {
    res.status(400).json({ error: 'empty_document', message: 'No text content found in the upload.' });
    return;
  }

  const doc = await prisma.kbDocument.create({
    data: { id: randomUUID(), orgId, agentApiName, title, sourceType: 'upload', status: 'Indexing' },
  });

  // Synchronous — documents here are "pasted text / a few pages," not bulk
  // corpora, so this comfortably finishes inside one request.
  try {
    await indexDocument({
      orgId, agentApiName, documentId: doc.id, documentTitle: title, text,
      engineOverride: engineOverrideFromBody(req.body),
    });
    const updated = await prisma.kbDocument.findUnique({ where: { id: doc.id } });
    res.json({ document: updated });
  } catch (err) {
    // indexDocument already persisted the Error status — still a 200 so the
    // UI can show the doc row with its error, not a generic failed request.
    const updated = await prisma.kbDocument.findUnique({ where: { id: doc.id } });
    res.json({ document: updated, warning: (err as Error).message });
  }
});

kbRouter.post('/api/kb/documents/:id/reindex', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  try {
    await reindexDocument(orgId, req.params.id, engineOverrideFromBody(req.body));
    const updated = await prisma.kbDocument.findFirst({ where: { id: req.params.id, orgId } });
    res.json({ document: updated });
  } catch (err) {
    res.status(400).json({ error: 'reindex_failed', message: (err as Error).message });
  }
});

kbRouter.delete('/api/kb/documents/:id', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const doc = await prisma.kbDocument.findFirst({ where: { id: req.params.id, orgId } });
  if (!doc) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  try {
    await deleteDocument(orgId, doc.id);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, orgId, documentId: doc.id }, 'kb_delete_failed');
    res.status(502).json({ error: 'delete_failed', message: (err as Error).message });
  }
});
