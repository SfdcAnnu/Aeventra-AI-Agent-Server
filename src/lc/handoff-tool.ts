/**
 * hand_off_to_human — the tool a "Hand off to a person" node gives the agent.
 *
 * The node is drawn on the canvas like any action and wired to the AI
 * node; the agent has the tool only while that line exists. Everything
 * about the handoff is the node's config: who takes over, how they are
 * told, how long before the agent takes the conversation back, and what
 * the customer hears.
 *
 * The tool itself only writes the handoff STATE onto the session row
 * (Status 'Handed off' plus the Handoff* fields). Apex does the rest from
 * a trigger on that change — the transcript line, the notification and
 * email, routing through Omni-Channel when a queue owns the record — so
 * the agent's path and the Return button's path cannot drift apart
 * (force-app classes ChatSessionHandoffHandler, AgentHandoffService).
 */
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { getOrgConnection } from '../salesforce/per-org-connection';
import { pkgConn } from '../salesforce/namespace';
import { nextNodes, type GraphAdjacency } from '../orchestrator/graph';
import { logger } from '../logger';
import type { AgentNode } from '../types';

export type HandoffWho = 'owner' | 'queue' | 'user' | 'group' | 'omni';

export interface HandoffConfig {
  actionType?: string;
  description?: string;
  whoTakesOver?: HandoffWho;
  assigneeId?: string;
  assigneeLabel?: string;
  /** Omni-Channel: route the related Lead or Case instead of the conversation. */
  routeRelated?: boolean;
  notifyNotification?: boolean;
  notifyEmail?: boolean;
  returnAfterHours?: number;
  customerLineOnHandoff?: string;
  customerLineOnReturn?: string;
}

export interface HandoffContext {
  orgId: string;
  sessionId: string;
  recordContextId?: string | null;
  recordContextType?: string | null;
}

export const DEFAULT_HANDOFF_LINE = 'A colleague will take it from here and reply on this number.';
export const DEFAULT_RETURN_LINE = "You're back with our assistant. Anything else I can help with?";
export const DEFAULT_QUIET_HOURS = 12;
const SAFE_ID = /^[a-zA-Z0-9]{15,18}$/;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,80}$/;

export const isHandoffNode = (n: AgentNode): boolean =>
  n.nodeType === 'tool' && (n.config as HandoffConfig | undefined)?.actionType === 'Handoff';

