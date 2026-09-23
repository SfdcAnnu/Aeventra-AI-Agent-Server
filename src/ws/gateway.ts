/**
 * WebSocket gateway — the browser's other half of the ephemeral-ticket
 * pattern (server/src/routes/ws.routes.ts mints the ticket; this redeems
 * it on upgrade). Runs alongside the existing Express app on the SAME
 * http.Server (server/src/index.ts switches from app.listen() to
 * http.createServer(app) + this module's attach()), not a second port —
 * one Render service, one URL.
 *
 * Security invariants (all enforced here, not left to the client):
 *   1. Transport — reject any upgrade that didn't arrive over TLS. Render
 *      terminates TLS at its edge, so this is defense-in-depth against a
 *      misrouted plain connection reaching the app layer, not the primary
 *      guarantee.
 *   2. Origin — only Salesforce-hosted origins may open a socket here.
 *      Checked by domain suffix (not a per-org literal list) so this
 *      works for any org that installs the package, not just one client.
 *      A UI Bundle's real origin is *.my.salesforce.app (confirmed
 *      empirically against a live deploy); classic LWC pages are
 *      *.lightning.force.com / *.my.salesforce.com. All three covered.
 *   3. Ticket — single-use, short-lived, atomically redeemed (see
 *      ws-tickets.repo.ts). A replayed or expired ticket is rejected.
 *   4. Bound context — once a connection is accepted, EVERY message on it
 *      is processed using ONLY the {orgId, userId, agentApiName,
 *      sessionId} resolved from the ticket at redemption time. Identity-
 *      shaped fields inside a message payload (if any ever appear) are
 *      never trusted.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import type { Connection } from 'jsforce';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { logger } from '../logger';
import { config } from '../config';
import { WsTicketsRepo } from '../db/ws-tickets.repo';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { AgentCache } from '../chat/agent-cache';
import { runChatTurn } from '../chat/chat-engine';
import type { ChatTurnResult } from '../chat/chat-engine';
import { connectorsForAgent } from '../salesforce/agent-connectors';
import { checkGuardrails } from '../salesforce/guardrails';
import { resolveWsChatSession, recordWsTurn, recordWsTurnFailure, type WsChatSession } from '../salesforce/ws-chat-persistence';
import type { EngineOverrideInput } from '../types';
import type { TurnSink } from '../chat/adapters/types';

const ALLOWED_ORIGIN_SUFFIXES = ['.salesforce.app', '.lightning.force.com', '.my.salesforce.com'];

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_ORIGIN_SUFFIXES.some(suffix => host.endsWith(suffix));
  } catch {
    return false;
  }
}

interface ConnectionContext {
  orgId: string;
  userId: string;
  agentApiName: string;
  sessionId: string;
  // Resolved by Apex at ticket-mint time (AgentWebSocketController.cls) and
  // bound here at redemption — same "never trust the message body for
  // identity" rule as orgId/userId/agentApiName/sessionId above, just
  // applied to credentials too.
  engineOverride?: EngineOverrideInput;
}

const connectionContexts = new WeakMap<WebSocket, ConnectionContext>();

// Per-connection message rate cap — coarse, in-process. Coordinating across
// multiple Node instances would need a shared counter; not built until a
// real deployment actually needs it (single Render instance today).
const MAX_MESSAGES_PER_MINUTE = 20;
const messageTimestamps = new WeakMap<WebSocket, number[]>();

// Lazily-created Salesforce ChatSession__c for this connection's turns —
// created on the first successful turn, reused for every turn after (see
// ws-chat-persistence.ts's module doc for why this exists at all).
type WsSessionState = WsChatSession;
const wsSessionState = new WeakMap<WebSocket, WsSessionState>();

/**
 * The session row for this socket, resolved once and kept.
 *
 * It used to be resolved lazily inside persistTurnUsage, AFTER the turn,
 * because writing the transcript was all it was for. It also carries the
 * record the conversation is anchored to, and the turn needs that BEFORE
 * the model runs — so it is resolved on first use and reused for the life
 * of the connection. One query per socket, not per message.
 */
async function sessionStateFor(
  ws: WebSocket,
  conn: Connection,
  ctx: ConnectionContext,
  agentId: string,
  department: string | undefined,
): Promise<WsSessionState> {
  let state = wsSessionState.get(ws);
  if (!state) {
    state = await resolveWsChatSession(conn, ctx.sessionId, agentId, ctx.userId, department);
    wsSessionState.set(ws, state);
  }
  return state;
}

