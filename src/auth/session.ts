/**
 * sessionAuth — replaces the old JWT middleware on per-org routes.
 *
 * Apex sends `Authorization: Bearer <sessionKey>` on every callout.
 * We look the key up in OrgInstall to find the orgId and attach it to req.
 *
 * The sessionKey is server-minted on OAuth completion (see setup routes).
 * Long-lived, revocable by deleting the OrgInstall row.
 */
import type { NextFunction, Request, Response } from 'express';
import { InstallsRepo } from '../db/installs.repo';
import { logger } from '../logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      orgId?: string;
      sessionKey?: string;
    }
  }
}

export async function sessionAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.header('Authorization') ?? req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_authorization' });
    return;
  }
  const sessionKey = header.slice('Bearer '.length).trim();
  if (!sessionKey) {
    res.status(401).json({ error: 'empty_bearer' });
    return;
  }

  try {
    const install = await InstallsRepo.findBySessionKey(sessionKey);
    if (!install) {
      logger.warn({ keyPrefix: sessionKey.slice(0, 8) + '...' }, 'session_unknown');
      res.status(401).json({ error: 'invalid_session', message: 'Session key not recognised — admin must re-run Synapse Setup.' });
      return;
    }
    req.orgId = install.orgId;
    req.sessionKey = sessionKey;
    next();
  } catch (err) {
    logger.error({ err }, 'session_auth_failed');
    res.status(500).json({ error: 'session_auth_error' });
  }
}
