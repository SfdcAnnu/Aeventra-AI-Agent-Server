/**
 * Build a jsforce Connection authenticated as the admin who completed
 * Archon Setup. Uses the tokens stored on OrgInstall.
 *
 * Refresh strategy (two layers):
 *   1. PROACTIVE — before handing out a connection:
 *      • when tokenExpiresAt is known: refresh within 60s of expiry.
 *      • when tokenExpiresAt is NULL (Salesforce web-server flow often
 *        omits expires_in, and JWT-based access tokens expire in ~30 min):
 *        refresh at most every 20 minutes per org. Without this, a null
 *        expiry meant we NEVER refreshed and turns failed with
 *        INVALID_AUTH_HEADER / INVALID_JWT_FORMAT once the token aged out.
 *   2. REACTIVE — on a 401 mid-request jsforce calls OUR refresh function
 *      (refreshFn), which goes through the same refreshOrgInstall as the
 *      proactive path.
 *
 * Refresh-token rotation: every refresh may hand back a new refresh token
 * and revoke the old one. refreshOrgInstall is the ONE place an org's
 * tokens are refreshed, and it always stores the refresh token it got
 * back. jsforce's built-in refresh is not used: it keeps the new refresh
 * token to itself, so the stored one would go stale on the first rotation
 * and the org would drop off at the next refresh.
 *
 * Perf: install rows come from InstallsCache (30s RAM, promise-dedup).
 */
import { Connection } from 'jsforce';
import { InstallsRepo } from '../db/installs.repo';
import { InstallsCache } from '../db/installs-cache';
import { refreshAccessToken } from '../oauth/salesforce';
import { logger } from '../logger';
import type { OrgInstall } from '@prisma/client';

const SKEW_MS = 60_000;
const UNKNOWN_EXPIRY_REFRESH_MS = 20 * 60 * 1000;   // JWT access tokens live ~30 min

// Per-process memory of the last proactive refresh per org (null-expiry path).
const lastProactiveRefresh = new Map<string, number>();

export async function getOrgConnection(orgId: string): Promise<Connection> {
  const install = await InstallsCache.findByOrgId(orgId);
  if (!install) throw new Error(`Org ${orgId} has not completed Archon Setup yet.`);
  if (!install.sfAccessToken || !install.sfInstanceUrl) {
    throw new Error(`Org ${orgId} install is missing tokens — admin must re-run Archon Setup.`);
  }
  const fresh = await ensureFresh(install);

  const conn = new Connection({
    instanceUrl:  fresh.sfInstanceUrl,
    accessToken:  fresh.sfAccessToken,
    version: '62.0',
    // Reactive refresh through refreshOrgInstall, so a rotated refresh
    // token is stored and the NEXT turn (and the Managed-MCP bearer) uses
    // the new access token too.
    ...(fresh.sfRefreshToken
      ? {
          refreshFn: (_c: unknown, callback: (err: Error | null, accessToken?: string, res?: never) => void) => {
            logger.info({ orgId }, 'org_connection_reactive_refresh');
            // Read the row again: another request may have rotated the
            // token since this connection was built.
            InstallsCache.findByOrgId(orgId)
              .then(latest => refreshOrgInstall(latest ?? fresh))
              .then(updated => callback(null, updated.sfAccessToken))
              .catch(err => {
                logger.error({ err, orgId }, 'org_connection_reactive_refresh_failed');
                callback(err instanceof Error ? err : new Error(String(err)));
              });
          },
        }
      : {}),
  });

  return conn;
}

async function ensureFresh(install: OrgInstall): Promise<OrgInstall> {
  const hasExpiry = !!install.tokenExpiresAt;

  if (hasExpiry) {
    if (install.tokenExpiresAt!.getTime() - Date.now() > SKEW_MS) return install;
  } else {
    // Unknown expiry — refresh on a timer instead of never.
    const last = lastProactiveRefresh.get(install.orgId) ?? 0;
    if (Date.now() - last < UNKNOWN_EXPIRY_REFRESH_MS) return install;
  }

  if (!install.sfRefreshToken) {
    if (hasExpiry) {
      throw new Error('Access token expired and no refresh token on file — admin must re-run Archon Setup.');
    }
    return install;   // no expiry info + no refresh token: use as-is
  }

  logger.info({ orgId: install.orgId, hasExpiry }, 'install_token_refreshing');
  return refreshOrgInstall(install);
}

/**
 * Refresh an org's Salesforce tokens and store them — the access token,
 * and the refresh token Salesforce handed back (rotated or not). The only
 * place an OrgInstall's tokens are refreshed. Concurrent calls for one
 * refresh token share a single Salesforce call (oauth/salesforce.ts).
 */
export async function refreshOrgInstall(install: OrgInstall): Promise<OrgInstall> {
  if (!install.sfRefreshToken) {
    throw new Error('No refresh token on file — admin must re-run Archon Setup.');
  }
  let tok;
  try {
    tok = await refreshAccessToken(install.sfRefreshToken);
  } catch (err) {
    logger.error({ err, orgId: install.orgId }, 'install_token_refresh_failed');
    throw new Error('Salesforce token refresh failed — admin must re-run Archon Setup.');
  }
  lastProactiveRefresh.set(install.orgId, Date.now());

  const updated = await InstallsRepo.upsert({
    orgId:          install.orgId,
    sessionKey:     install.sessionKey,
    sfAccessToken:  tok.access_token,
    sfRefreshToken: tok.refresh_token ?? install.sfRefreshToken,
    sfInstanceUrl:  tok.instance_url ?? install.sfInstanceUrl,
    sfUserId:       install.sfUserId,
    sfUserEmail:    install.sfUserEmail,
    tokenExpiresAt: tok.expires_in ? new Date(Date.now() + Number(tok.expires_in) * 1000) : null,
    scopes:         tok.scope ?? install.scopes,
  });
  InstallsCache.put(updated);
  return updated;
}