/** Build the tool for every enabled handoff node wired to ownerNode. */
export function buildHandoffTools(ctx: HandoffContext, graph: GraphAdjacency, ownerNode: AgentNode): StructuredToolInterface[] {
  const nodes = nextNodes(graph, ownerNode.id, 'tool').filter(n => n.isEnabled && isHandoffNode(n));
  return nodes.map((node, i) => {
    const cfg = (node.config ?? {}) as HandoffConfig;
    const name = i === 0 ? 'hand_off_to_human' : `hand_off_to_human_${node.id.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const description =
      `${cfg.description?.trim() || 'Hand this conversation to a person.'} ` +
      'Call it once, with the reason in a few words. After it, your reply to the customer is the one line the result gives you, and the conversation is theirs until it returns to you.';
    return tool(
      async ({ reason }: { reason: string }) => handOff(ctx, cfg, reason),
      { name, description, schema: z.object({ reason: z.string().min(1).max(255).describe('Why the customer needs a person, in a few words.') }) },
    ) as StructuredToolInterface;
  });
}

interface SessionRow { Id: string; Status__c: string; OwnerId: string; User__c: string | null; RecordContextId__c: string | null; RecordContextType__c: string | null; Channel__c: string | null }

/** Who takes over, resolved to an Id and a name people recognise. */
async function resolveAssignee(pc: ReturnType<typeof pkgConn>, cfg: HandoffConfig, session: SessionRow): Promise<{ type: HandoffWho; id: string | null; label: string }> {
  const who: HandoffWho = cfg.whoTakesOver ?? 'owner';
  const given = cfg.assigneeId && SAFE_ID.test(cfg.assigneeId) ? cfg.assigneeId : null;
  if (who === 'user' || who === 'queue' || who === 'group' || who === 'omni') {
    if (!given) throw new Error(`The handoff node has no ${who === 'user' ? 'user' : who === 'group' ? 'group' : 'queue'} picked.`);
    const label = cfg.assigneeLabel?.trim() || (await nameOf(pc, given, who === 'user' ? 'User' : 'Group')) || given;
    return { type: who, id: given, label };
  }
  // The record's owner, when it is a person; the session's anchor user otherwise.
  const type = session.RecordContextType__c;
  const recId = session.RecordContextId__c;
  if (type && recId && SAFE_NAME.test(type) && SAFE_ID.test(recId)) {
    try {
      const r = await pc.query<{ OwnerId: string }>(`SELECT OwnerId FROM ${type} WHERE Id = '${recId}' LIMIT 1`);
      const ownerId = r.records[0]?.OwnerId;
      if (ownerId && ownerId.startsWith('005')) return { type: 'owner', id: ownerId, label: (await nameOf(pc, ownerId, 'User')) ?? 'the record owner' };
      if (ownerId && ownerId.startsWith('00G')) return { type: 'queue', id: ownerId, label: (await nameOf(pc, ownerId, 'Group')) ?? 'the record owner queue' };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'handoff_owner_lookup_failed');
    }
  }
  if (session.User__c && session.User__c.startsWith('005')) {
    return { type: 'owner', id: session.User__c, label: (await nameOf(pc, session.User__c, 'User')) ?? 'the conversation owner' };
  }
  if (session.OwnerId && session.OwnerId.startsWith('005')) {
    return { type: 'owner', id: session.OwnerId, label: (await nameOf(pc, session.OwnerId, 'User')) ?? 'the conversation owner' };
  }
  return { type: 'owner', id: null, label: 'a person' };
}

async function nameOf(pc: ReturnType<typeof pkgConn>, id: string, object: 'User' | 'Group'): Promise<string | null> {
  try {
    const r = await pc.query<{ Name: string }>(`SELECT Name FROM ${object} WHERE Id = '${id}' LIMIT 1`);
    return r.records[0]?.Name ?? null;
  } catch {
    return null;
  }
}

async function handOff(ctx: HandoffContext, cfg: HandoffConfig, reason: string): Promise<string> {
  try {
    const pc = pkgConn(await getOrgConnection(ctx.orgId));
    const sid = ctx.sessionId.replace(/[^A-Za-z0-9]/g, '');
    if (!SAFE_ID.test(sid)) return 'Error: this conversation has no record to hand off; tell the customer a colleague will follow up.';
    const rows = await pc.query<SessionRow>(
      `SELECT Id, Status__c, OwnerId, User__c, RecordContextId__c, RecordContextType__c, Channel__c FROM ChatSession__c WHERE Id = '${sid}' LIMIT 1`,
    );
    const session = rows.records[0];
    if (!session) return 'Error: this conversation has no record to hand off; tell the customer a colleague will follow up.';
    const line = cfg.customerLineOnHandoff?.trim() || DEFAULT_HANDOFF_LINE;
    if (session.Status__c === 'Handed off') {
      return `ALREADY HANDED OFF. A person has this conversation. Reply with exactly: "${line}" and nothing else.`;
    }

    const who = await resolveAssignee(pc, cfg, session);
    const hours = cfg.returnAfterHours && cfg.returnAfterHours > 0 ? Math.round(cfg.returnAfterHours) : DEFAULT_QUIET_HOURS;
    const notify = [cfg.notifyNotification !== false ? 'notification' : null, cfg.notifyEmail !== false ? 'email' : null].filter(Boolean).join(',');
    const now = new Date();
    const patch: Record<string, unknown> = {
      Id: session.Id,
      Status__c: 'Handed off',
      HandoffReason__c: reason.slice(0, 255),
      HandedOffAt__c: now.toISOString(),
      HandoffReturnAt__c: new Date(now.getTime() + hours * 3_600_000).toISOString(),
      HandoffReturnHours__c: hours,
      HandoffAssigneeType__c: who.type,
      HandoffAssigneeId__c: who.id,
      HandoffAssigneeLabel__c: who.label.slice(0, 255),
      HandoffPreviousOwner__c: session.OwnerId,
      HandoffNotify__c: notify || 'notification',
      HandoffReturnLine__c: (cfg.customerLineOnReturn ?? DEFAULT_RETURN_LINE).slice(0, 255),
    };

    // Who owns the record while a person has it. A queue (Omni-Channel or
    // not) and a named user take the conversation itself, unless the node
    // routes the related Lead or Case instead.
    const newOwner = (who.type === 'queue' || who.type === 'omni' || who.type === 'user') && who.id ? who.id : null;
    let routedRelated = false;
    if (newOwner && cfg.routeRelated && session.RecordContextId__c && session.RecordContextType__c && SAFE_NAME.test(session.RecordContextType__c)) {
      try {
        await pc.sobject(session.RecordContextType__c).update({ Id: session.RecordContextId__c, OwnerId: newOwner });
        routedRelated = true;
      } catch (err) {
        logger.warn({ orgId: ctx.orgId, err: err instanceof Error ? err.message : String(err) }, 'handoff_related_owner_failed');
      }
    }
    if (newOwner && !routedRelated) {
      try {
        await pc.sobject('ChatSession__c').update({ ...patch, OwnerId: newOwner });
      } catch (err) {
        // A queue that is not set up for this object refuses to own it;
        // the handoff still happens, the trigger still tells the people.
        logger.warn({ orgId: ctx.orgId, err: err instanceof Error ? err.message : String(err) }, 'handoff_owner_change_failed');
        await pc.sobject('ChatSession__c').update(patch);
      }
    } else {
      await pc.sobject('ChatSession__c').update(patch);
    }
    logger.info({ orgId: ctx.orgId, sessionId: session.Id, who: who.type, assignee: who.id, hours }, 'conversation_handed_off');
    return (
      `HANDED OFF to ${who.label}. Reply to the customer with exactly this line and nothing else: "${line}". ` +
      'From now on the conversation is with a person; do not call any other tool and do not continue the conversation yourself.'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ orgId: ctx.orgId, sessionId: ctx.sessionId, err: msg }, 'handoff_failed');
    return `Error: could not hand off (${msg.slice(0, 200)}). Tell the customer a colleague will follow up and carry on helping as best you can.`;
  }
}
