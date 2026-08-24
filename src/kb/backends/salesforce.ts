/**
 * Salesforce-native backend — chunk TEXT is written as records into the
 * customer's OWN org (AgentKbChunk__c custom object). Archon never
 * persists a byte of their document content; nothing but the tiny
 * bookkeeping row (KbDocument: title/status/chunk count) lives outside
 * their org.
 *
 * Retrieval is SOSL keyword search, not true vector similarity — there is
 * no embeddings-based search available without a Data Cloud vector index,
 * which not every org has. That's the honest tradeoff for "my data never
 * leaves my org": weaker ranking, zero data egress. `usesEmbeddings` is
 * false so the indexer/retriever skip the (pointless, costly) embedding
 * step entirely for this backend.
 */
import { getOrgConnection } from '../../salesforce/per-org-connection';
import { logger } from '../../logger';
import type { KbBackend } from './types';

const OBJECT = 'AgentKbChunk__c';

/** Escapes SOSL reserved characters per the FIND clause spec. */
function escapeSosl(text: string): string {
  return text.replace(/([\\?&|!{}[\]()^~*:"'+-])/g, '\\$1').slice(0, 200);
}

export const salesforceBackend: KbBackend = {
  usesEmbeddings: false,

  async indexDocument({ orgId, agentApiName, documentId, documentTitle, chunks }) {
    const conn = await getOrgConnection(orgId);
    const existing = await conn.query<{ Id: string }>(
      `SELECT Id FROM ${OBJECT} WHERE DocumentExternalId__c = '${documentId.replace(/'/g, "\\'")}'`,
    );
    if (existing.records.length > 0) {
      await conn.sobject(OBJECT).destroy(existing.records.map(r => r.Id));
    }
    if (chunks.length === 0) return;
    const rows = chunks.map(c => ({
      DocumentExternalId__c: documentId,
      AgentApiName__c: agentApiName,
      DocumentTitle__c: documentTitle.slice(0, 255),
      ChunkIndex__c: c.chunkIndex,
      Content__c: c.content,
    }));
    // Bulk create in batches of 200 (SF collection API limit).
    for (let i = 0; i < rows.length; i += 200) {
      const res = await conn.sobject(OBJECT).create(rows.slice(i, i + 200));
      const results = Array.isArray(res) ? res : [res];
      const failed = results.filter(r => !r.success);
      if (failed.length > 0) {
        logger.error({ orgId, documentId, failed }, 'salesforce_kb_index_partial_failure');
        throw new Error(`Failed to write ${failed.length} of ${results.length} chunks to Salesforce.`);
      }
    }
  },

  async deleteDocument({ orgId, documentId }) {
    const conn = await getOrgConnection(orgId);
    const existing = await conn.query<{ Id: string }>(
      `SELECT Id FROM ${OBJECT} WHERE DocumentExternalId__c = '${documentId.replace(/'/g, "\\'")}'`,
    );
    if (existing.records.length > 0) {
      await conn.sobject(OBJECT).destroy(existing.records.map(r => r.Id));
    }
  },

  async retrieve({ orgId, agentApiName, query, k }) {
    const conn = await getOrgConnection(orgId);
    const term = escapeSosl(query.trim());
    if (!term) return [];
    const agentFilter = agentApiName.replace(/'/g, "\\'");
    const sosl =
      `FIND {${term}} IN ALL FIELDS RETURNING ${OBJECT}` +
      `(Content__c, DocumentTitle__c WHERE AgentApiName__c = '${agentFilter}' LIMIT ${Math.min(k, 50)})`;
    const res = await conn.search(sosl);
    const records = (res.searchRecords ?? []) as unknown as Array<{ Content__c: string; DocumentTitle__c: string }>;
    return records.map(r => ({ content: r.Content__c, documentTitle: r.DocumentTitle__c }));
  },
};
