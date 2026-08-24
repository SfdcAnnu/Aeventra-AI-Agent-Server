/**
 * Connector loader — Prisma-backed (server-owned).
 *
 * In v1 we ignore caching (each call hits SQLite, which is essentially free).
 * Re-export the Prisma `Connector` row type as `ConnectorRecord` so the
 * dispatcher / mcp/servers / ai.ts code doesn't need to change shape.
 */
import type { Connector } from '@prisma/client';
import { prisma } from '../db/client';

export type ConnectorRecord = Connector;

export async function loadConnector(connectorId: string): Promise<ConnectorRecord> {
  if (!connectorId) throw new Error('connectorId required');
  const row = await prisma.connector.findUnique({ where: { id: connectorId } });
  if (!row) throw new Error(`Connector ${connectorId} not found`);
  if (row.status !== 'Connected') {
    throw new Error(`Connector ${row.providerKey} (${row.id}) is ${row.status}, not Connected. Admin must reconnect.`);
  }
  return row;
}

/** No-op cache invalidators left for API compatibility. */
export function clearConnector(_connectorId: string): void { /* noop */ }
export function clearAllConnectors(): void { /* noop */ }
