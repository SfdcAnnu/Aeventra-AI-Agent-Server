/**
 * Per-org install rows + pending-setup rows.
 *
 * OrgInstall is the long-lived record. It holds the sessionKey (which Apex
 * sends as Bearer on every subsequent callout) and the SF OAuth tokens the
 * server uses for back-channel calls into the customer's org.
 *
 * PendingSetup is short-lived — created when Apex starts the OAuth dance,
 * promoted to OrgInstall when the OAuth callback completes. The sessionKey
 * is pre-minted at create time so Apex can stash it before OAuth even
 * starts (master-token model). It only becomes USABLE once it lives on an
 * OrgInstall row — the sessionAuth middleware looks at OrgInstall, not
 * PendingSetup.
 */
import { prisma } from './client';
import type { OrgInstall, PendingSetup } from '@prisma/client';

export const InstallsRepo = {
  // ── OrgInstall ────────────────────────────────────────────────

  async findByOrgId(orgId: string): Promise<OrgInstall | null> {
    return prisma.orgInstall.findUnique({ where: { orgId } });
  },

  async findBySessionKey(sessionKey: string): Promise<OrgInstall | null> {
    return prisma.orgInstall.findUnique({ where: { sessionKey } });
  },

  async upsert(input: {
    orgId: string;
    sessionKey: string;
    sfAccessToken: string;
    sfRefreshToken: string | null;
    sfInstanceUrl: string;
    sfUserId: string | null;
    sfUserEmail: string | null;
    tokenExpiresAt: Date | null;
    scopes: string | null;
  }): Promise<OrgInstall> {
    return prisma.orgInstall.upsert({
      where: { orgId: input.orgId },
      create: { ...input },
      update: {
        sessionKey: input.sessionKey,
        sfAccessToken: input.sfAccessToken,
        sfRefreshToken: input.sfRefreshToken,
        sfInstanceUrl: input.sfInstanceUrl,
        sfUserId: input.sfUserId,
        sfUserEmail: input.sfUserEmail,
        tokenExpiresAt: input.tokenExpiresAt,
        scopes: input.scopes,
      },
    });
  },

  async deleteByOrgId(orgId: string): Promise<void> {
    await prisma.orgInstall.delete({ where: { orgId } }).catch(() => null);
  },

  // ── PendingSetup ──────────────────────────────────────────────

  async createPending(args: {
    state: string;
    orgId: string;
    userId: string;
    returnUrl: string;
    sessionKey: string;
  }): Promise<PendingSetup> {
    return prisma.pendingSetup.create({ data: args });
  },

  async findPendingByState(state: string): Promise<PendingSetup | null> {
    return prisma.pendingSetup.findUnique({ where: { state } });
  },

  async deletePendingByState(state: string): Promise<void> {
    await prisma.pendingSetup.delete({ where: { state } }).catch(() => null);
  },

  /** Expire pending rows older than 10 minutes. Called opportunistically. */
  async sweepStalePending(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000);
    await prisma.pendingSetup.deleteMany({ where: { createdAt: { lt: cutoff } } });
  },
};
