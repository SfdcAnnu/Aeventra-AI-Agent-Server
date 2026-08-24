/**
 * App-level Setup routes — master-token model.
 *
 *   1. Apex POST /api/setup/authorize-url
 *        body:    { orgId, userId, sfMyDomainUrl, returnUrl }
 *        server:  generate sessionKey + state, create PendingSetup
 *        returns: { authorizeUrl, sessionKey }
 *      → Apex stashes the sessionKey in SynapseInstall__c immediately
 *        (server doesn't recognise it yet — no OrgInstall row exists)
 *
 *   2. LWC redirects browser to authorizeUrl
 *
 *   3. Browser → GET /api/setup/callback?code=&state=
 *      → server exchanges code, verifies orgId match, PROMOTES the
 *        PendingSetup.sessionKey into an OrgInstall row, deletes PendingSetup
 *      → server 302s browser back to returnUrl?synapse_setup=1
 *
 *   4. LWC sees ?synapse_setup=1 → refreshes status. From this moment the
 *      sessionKey Apex already has becomes recognised by sessionAuth.
 */
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { logger } from '../logger';
import { config } from '../config';
import { InstallsRepo } from '../db/installs.repo';
import { exchangeCode, fetchUserInfo, parseUserIdFromIdUrl } from '../oauth/salesforce';

export const setupRouter = Router();

function setupRedirectUri(): string {
  return `${config.serverPublicUrl.replace(/\/+$/, '')}/api/setup/callback`;
}

// ── 1. authorize-url ─────────────────────────────────────────────────

const authorizeUrlSchema = z.object({
  orgId:         z.string().min(15),
  userId:        z.string().min(15),
  sfMyDomainUrl: z.string().url(),
  returnUrl:     z.string().url(),
});

setupRouter.post('/api/setup/authorize-url', async (req, res) => {
  const parsed = authorizeUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const { orgId, userId, sfMyDomainUrl, returnUrl } = parsed.data;

  if (!config.salesforce.mcpClientId) {
    res.status(500).json({ error: 'server_misconfigured', message: 'SF_MCP_CLIENT_ID is not set in server .env.' });
    return;
  }

  InstallsRepo.sweepStalePending().catch(() => null);

  const state      = crypto.randomUUID();
  const sessionKey = crypto.randomUUID();
  await InstallsRepo.createPending({ state, orgId, userId, returnUrl, sessionKey });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     config.salesforce.mcpClientId,
    redirect_uri:  setupRedirectUri(),
    scope:         'refresh_token api id',
    state,
    prompt:        'login consent',
  });
  const authorizeUrl = `${sfMyDomainUrl.replace(/\/+$/, '')}/services/oauth2/authorize?${params.toString()}`;

  res.json({ authorizeUrl, sessionKey });
});

// ── 2. callback ──────────────────────────────────────────────────────

setupRouter.get('/api/setup/callback', async (req, res) => {
  const code  = String(req.query.code  ?? '');
  const state = String(req.query.state ?? '');
  const errParam = String(req.query.error ?? '');

  if (errParam) {
    logger.warn({ errParam, state }, 'setup_callback_provider_error');
    return finishWithRedirect(res, null, false, errParam);
  }
  if (!code || !state) {
    res.status(400).send('Missing code or state');
    return;
  }

  const pending = await InstallsRepo.findPendingByState(state);
  if (!pending) {
    res.status(400).send('Unknown or expired setup state. Please restart Setup.');
    return;
  }

  try {
    const tok = await exchangeCode(code);
    const userInfo = await fetchUserInfo(tok.instance_url, tok.access_token).catch(() => ({}));

    const idUserId = parseUserIdFromIdUrl(tok.id);
    const orgIdFromTokens = extractOrgIdFromIdUrl(tok.id);
    if (orgIdFromTokens && pending.orgId && !orgsMatch(orgIdFromTokens, pending.orgId)) {
      logger.warn(
        { expected: pending.orgId, got: orgIdFromTokens },
        'setup_callback_org_mismatch',
      );
      return finishWithRedirect(res, pending.returnUrl, false, 'org_mismatch');
    }

    // Promote: copy the pre-minted sessionKey from PendingSetup into an OrgInstall row.
    // sessionAuth middleware reads from OrgInstall, so this is the moment the
    // key Apex already holds becomes recognised.
    await InstallsRepo.upsert({
      orgId:          pending.orgId,
      sessionKey:     pending.sessionKey,
      sfAccessToken:  tok.access_token,
      sfRefreshToken: tok.refresh_token ?? null,
      sfInstanceUrl:  tok.instance_url,
      sfUserId:       idUserId,
      sfUserEmail:    ('email' in userInfo ? userInfo.email : null) ?? null,
      tokenExpiresAt: tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null,
      scopes:         tok.scope ?? null,
    });
    await InstallsRepo.deletePendingByState(state);

    logger.info({ orgId: pending.orgId }, 'setup_complete');
    return finishWithRedirect(res, pending.returnUrl, true, null);
  } catch (err) {
    logger.error({ err, state }, 'setup_callback_failed');
    return finishWithRedirect(res, pending.returnUrl, false, (err as Error).message);
  }
});

function finishWithRedirect(
  res: Parameters<typeof setupRouter.get>[1] extends (req: never, r: infer R) => unknown ? R : never,
  returnUrl: string | null,
  ok: boolean,
  errorMsg: string | null,
) {
  if (!returnUrl) {
    return res.status(ok ? 200 : 400).send(ok ? 'Setup complete (no returnUrl).' : `Setup failed: ${errorMsg}`);
  }
  const sep = returnUrl.includes('?') ? '&' : '?';
  const params: string[] = [`synapse_setup=${ok ? 1 : 0}`];
  if (!ok && errorMsg) params.push(`error=${encodeURIComponent(errorMsg)}`);
  return res.redirect(`${returnUrl}${sep}${params.join('&')}`);
}

function extractOrgIdFromIdUrl(idUrl: string | undefined): string | null {
  if (!idUrl) return null;
  const parts = idUrl.split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

function orgsMatch(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15);
}

// ── 3. status + reset ────────────────────────────────────────────────

const statusSchema = z.object({ orgId: z.string().min(15) });

setupRouter.post('/api/setup/status', async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const install = await InstallsRepo.findByOrgId(parsed.data.orgId);
  logger.info({ orgId: parsed.data.orgId, found: !!install }, 'setup_status_query');
  res.json({
    configured: !!install,
    orgId:      install?.orgId ?? null,
    email:      install?.sfUserEmail ?? null,
    configuredAt: install?.configuredAt ?? null,
  });
});

const resetSchema = z.object({ orgId: z.string().min(15), sessionKey: z.string().min(16) });

setupRouter.post('/api/setup/reset', async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const install = await InstallsRepo.findBySessionKey(parsed.data.sessionKey);
  if (!install || install.orgId !== parsed.data.orgId) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  await InstallsRepo.deleteByOrgId(parsed.data.orgId);
  res.json({ ok: true });
});
