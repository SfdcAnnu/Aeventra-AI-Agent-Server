/**
 * WebSocket ticket-minting route.
 *
 *   POST /api/ws/ticket
 *     Body: { agentApiName, sessionId, userId }
 *     Returns: { ticket, wsUrl, expiresInSeconds }
 *
 * Called by Apex (AgentWebSocketController.cls), never directly by the
 * browser — this is the server-to-server leg of the ephemeral-ticket
 * pattern. The BROWSER only ever sees the opaque ticket id this returns,
 * never SessionKey__c.
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { config } from '../config';
import { WsTicketsRepo } from '../db/ws-tickets.repo';

export const wsRouter = Router();

const ticketSchema = z.object({
  agentApiName: z.string().min(1),
  sessionId:    z.string().min(1),
  userId:       z.string().min(1),
  engineOverride: z.object({
    engineType:   z.string().nullish(),
    apiKey:       z.string().nullish(),
    endpoint:     z.string().nullish(),
    defaultModel: z.string().nullish(),
    connectionId: z.string().nullish(),
  }).optional(),
});

const TTL_SECONDS = 45;

wsRouter.post('/api/ws/ticket', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = ticketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }

  try {
    const ticket = await WsTicketsRepo.mint({
      orgId,
      userId:       parsed.data.userId,
      agentApiName: parsed.data.agentApiName,
      sessionId:    parsed.data.sessionId,
      engineOverride: parsed.data.engineOverride ? JSON.stringify(parsed.data.engineOverride) : null,
    });
    const wsUrl = config.serverPublicUrl.replace(/^http/, 'ws') + '/ws';
    res.json({ ticket: ticket.id, wsUrl, expiresInSeconds: TTL_SECONDS });
  } catch (err) {
    logger.error({ err, orgId }, 'ws_ticket_mint_failed');
    res.status(500).json({ error: 'ws_ticket_mint_failed', message: (err as Error).message });
  }
});
