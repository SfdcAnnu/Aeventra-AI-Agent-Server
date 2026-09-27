/**
 * FACTS ABOUT THE ORG, DECIDED IN CODE — never left to a model's guess.
 *
 * Three recurring build failures had the same shape: a model asserted
 * something about the client's org that one describe call would have
 * contradicted.
 *
 *   - The survey listed custom objects plus a fixed set of core ones, so a
 *     standard object outside that set (Asset, Entitlement, WorkOrder…)
 *     was invisible to every later stage, and the build then reported the
 *     object the requirement was about as "not available".
 *   - Setup items claimed a standard field or object was missing
 *     ("Account.Description must exist", "Asset is not queryable") and the
 *     compiler switched the tools that needed it off.
 *   - The trigger was chosen by the designer, which picked a webhook for an
 *     agent the requirement says a Flow starts.
 *
 * Each is settled here from the org's own describe results.
 */
import type { ObjectSummary } from './surveyor-tools';
import type { AgentSpec, SpecPrerequisite } from './spec';

// ── Objects the requirement names ────────────────────────────────────

/** Objects whose names add nothing when found in prose, or are never an agent's subject. */
const NOISE = /(History|Share|Feed|ChangeEvent|Tag|__mdt|__e|__x|__b)$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Singular and simple plural forms of a label ("Asset" → Asset, Assets; "Opportunity" → Opportunities). */
function labelForms(label: string): string[] {
  const l = label.trim();
  if (!l) return [];
  const plural = /y$/i.test(l) && !/[aeiou]y$/i.test(l) ? `${l.slice(0, -1)}ies` : /(s|x|ch|sh)$/i.test(l) ? `${l}es` : `${l}s`;
  return [l, plural];
}

/**
 * The org's objects that a requirement names — by API name (Asset,
 * Renewal__c) or by label, singular or plural ("Assets", "Work Orders").
 * Only queryable objects count; history, share and feed tables do not.
 */
export function mentionedObjects(objects: ObjectSummary[], text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const o of objects) {
    if (!o.queryable || NOISE.test(o.name)) continue;
    const words = new Set<string>([o.name, ...labelForms(o.label)]);
    for (const w of words) {
      if (w.length < 3) continue;
      // Whole words only, case-insensitive for labels, exact for API names with __.
      const re = w.includes('__') ? new RegExp(`\\b${escapeRe(w)}\\b`) : new RegExp(`\\b${escapeRe(w)}\\b`, 'i');
      if (re.test(text)) { found.push(o.name); break; }
    }
  }
  return found;
}

// ── Setup items checked against the org ──────────────────────────────

export interface FieldFacts { exists: boolean; updateable: boolean }
export type DescribeField = (object: string, field: string) => Promise<FieldFacts | null>;

