/**
 * Org-scoped CRUD for connectors. Every query passes orgId so org A can
 * never read or write org B's rows — that single discipline keeps the
 * multi-tenant story honest.
 */
import { prisma } from './client';
import type { Connector } from '@prisma/client';

export interface ConnectorInput {
  orgId: string;
  providerKey: string;
  displayName: string;
  authType?: string;
  configuredBy?: string | null;
}

export const ConnectorsRepo = {
  async listForOrg(orgId: string): Promise<Connector[]> {
    return prisma.connector.findMany({
      where: { orgId },
      orderBy: [{ providerKey: 'asc' }, { createdAt: 'desc' }],
    });
  },

  async getById(orgId: string, id: string): Promise<Connector | null> {
    return prisma.connector.findFirst({ where: { id, orgId } });
  },

  async getByOrgAndProvider(orgId: string, providerKey: string): Promise<Connector | null> {
    return prisma.connector.findFirst({
      where: { orgId, providerKey },
    });
  },

  /** The chatting user's own connection for a provider (Connected only). */
  async getByOrgProviderAndUser(orgId: string, providerKey: string, userId: string): Promise<Connector | null> {
    return prisma.connector.findFirst({
      where: { orgId, providerKey, configuredBy: userId, status: 'Connected' },
    });
  },

  /** Every per-user row for a provider in this org — admin roster view
   *  (Salesforce access page). Excludes org-level rows (configuredBy null). */
  async listUsersForOrgProvider(orgId: string, providerKey: string): Promise<Connector[]> {
    return prisma.connector.findMany({
      where: { orgId, providerKey, configuredBy: { not: null } },
      orderBy: [{ status: 'asc' }, { lastConnectedAt: 'desc' }],
    });
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
      return prisma.connector.update({
        where: { id: existing.id },
        data: { displayName: input.displayName, status: 'Pending' },
      });
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
    return prisma.connector.update({
      where: { id },
      data: {
        status: 'Connected',
        lastConnectedAt: new Date(),
        lastErrorMessage: null,
        ...patch,
      },
    });
  },

  async markError(id: string, message: string): Promise<Connector> {
    return prisma.connector.update({
      where: { id },
      data: { status: 'Error', lastErrorMessage: message.slice(0, 4000) },
    });
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
        accessToken: patch.accessToken,
        tokenExpiresAt: patch.tokenExpiresAt ?? null,
        refreshToken: patch.refreshToken ?? undefined,
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