function isRateLimited(ws: WebSocket): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const timestamps = (messageTimestamps.get(ws) ?? []).filter(t => t > windowStart);
  timestamps.push(now);
  messageTimestamps.set(ws, timestamps);
  return timestamps.length > MAX_MESSAGES_PER_MINUTE;
}

const turnMessageSchema = z.object({
  newUserMessage: z.string().max(20_000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant', 'tool', 'system']),
    content: z.string(),
    toolCallsJson: z.string().nullish(),
    toolResultsJson: z.string().nullish(),
    toolCallId: z.string().nullish(),
  })).default([]),
  attachments: z.array(z.object({
    contentDocumentId: z.string().min(15),
    contentVersionId:  z.string().min(15).optional(),
    fileName:          z.string().optional(),
    mimeType:          z.string().optional(),
    fileType:          z.string().optional(),
    fileExtension:     z.string().optional(),
  })).optional(),
  // engineOverride is deliberately NOT part of this schema — credentials are
  // bound server-side into ConnectionContext at ticket redemption (see
  // AgentWebSocketController.cls), never accepted from a client message.
  connectors: z.array(z.object({
    provider:     z.string().min(1),
    mcpServerUrl: z.string().url(),
    allowedTools: z.array(z.string()).default([]),
    connectorId:  z.string().nullish(),
    accessMode:   z.string().nullish(),
    customTools:  z.array(z.object({
      type:  z.string().min(1),
      name:  z.string().min(1),
      label: z.string().nullish(),
    })).nullish(),
  })).optional(),
  debugMode: z.boolean().optional(),
  // Opt-in live narration. A browser running an older bundle never sets
  // this, so it keeps receiving exactly one frame per turn and needs no
  // knowledge of stage frames. That is what lets the server ship ahead of
  // the Salesforce bundle, which deploys separately.
  stream: z.boolean().optional(),
  // The turn after an approved action executed: no user text, the result.
  continuation: z.object({ toolName: z.string().min(1).max(200), resultText: z.string().max(20_000) }).nullish(),
});

/** Most live frames a single turn may send. A pathological turn cannot
 *  flood a browser; narration stops and the reply is unaffected. */
const MAX_LIVE_FRAMES = Number(process.env.STAGE_MAX_FRAMES) || 4_000;
/** Stop sending once the socket has this much unsent. A reader on a slow
 *  link gets the reply, not a backlog it will never catch up with. */
const LIVE_BACKPRESSURE_BYTES = Number(process.env.STAGE_BACKPRESSURE_BYTES) || 256_000;

/** Delivers live narration and reply text to one browser.
 *
 *  Two failure rules, because the two kinds of frame are not equally
 *  disposable:
 *
 *  A STAGE frame is advisory. Dropping one costs a label, so a closed
 *  socket, a full buffer or a throw simply drops it.
 *
 *  A TEXT frame is not — dropping one silently loses characters from what
 *  the reader is reading. So text never drops: the moment it cannot be
 *  delivered intact, streaming stops for the rest of the turn and the
 *  reader is told to discard the fragment. That is safe because the turn
 *  result still carries the complete reply, and the browser renders that
 *  over whatever it showed.
 *
 *  Nothing in here can delay or fail a reply. */
function makeTurnSink(ws: WebSocket): TurnSink {
  let seq = 0;
  let textStopped = false;

  const send = (frame: Record<string, unknown>): boolean => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ ...frame, seq: seq++ }));
      return true;
    } catch {
      return false;
    }
  };

  return event => {
    if (seq >= MAX_LIVE_FRAMES) return;

    if (event.kind === 'stage') {
      if (ws.bufferedAmount > LIVE_BACKPRESSURE_BYTES) return;
      const { kind: _kind, ...update } = event;
      send({ type: 'stage', ...update });
      return;
    }

    if (event.kind === 'reset') {
      textStopped = false;
      send({ type: 'text.reset' });
      return;
    }

    if (textStopped) return;
    if (ws.bufferedAmount > LIVE_BACKPRESSURE_BYTES || !send({ type: 'text.delta', delta: event.delta })) {
      // Cannot deliver this one intact, so deliver none of the rest.
      textStopped = true;
      send({ type: 'text.reset' });
    }
  };
}