const CLAIMS_ABSENT = /\b(not (available|enabled|queryable|accessible|creatable|createable|updat(e)?able|present|found)|missing|does ?n[o']t exist|must exist|no (access|permission|action|flow|invocable|tool|way)|(cannot|can't|can not) (be )?(query|queried|access|accessed|read|create|created|update|updated|post|posted|write|written)|unable to (query|access|read|create|update|post))\b/i;
const ABOUT_CHATTER = /\bchatter\b|\bfeed ?item\b|\bpost (to|on) the (account'?s? )?feed\b/i;

/**
 * Close any setup item the org itself contradicts. An item that says an
 * object is unavailable, when that object is queryable (and createable or
 * updateable where the item is about writing), or that a named field is
 * missing, when it exists and can be written, is marked done with the
 * check that settled it — never deleted, so the person sees why it went.
 */
export async function verifyPrerequisites(
  prereqs: SpecPrerequisite[],
  objects: ObjectSummary[],
  describeField: DescribeField,
): Promise<{ prerequisites: SpecPrerequisite[]; closed: string[] }> {
  const byName = new Map(objects.map(o => [o.name.toLowerCase(), o]));
  const closed: string[] = [];
  const out: SpecPrerequisite[] = [];

  for (const p of prereqs) {
    if (p.status === 'done' || p.status === 'waived') { out.push(p); continue; }
    const text = `${p.title} ${p.why ?? ''}`;
    if (!CLAIMS_ABSENT.test(text) || p.kind === 'connector' || p.kind === 'knowledge_base') { out.push(p); continue; }
    const writes = /\b(creat|updat|writ|post|insert)/i.test(text);

    // Object.Field references: every one must exist and be writable when the item is about writing.
    const fieldRefs = [...text.matchAll(/\b([A-Z][A-Za-z0-9_]*)\.([A-Z][A-Za-z0-9_]*)\b/g)]
      .map(m => ({ object: m[1], field: m[2] }))
      .filter(r => byName.has(r.object.toLowerCase()));
    let fieldsOk = fieldRefs.length > 0;
    const fieldNotes: string[] = [];
    for (const r of fieldRefs.slice(0, 5)) {
      const f = await describeField(byName.get(r.object.toLowerCase())!.name, r.field).catch(() => null);
      if (!f || !f.exists || (writes && !f.updateable)) { fieldsOk = false; break; }
      fieldNotes.push(`${r.object}.${r.field} exists${f.updateable ? ' and can be written' : ''}`);
    }

    // Objects named in the item: every one must be usable the way the item needs.
    const named = mentionedObjects(objects, text).map(n => byName.get(n.toLowerCase())!).filter(Boolean);
    const chatter = ABOUT_CHATTER.test(text) ? byName.get('feeditem') : undefined;
    const objs = chatter ? [...named.filter(o => o.name !== 'FeedItem'), chatter] : named;
    const objectsOk = objs.length > 0 && objs.every(o => o.queryable && (!writes || o.createable || o.updateable));

    if ((fieldRefs.length > 0 && fieldsOk) || (fieldRefs.length === 0 && objectsOk)) {
      const how = fieldRefs.length > 0
        ? fieldNotes.join('; ')
        : objs.map(o => `${o.name} is ${[o.queryable && 'queryable', o.createable && 'createable', o.updateable && 'updateable'].filter(Boolean).join(', ')}`).join('; ') +
          (chatter ? ' — a Chatter post is a FeedItem record, which the Salesforce tools create' : '');
      closed.push(`${p.id}: ${p.title}`);
      out.push({ ...p, status: 'done', blocking: false, verification: `Checked the org: ${how}.` } as SpecPrerequisite);
      continue;
    }
    out.push(p);
  }
  return { prerequisites: out, closed };
}

// ── The trigger, from how the requirement says the agent starts ──────

const STARTED_BY_SALESFORCE = /\b(flow|apex|invocable|process builder|record[- ]triggered|when (a|an|the) [a-z ]{1,30} (is )?(created|updated|changed|saved)|button|schedul(e|ed))\b/i;
const STARTED_FROM_OUTSIDE = /\b(webhook|http (call|request|post)|external system|third[- ]party system calls|api call from)\b/i;

/**
 * An automation started inside Salesforce (a Flow, Apex, a button, a
 * record change, a schedule) runs through "Run AI Agent" — trigger type
 * `manual`, which the compiler saves as the "Run from Flow or Apex"
 * trigger. Only a requirement that says an outside system calls in gets a
 * webhook. Returns a note when it changed the design's choice.
 */
export function settleTrigger(spec: AgentSpec, requirementText: string, triggerText?: string | null): string | null {
  const said = `${triggerText ?? ''} ${requirementText}`;
  if (!spec.trigger) return null;
  if (spec.trigger.type === 'webhook' && STARTED_BY_SALESFORCE.test(said) && !STARTED_FROM_OUTSIDE.test(said)) {
    spec.trigger = { ...spec.trigger, type: 'manual' };
    return 'The requirement says Salesforce starts this agent (a Flow, Apex or a record change), so it is set to run from a Flow or Apex rather than a webhook.';
  }
  return null;
}

// ── Values that must fit their field ─────────────────────────────────

/** Clip every string value to its field's length; returns the fields it shortened. */
export function fitToLengths(values: Record<string, unknown>, lengths: Map<string, number>): string[] {
  const clipped: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const max = lengths.get(k);
    if (typeof v !== 'string' || !max || max <= 0 || v.length <= max) continue;
    const cut = v.slice(0, max);
    const atWord = cut.lastIndexOf(' ');
    values[k] = max > 40 && atWord > max * 0.6 ? `${cut.slice(0, atWord).replace(/[\s,;:.–—-]+$/, '')}…`.slice(0, max) : cut;
    clipped.push(k);
  }
  return clipped;
}
