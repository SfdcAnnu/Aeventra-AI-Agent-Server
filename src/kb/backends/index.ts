import { prisma } from '../../db/client';
import { archonBackend } from './archon';
import { externalPostgresBackend } from './external-postgres';
import { salesforceBackend } from './salesforce';
import type { KbBackend } from './types';
import type { KbStorageConfig } from '@prisma/client';

export type { KbBackend, KbChunkInput, KbRetrievedChunk } from './types';

/** Resolves the storage backend an org has picked (default: archon-hosted). */
export async function resolveBackend(orgId: string): Promise<{ backend: KbBackend; config: KbStorageConfig | null }> {
  const cfg = await prisma.kbStorageConfig.findUnique({ where: { orgId } });
  if (cfg?.backend === 'external_pg' && cfg.connectionUrl) {
    return { backend: externalPostgresBackend(cfg.connectionUrl), config: cfg };
  }
  if (cfg?.backend === 'salesforce') {
    return { backend: salesforceBackend, config: cfg };
  }
  return { backend: archonBackend, config: cfg };
}