async function handleMessage(ws: WebSocket, ctx: ConnectionContext, raw: string): Promise<void> {
  if (isRateLimited(ws)) {
    ws.send(JSON.stringify({ status: 'error', error: 'rate_limited' }));
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    ws.send(JSON.stringify({ status: 'error', error: 'invalid_json' }));
    return;
  }
  const parsed = turnMessageSchema.safeParse(body);
  if (!parsed.success) {
    ws.send(JSON.stringify({ status: 'error', error: 'invalid_body', details: parsed.error.flatten() }));
    return;
  }

  try {
    const conn = await getOrgConnection(ctx.orgId);
    const agent = await AgentCache.load(ctx.orgId, ctx.agentApiName, conn);
    if (!agent) {
      ws.send(JSON.stringify({ status: 'error', error: 'agent_not_found' }));
      return;
    }
    if (agent.status !== 'Active') {
      ws.send(JSON.stringify({ status: 'error', error: 'agent_not_active', agentStatus: agent.status }));
      return;
    }

    // Hard stop, checked first — same guarantee AgentChatController.cls's
    // HTTP path gets from enforceBeforeTurn(), which this WebSocket path
    // never routes through (see guardrails.ts's module doc).
    const guardrail = await checkGuardrails(conn, ctx.orgId);
    if (guardrail.blocked) {
      ws.send(JSON.stringify({ status: 'error', error: 'guardrail_exceeded', message: guardrail.message }));
      return;
    }

    // Resolved once per socket and reused. The turn needs the record this
    // conversation is anchored to before the model runs, and persistence
    // needs the same row afterwards.
    const sessionState = await sessionStateFor(ws, conn, ctx, agent.id, agent.department);

    let result: ChatTurnResult;
    try {
      result = await runChatTurn({
      agent,
      transport: 'ws',
      sessionId: ctx.sessionId,
      history:   parsed.data.history,
      newUserMessage: parsed.data.newUserMessage,
      attachments:    parsed.data.attachments,
      engineOverride: ctx.engineOverride,
      // A browser cannot know MCP server URLs or catalog metadata, so it
      // sends none and the server derives them from the agent. Without
      // this the turn fell through to a legacy env fallback and an agent
      // tested here ran against a different Salesforce MCP server than the
      // same agent in production -- or, when that fallback was unreachable,
      // against no tools at all. A caller that DOES supply connectors is
      // still trusted, so the HTTP path is unchanged.
      connectors:     parsed.data.connectors?.length
        ? parsed.data.connectors
        : await connectorsForAgent(conn, agent),
      debugMode:      parsed.data.debugMode,
      continuation:   parsed.data.continuation ?? null,
      onEvent:        parsed.data.stream ? makeTurnSink(ws) : null,
      // Bound identity — NOT read from the message body (see module doc).
      // THE RECORD THE CHAT IS ANCHORED TO, FROM THE SESSION ROW.
      //
      // This was hardcoded null, so a chat opened on a Lead could not tell
      // the model which Lead — the agent had to soqlQuery its way to the
      // record it was standing on, costing a model call and a tool call on
      // the first question of every record-anchored conversation.
      //
      // It is NOT read from the message body, and that is deliberate:
      // record-context.ts reads the row with the ORG's connection, so an
      // id taken off the wire would let any user read any record and skip
      // their own sharing. Apex wrote these fields when the session was
      // created, through that user's permissions.
      context: {
        orgId: ctx.orgId,
        userId: ctx.userId,
        recordContextId: sessionState.recordContextId,
        recordContextType: sessionState.recordContextType,
      },
      });
    } catch (err) {
      // The turn threw. Record it as a failed turn so Conversations and the
      // dashboards see it; the outer catch still tells the browser.
      void persistTurnFailure(ws, conn, ctx, agent.id, agent.department, parsed.data.newUserMessage, (err as Error).message)
        .catch(e => logger.error({ err: e, orgId: ctx.orgId }, 'ws_turn_failure_persist_failed'));
      throw err;
    }
    ws.send(JSON.stringify(result));

    // Best-effort accounting, after the response is already on the wire —
    // a Salesforce DML hiccup here must never turn a successful reply into
    // a failed one. This is what makes the guardrail check above actually
    // see WS-path usage on the NEXT turn (see ws-chat-persistence.ts).
    if (result.status === 'complete') {
      void persistTurnUsage(ws, conn, ctx, agent.id, agent.department, parsed.data.continuation ? '' : parsed.data.newUserMessage, result)
        .catch(err => logger.error({ err, orgId: ctx.orgId }, 'ws_turn_persist_failed'));
    }
  } catch (err) {
    logger.error({ err, orgId: ctx.orgId, agentApiName: ctx.agentApiName }, 'ws_turn_failed');
    ws.send(JSON.stringify({ status: 'error', error: 'chat_turn_failed', message: (err as Error).message }));
  }
}

