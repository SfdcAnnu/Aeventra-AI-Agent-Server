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
import { seal, open } from '../lib/secret-box';

/**
 * Salesforce tokens are sealed on the way in and opened on the way out, so
 * nothing above this file changes and nothing below it holds a usable
 * credential. See lib/secret-box.ts.
 *
 * sessionKey IS DELIBERATELY NOT SEALED. It is a lookup column —
 * findBySessionKey resolves the bearer Apex sends — and sealing uses a
 * fresh IV per write, so the same key would encrypt differently every time
 * and could never be found again. The right shape for a value that is only
 * ever VERIFIED is a hash column with the index on it, which is a schema
 * migration and a dual-read window rather than a wrapper: worth doing, and
 * not this change.
 */
function openInstall(row: OrgInstall | null): OrgInstall | null {
  if (!row) return null;
  return {
    ...row,
    sfAccessToken: open(row.sfAccessToken) as OrgInstall['sfAccessToken'],
    sfRefreshToken: open(row.sfRefreshToken) as OrgInstall['sfRefreshToken'],
  };
}

export const InstallsRepo = {
  // ── OrgInstall ────────────────────────────────────────────────

  async findByOrgId(orgId: string): Promise<OrgInstall | null> {
    return openInstall(await prisma.orgInstall.findUnique({ where: { orgId } }));
  },

  async findBySessionKey(sessionKey: string): Promise<OrgInstall | null> {
    return openInstall(await prisma.orgInstall.findUnique({ where: { sessionKey } }));
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
    const sealed = {
      ...input,
      sfAccessToken: seal(input.sfAccessToken) as string,
      sfRefreshToken: seal(input.sfRefreshToken),
    };
    return openInstall(await prisma.orgInstall.upsert({
      where: { orgId: input.orgId },
      create: { ...sealed },
      update: {
        sessionKey: sealed.sessionKey,
        sfAccessToken: sealed.sfAccessToken,
        sfRefreshToken: sealed.sfRefreshToken,
        sfInstanceUrl: input.sfInstanceUrl,
        sfUserId: input.sfUserId,
        sfUserEmail: input.sfUserEmail,
        tokenExpiresAt: input.tokenExpiresAt,
        scopes: input.scopes,
      },
    })) as OrgInstall;
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
