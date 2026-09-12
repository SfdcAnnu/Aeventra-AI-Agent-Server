/**
 * prompt-parts — split a composed system prompt back into the blocks it
 * was assembled from, so the console can show what actually filled the
 * context window.
 *
 * A request body is one enormous escaped string. Reading it tells you
 * almost nothing: you cannot see that the tool schemas are half the
 * prompt, or which knowledge-base passage the agent was actually handed.
 * Splitting it turns "15,000 tokens" into an answer.
 *
 * Deliberately a PARSER, not a change to how prompts are built. The
 * markers below are the platform's own section headers (chat/adapters/
 * shared.ts, chat/memory.ts, chat/record-context.ts) — recognising them
 * here keeps the prompt builder untouched, so nothing about how an agent
 * behaves depends on tracing being on.
 */
import type { BaseMessage } from '@langchain/core/messages';

export type PartKind =
  | 'instructions' | 'mechanics' | 'clock' | 'kb' | 'record'
  | 'memory' | 'tools' | 'history' | 'user';

export interface PromptPart {
  kind: PartKind;
  label: string;
  chars: number;
  /** Rough token estimate. Four characters per token is close enough to
   *  rank blocks by weight, which is all this is used for. */
  tokens: number;
  text?: string;
  /** kb only — each retrieved passage with the document it came from. */
  passages?: Array<{ doc: string; text: string }>;
  /** tools only. */
  tools?: string[];
}

const est = (s: string): number => Math.round(s.length / 4);

/** Section headers the platform writes. Order matters: the prompt is cut
 *  at whichever marker appears first from each position. */
const MARKERS: Array<{ re: RegExp; kind: PartKind; label: string }> = [
  { re: /^Current date and time \(UTC\):/m, kind: 'clock', label: 'Current date and time' },
  { re: /^KNOWLEDGE BASE \(/m, kind: 'kb', label: 'Knowledge base' },
  { re: /^THE [A-Z0-9_]+ THIS CONVERSATION IS ABOUT/m, kind: 'record', label: 'Record context' },
  { re: /^SESSION FACTS \(/m, kind: 'memory', label: 'Session memory' },
  { re: /^CONVERSATION SO FAR \(/m, kind: 'memory', label: 'Session memory' },
  { re: /^This conversation is anchored to the /m, kind: 'record', label: 'Record anchor' },
  { re: /^You have access to the tools connected to this agent\./m, kind: 'mechanics', label: 'Runtime mechanics' },
  { re: /^CRITICAL — never end your turn/m, kind: 'mechanics', label: 'Runtime mechanics' },
];

/** Split the KB block into its numbered passages: `[1] (from "Doc")\n…`. */
function parseKbPassages(block: string): Array<{ doc: string; text: string }> {
  const out: Array<{ doc: string; text: string }> = [];
  const re = /\[(\d+)\]\s*\(from "([^"]*)"\)\n([\s\S]*?)(?=\n---\n\n|\n\[\d+\]\s*\(from "|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push({ doc: m[2], text: m[3].trim() });
  return out;
}

/** Break a composed system message into its parts, in prompt order. */
export function splitSystemPrompt(system: string): PromptPart[] {
  // Find every marker's position, then cut between consecutive ones.
  const hits = MARKERS
    .map(m => { const r = m.re.exec(system); return r ? { at: r.index, ...m } : null; })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.at - b.at);

  const parts: PromptPart[] = [];
  const push = (kind: PartKind, label: string, text: string) => {
    const t = text.trim();
    if (!t) return;
    const part: PromptPart = { kind, label, chars: t.length, tokens: est(t), text: t };
    if (kind === 'kb') {
      const passages = parseKbPassages(t);
      if (passages.length > 0) { part.passages = passages; delete part.text; }
    }
    parts.push(part);
  };

  // Everything before the first marker is the agent's own instructions —
  // the part that is stable and therefore cacheable.
  push('instructions', 'Agent instructions', system.slice(0, hits[0]?.at ?? system.length));
  hits.forEach((h, i) => push(h.kind, h.label, system.slice(h.at, hits[i + 1]?.at ?? system.length)));
  return parts;
}

/**
 * The whole request as parts: the system prompt broken up, plus the tool
 * schemas, the replayed history and the live user message — the four
 * things that actually compete for the context window.
 */
export function describeRequest(messages: BaseMessage[], params: Record<string, unknown>): PromptPart[] {
  const asText = (c: unknown): string =>
    typeof c === 'string' ? c
      : Array.isArray(c) ? c.map(b => (b as { text?: string })?.text ?? '').join('\n')
      : '';

  const parts: PromptPart[] = [];
  const system = messages.filter(m => m.getType() === 'system').map(m => asText(m.content)).join('\n\n');
  if (system) parts.push(...splitSystemPrompt(system));

  // Tools are re-sent in full on EVERY model call, which is usually the
  // single heaviest block and the least obvious one.
  const tools = params.tools as Array<{ function?: { name?: string }; name?: string }> | undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    const json = JSON.stringify(tools);
    parts.push({
      kind: 'tools', label: 'Tools bound', chars: json.length, tokens: est(json),
      tools: tools.map(t => t.function?.name ?? t.name ?? 'tool').filter(Boolean) as string[],
    });
  }

  const conversation = messages.filter(m => m.getType() !== 'system');
  const last = conversation[conversation.length - 1];
  const earlier = conversation.slice(0, -1);

  if (earlier.length > 0) {
    const text = earlier.map(m => `[${m.getType()}] ${asText(m.content).slice(0, 600)}`).join('\n\n');
    parts.push({
      kind: 'history', label: `Conversation history (${earlier.length} messages)`,
      chars: text.length, tokens: est(text), text,
    });
  }
  if (last) {
    const text = asText(last.content);
    parts.push({ kind: 'user', label: 'Latest message', chars: text.length, tokens: est(text), text });
  }
  return parts;
}

/**
 * Messages as they go ON THE WIRE, not as LangChain holds them.
 *
 * A BaseMessage is a Serializable: it keeps `lc_kwargs`, a copy of the
 * arguments it was constructed with, alongside the resolved fields. Dump
 * the object and every prompt appears TWICE — once as `content`, once
 * inside `lc_kwargs` — with `lc_namespace` and circular `additional_kwargs`
 * around it. That doubles what a trace stores, wastes the payload budget,
 * and makes the raw view unreadable while showing something the provider
 * never received.
 *
 * This maps each message to the shape the API actually gets, so the raw
 * view is both smaller and truer.
 */
export function toWireMessages(messages: BaseMessage[]): Array<Record<string, unknown>> {
  const ROLE: Record<string, string> = {
    system: 'system', human: 'user', ai: 'assistant', tool: 'tool', function: 'function',
  };
  return messages.map(m => {
    const type = m.getType();
    const out: Record<string, unknown> = {
      role: ROLE[type] ?? type,
      content: typeof m.content === 'string' ? m.content : m.content,
    };
    const calls = (m as { tool_calls?: Array<{ id?: string; name: string; args: unknown }> }).tool_calls;
    if (calls?.length) {
      out.tool_calls = calls.map(c => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      }));
    }
    const toolCallId = (m as { tool_call_id?: string }).tool_call_id;
    if (toolCallId) out.tool_call_id = toolCallId;
    const name = (m as { name?: string }).name;
    if (name) out.name = name;
    return out;
  });
}
