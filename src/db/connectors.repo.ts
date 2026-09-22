/**
 * Org-scoped CRUD for connectors. Every query passes orgId so org A can
 * never read or write org B's rows — that single discipline keeps the
 * multi-tenant story honest.
 */
import { prisma } from './client';
import type { Connector } from '@prisma/client';
import { seal, open } from '../lib/secret-box';

export interface ConnectorInput {
  orgId: string;
  providerKey: string;
  displayName: string;
  authType?: string;
  configuredBy?: string | null;
}

/**
 * Connector credentials are sealed in the column and opened for the
 * caller, so nothing outside this file changes. See lib/secret-box.ts.
 *
 * Three fields, all of them a key to something that is not ours:
 * accessToken and refreshToken for the connected account, and apiKey for
 * providers that authenticate that way — a customer's own AI provider
 * key among them.
 */
function openConnector<T extends Connector | null>(row: T): T {
  if (!row) return row;
  return {
    ...row,
    accessToken: open(row.accessToken),
    refreshToken: open(row.refreshToken),
    apiKey: open(row.apiKey),
  } as T;
}

const openAll = (rows: Connector[]): Connector[] => rows.map(r => openConnector(r));

/** Seal whichever of the three secret fields a patch actually carries. */
function sealPatch<T extends Record<string, unknown>>(patch: T): T {
  const out: Record<string, unknown> = { ...patch };
  for (const f of ['accessToken', 'refreshToken', 'apiKey']) {
    if (f in out && typeof out[f] === 'string') out[f] = seal(out[f] as string);
  }
  return out as T;
}

export const ConnectorsRepo = {
  async listForOrg(orgId: string): Promise<Connector[]> {
    return openAll(await prisma.connector.findMany({
      where: { orgId },
      orderBy: [{ providerKey: 'asc' }, { createdAt: 'desc' }],
    }));
  },

  async getById(orgId: string, id: string): Promise<Connector | null> {
    return openConnector(await prisma.connector.findFirst({ where: { id, orgId } }));
  },

  async getByOrgAndProvider(orgId: string, providerKey: string): Promise<Connector | null> {
    return openConnector(await prisma.connector.findFirst({
      where: { orgId, providerKey },
    }));
  },

  /** The chatting user's own connection for a provider (Connected only). */
  async getByOrgProviderAndUser(orgId: string, providerKey: string, userId: string): Promise<Connector | null> {
    return openConnector(await prisma.connector.findFirst({
      where: { orgId, providerKey, configuredBy: userId, status: 'Connected' },
    }));
  },

  /** Every per-user row for a provider in this org — admin roster view
   *  (Salesforce access page). Excludes org-level rows (configuredBy null). */
  async listUsersForOrgProvider(orgId: string, providerKey: string): Promise<Connector[]> {
    return openAll(await prisma.connector.findMany({
      where: { orgId, providerKey, configuredBy: { not: null } },
      orderBy: [{ status: 'asc' }, { lastConnectedAt: 'desc' }],
    }));
  },

  /** Upsert a Pending row before the OAuth round-trip starts.
   *  Connections are PER USER (configuredBy) per provider per org. */
  async upsertPending(input: ConnectorInput): Promise<Connector> {
    const existing = await prisma.connector.findFirst({
      where: {
        orgId:        input.orgId,
        providerKey:  input.providerKey,
        configuredBy: input.configuredBy ?? null,
      },
    });
    if (existing) {
      return openConnector(await prisma.connector.update({
        where: { id: existing.id },
        data: { displayName: input.displayName, status: 'Pending' },
      }));
    }
    return prisma.connector.create({
      data: {
        orgId:        input.orgId,
        providerKey:  input.providerKey,
        displayName:  input.displayName,
        status:       'Pending',
        authType:     input.authType ?? 'OAuth2',
        configuredBy: input.configuredBy ?? null,
      },
    });
  },

  async markConnected(id: string, patch: {
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    scopes?: string | null;
    instanceUrl?: string | null;
    accountEmail?: string | null;
    externalAccountId?: string | null;
  }): Promise<Connector> {
    return openConnector(await prisma.connector.update({
      where: { id },
      data: {
        status: 'Connected',
        lastConnectedAt: new Date(),
        lastErrorMessage: null,
        ...sealPatch(patch),
      },
    }));
  },

  async markError(id: string, message: string): Promise<Connector> {
    return openConnector(await prisma.connector.update({
      where: { id },
      data: { status: 'Error', lastErrorMessage: message.slice(0, 4000) },
    }));
  },

  async disconnect(orgId: string, id: string): Promise<Connector> {
    const existing = await prisma.connector.findFirst({ where: { id, orgId } });
    if (!existing) throw new Error('Connector not found');
    return prisma.connector.update({
      where: { id },
      data: {
        status: 'Disconnected',
        accessToken: null,
        refreshToken: null,
        tokenExpiresAt: null,
        scopes: null,
      },
    });
  },

  async updateTokens(id: string, patch: {
    accessToken: string;
    tokenExpiresAt?: Date | null;
    refreshToken?: string | null;
    instanceUrl?: string | null;
  }): Promise<Connector> {
    return prisma.connector.update({
      where: { id },
      data: {
        accessToken: seal(patch.accessToken) as string,
        tokenExpiresAt: patch.tokenExpiresAt ?? null,
        refreshToken: patch.refreshToken === undefined ? undefined : seal(patch.refreshToken),
        instanceUrl: patch.instanceUrl ?? undefined,
        status: 'Connected',
        lastErrorMessage: null,
        lastConnectedAt: new Date(),
      },
    });
  },
};

export const PendingOAuthRepo = {
  async create(args: { state: string; orgId: string; providerKey: string; displayName: string; returnUrl: string; connectorId?: string }) {
    return prisma.pendingOAuth.create({
      data: { ...args, connectorId: args.connectorId ?? null },
    });
  },

  async consume(state: string) {
    const row = await prisma.pendingOAuth.findUnique({ where: { state } });
    if (row) await prisma.pendingOAuth.delete({ where: { state } }).catch(() => null);
    return row;
  },
};