/** Writes ChatSession__c/ChatMessage__c for a completed WS turn — see
 *  ws-chat-persistence.ts's module doc for why this matters even though
 *  the browser never reads these rows back. */
async function persistTurnUsage(
  ws: WebSocket,
  conn: Connection,
  ctx: ConnectionContext,
  agentId: string,
  department: string | undefined,
  userText: string,
  result: ChatTurnResult,
): Promise<void> {
  const state = await sessionStateFor(ws, conn, ctx, agentId, department);
  // Advance by however many rows were actually written — a turn with tool
  // calls writes more than the user+assistant pair.
  const written = await recordWsTurn(conn, state.chatSessionId, state.nextSeq, userText, result);
  state.nextSeq += written;
}

/** The failed-turn twin of persistTurnUsage — same session resolution,
 *  same sequence bookkeeping, a Failed assistant row instead of a reply. */
async function persistTurnFailure(
  ws: WebSocket,
  conn: Connection,
  ctx: ConnectionContext,
  agentId: string,
  department: string | undefined,
  userText: string,
  errorMessage: string,
): Promise<void> {
  let state = wsSessionState.get(ws);
  if (!state) {
    state = await resolveWsChatSession(conn, ctx.sessionId, agentId, ctx.userId, department);
    wsSessionState.set(ws, state);
  }
  const written = await recordWsTurnFailure(conn, state.chatSessionId, state.nextSeq, userText, errorMessage);
  state.nextSeq += written;
}

export function attach(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!req.url?.startsWith('/ws')) {
      // Not ours — let any other upgrade handler on this server see it.
      // Today there isn't one, so this is a clean reject.
      socket.destroy();
      return;
    }

    const forwardedProto = req.headers['x-forwarded-proto'];
    const isSecure = config.nodeEnv !== 'production' || forwardedProto === 'https';
    if (!isSecure) {
      logger.warn({ forwardedProto }, 'ws_upgrade_rejected_insecure_transport');
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      logger.warn({ origin }, 'ws_upgrade_rejected_origin');
      socket.destroy();
      return;
    }

    const url = new URL(req.url, 'http://internal');
    const ticketId = url.searchParams.get('ticket');
    if (!ticketId) {
      logger.warn('ws_upgrade_rejected_missing_ticket');
      socket.destroy();
      return;
    }

    const ticket = await WsTicketsRepo.redeem(ticketId).catch(err => {
      logger.error({ err }, 'ws_ticket_redeem_error');
      return null;
    });
    if (!ticket) {
      logger.warn({ ticketId }, 'ws_upgrade_rejected_invalid_ticket');
      socket.destroy();
      return;
    }

    let engineOverride: EngineOverrideInput | undefined;
    if (ticket.engineOverride) {
      try {
        engineOverride = JSON.parse(ticket.engineOverride) as EngineOverrideInput;
      } catch (err) {
        logger.error({ err }, 'ws_ticket_engine_override_parse_failed');
      }
    }

    wss.handleUpgrade(req, socket, head, ws => {
      connectionContexts.set(ws, {
        orgId: ticket.orgId,
        userId: ticket.userId,
        agentApiName: ticket.agentApiName,
        sessionId: ticket.sessionId,
        engineOverride,
      });
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    const ctx = connectionContexts.get(ws);
    if (!ctx) {
      // Unreachable in practice — every connection reaching here came
      // through handleUpgrade above, which always sets this first.
      ws.close(1011, 'missing_context');
      return;
    }
    logger.info({ orgId: ctx.orgId, agentApiName: ctx.agentApiName }, 'ws_connection_opened');

    ws.on('message', (data) => {
      void handleMessage(ws, ctx, data.toString());
    });
    ws.on('close', () => {
      logger.info({ orgId: ctx.orgId, agentApiName: ctx.agentApiName }, 'ws_connection_closed');
      messageTimestamps.delete(ws);
      wsSessionState.delete(ws);
    });
    ws.on('error', (err) => {
      logger.error({ err, orgId: ctx.orgId }, 'ws_connection_error');
    });
  });

  logger.info('ws_gateway_attached');
}
