/**
 * Specialist execution for the Agent Architect — dogfooding in the
 * literal sense: the Architect's own definition IS architect.agentspec.json,
 * and each specialist call executes that spec's node (its instructions,
 * tier, style, effort) with the platform's model factory.
 *
 * Isolation guarantees enforced STRUCTURALLY here:
 *   - every specialist runs with exactly the input the caller hands it —
 *     there is no shared conversation state to leak through;
 *   - the Test Designer's input type simply has no field for the spec;
 *   - no specialist receives a tool that writes anything. The only writer
 *     in the whole system is the compiler, invoked by the job engine.
 *
 * Credential policy: unchanged from chat — keys come from the ORG'S OWN
 * AiEngineConnection__c records (the same records Apex reads per turn),
 * never from server env.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import { logger } from '../logger';
import { buildChatModel } from '../lc/models';
import { messageText } from '../lc/message-text';
import { tierOfModel, ENGINE_DEFAULT_MODELS } from './compiler';
import type { AgentSpec, SpecNode } from './spec';

// ── Static assets (cached — byte-identical on every call) ────────────
const ROOT = () => join(process.cwd(), 'architect');

let architectSpecCache: AgentSpec | null = null;
export function loadArchitectSpec(): AgentSpec {
  if (!architectSpecCache) {
    architectSpecCache = JSON.parse(readFileSync(join(ROOT(), 'schemas', 'architect.agentspec.json'), 'utf8')) as AgentSpec;
  }
  return architectSpecCache;
}

const assetCache = new Map<string, string>();
function asset(kind: 'schema' | 'rules' | 'patterns' | 'taxonomy'): string {
  if (!assetCache.has(kind)) {
    const file =
      kind === 'schema'
        ? join(ROOT(), 'schemas', 'agent-spec.schema.json')
        : join(
            ROOT(),
            'knowledge',
            kind === 'rules' ? 'platform-rules.md' : kind === 'patterns' ? 'pattern-library.md' : 'test-taxonomy.md',
          );
    const body = readFileSync(file, 'utf8');
    assetCache.set(
      kind,
      kind === 'schema' ? '## The AgentSpec schema — the only thing a design may emit\n```json\n' + body + '\n```' : body,
    );
  }
  return assetCache.get(kind)!;
}

/**
 * Which static knowledge each specialist actually needs.
 *
 * Sending all of it to all of them was ~12k tokens PER CALL — live-measured
 * at over a dollar for one build, much of it paying to show the Requirements
 * Analyst a JSON schema it never emits. Scoped per role, the same build
 * carries a fraction of that, and each specialist's prefix stays
 * byte-identical so provider prefix-caching still applies.
 */
const KNOWLEDGE_FOR: Record<string, Array<'schema' | 'rules' | 'patterns' | 'taxonomy'>> = {
  architect: ['rules'],
  analyse_requirement: [],
  survey_org: [],
  match_capabilities: ['rules'],
  design_flow: ['schema', 'rules', 'patterns'],
  write_prompts: ['schema', 'rules'],
  report_gaps: ['rules'],
  plan_change: ['schema', 'rules'],
  design_tests: ['taxonomy'],
  run_tests: [],
  evaluate: ['taxonomy', 'rules'],
  build_report: [],
};

export function loadKnowledgeFor(specialistId: string): string {
  const kinds = KNOWLEDGE_FOR[specialistId] ?? ['rules'];
  return kinds.map(asset).join('\n\n');
}

// ── Engine resolution from the org's own connection records ──────────
export interface ArchitectEngine {
  nodeSubType: string; // canvas vocabulary for buildChatModel
  /** Resolver vocabulary ('openai' | 'claude' | 'gemini'). resolveEngine
   *  only honours an override whose engineType MATCHES the engine it is
   *  resolving — omitting this is why a build failed at the first call
   *  with "No AI Engine Connection configured". */
  engineType: 'openai' | 'claude' | 'gemini';
  apiKey: string;
  endpoint: string | null;
  models: string[]; // this provider's usable models
}

const SUBTYPE_FOR_ENGINE: Record<string, string> = { claude: 'claude', openai: 'gpt4', gemini: 'gemini' };

export async function resolveArchitectEngine(conn: Connection): Promise<ArchitectEngine> {
  const res = await conn.query<{
    EngineType__c: string;
    ApiKey__c?: string;
    Endpoint__c?: string;
    DefaultModel__c?: string;
    AvailableModelsJson__c?: string;
    IsPreferred__c?: boolean;
    ValidationStatus__c?: string;
  }>(
    'SELECT EngineType__c, ApiKey__c, Endpoint__c, DefaultModel__c, AvailableModelsJson__c, IsPreferred__c, ValidationStatus__c ' +
      'FROM AiEngineConnection__c WHERE IsActive__c = true',
  );
  const usable = res.records.filter(r => r.ApiKey__c);
  if (usable.length === 0) {
    throw new Error('No active AI connection with a key — connect a provider on the AI Models page first.');
  }
  const pick =
    usable.find(r => r.IsPreferred__c && r.ValidationStatus__c === 'Success') ??
    usable.find(r => r.ValidationStatus__c === 'Success') ??
    usable[0];

  let models: string[] = [];
  if (pick.AvailableModelsJson__c) {
    try {
      const parsed = JSON.parse(pick.AvailableModelsJson__c) as Array<string | { id?: string }>;
      models = parsed.map(m => (typeof m === 'string' ? m : m?.id)).filter((m): m is string => !!m);
    } catch {
      /* fall through to defaults */
    }
  }
  if (models.length === 0) models = ENGINE_DEFAULT_MODELS[pick.EngineType__c] ?? [];
  if (pick.DefaultModel__c && !models.includes(pick.DefaultModel__c)) models.unshift(pick.DefaultModel__c);
  if (models.length === 0) throw new Error(`The ${pick.EngineType__c} connection has no usable models.`);

  const engineType = (['openai', 'claude', 'gemini'].includes(pick.EngineType__c)
    ? pick.EngineType__c
    : 'openai') as 'openai' | 'claude' | 'gemini';
  return {
    nodeSubType: SUBTYPE_FOR_ENGINE[pick.EngineType__c] ?? 'claude',
    engineType,
    apiKey: pick.ApiKey__c!,
    endpoint: pick.Endpoint__c ?? null,
    models,
  };
}

/** tier → the provider's best matching model. */
export function modelForTier(engine: ArchitectEngine, tier: 'small' | 'medium' | 'large'): string {
  const byTier: Record<string, string[]> = { small: [], medium: [], large: [] };
  for (const m of engine.models) byTier[tierOfModel(m)].push(m);
  const order: Record<string, Array<'small' | 'medium' | 'large'>> = {
    small: ['small', 'medium', 'large'],
    medium: ['medium', 'large', 'small'],
    large: ['large', 'medium', 'small'],
  };
  for (const t of order[tier]) if (byTier[t].length) return byTier[t][0];
  return engine.models[0];
}

// Rough $ accounting per tier. The FALLBACK, for a model id nothing here
// recognises — see priceFor below.
const TIER_USD_PER_MTOK = {
  large: { in: 15, out: 75 },
  medium: { in: 3, out: 15 },
  small: { in: 0.8, out: 4 },
} as const;

/**
 * THE CEILING IS IN DOLLARS, SO THE ARITHMETIC HAS TO BE TOO.
 *
 * Cost was read from the TIER, not from the model that ran, which made a
 * $4.00 stop mean different things in different orgs. An org on Haiku was
 * billed at the large-tier rate and stopped at roughly a quarter of the
 * spend it had authorised; an org on a reasoning model overshot before the
 * counter noticed. Live: a build capped at $0.95 stopped at $1.35.
 *
 * Prefixes, not exact ids: providers version model names constantly
 * (-20250219, -latest, -v2) and an exact-match table is stale the week
 * after it is written. Longest prefix wins, so a specific entry beats a
 * family one. USD per million tokens.
 */
const MODEL_USD_PER_MTOK: Array<{ prefix: string; in: number; out: number }> = [
  { prefix: 'claude-opus-4',    in: 15,   out: 75 },
  { prefix: 'claude-opus',      in: 15,   out: 75 },
  { prefix: 'claude-sonnet',    in: 3,    out: 15 },
  { prefix: 'claude-3-7-sonnet', in: 3,   out: 15 },
  { prefix: 'claude-3-5-sonnet', in: 3,   out: 15 },
  { prefix: 'claude-haiku',     in: 0.8,  out: 4 },
  { prefix: 'claude-3-5-haiku', in: 0.8,  out: 4 },
  { prefix: 'gpt-5-mini',       in: 0.25, out: 2 },
  { prefix: 'gpt-5-nano',       in: 0.05, out: 0.4 },
  { prefix: 'gpt-5',            in: 1.25, out: 10 },
  { prefix: 'gpt-4.1-mini',     in: 0.4,  out: 1.6 },
  { prefix: 'gpt-4.1-nano',     in: 0.1,  out: 0.4 },
  { prefix: 'gpt-4.1',          in: 2,    out: 8 },
  { prefix: 'gpt-4o-mini',      in: 0.15, out: 0.6 },
  { prefix: 'gpt-4o',           in: 2.5,  out: 10 },
  { prefix: 'o4-mini',          in: 1.1,  out: 4.4 },
  { prefix: 'o3-mini',          in: 1.1,  out: 4.4 },
  { prefix: 'o3',               in: 2,    out: 8 },
  { prefix: 'gemini-2.5-pro',   in: 1.25, out: 10 },
  { prefix: 'gemini-2.5-flash', in: 0.3,  out: 2.5 },
  { prefix: 'gemini-2.0-flash', in: 0.1,  out: 0.4 },
  { prefix: 'gemini',           in: 0.3,  out: 2.5 },
];

/** What this call actually costs per million tokens. */
export function priceFor(modelId: string | undefined, tier: keyof typeof TIER_USD_PER_MTOK): { in: number; out: number } {
  const id = (modelId ?? '').toLowerCase();
  let best: { prefix: string; in: number; out: number } | undefined;
  for (const row of MODEL_USD_PER_MTOK) {
    if (id.startsWith(row.prefix) && (!best || row.prefix.length > best.prefix.length)) best = row;
  }
  // An unknown id falls back to the tier rather than to zero: a model we
  // cannot price must never look free, or the ceiling stops governing.
  return best ? { in: best.in, out: best.out } : TIER_USD_PER_MTOK[tier];
}

export interface SpecialistUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Wall time of the model call. */
  ms: number;
}

/** A specialist that answered badly, or not at all. Carries what the
 *  failed call cost and took, so a build can record a call that produced
 *  nothing instead of losing it: the empty first answer of a reasoning
 *  model was never accounted for, and a stage that paid twice showed one
 *  call. */
export class SpecialistError extends Error {
  usage?: SpecialistUsage;
  model?: string;
}

/**
 * How much room a reasoning model gets to think, on top of the answer, on
 * the Architect's own calls.
 *
 * The runtime default for 'low' is 4,000 tokens. The Capability Matcher
 * reads a 15k-token inventory and reasons through it action by action
 * before writing; on gpt-5.5 that thinking alone passed 4,000, the answer
 * never started, and every build paid for the empty call AND the wider
 * retry — the recorded cost of that stage ($0.26) is only explained by
 * the retry's full allowance. One build's matcher ran past 150 s that way.
 * Room proportionate to the task means one call.
 */
const ARCHITECT_HEADROOM: Record<'minimal' | 'low' | 'medium' | 'high', number> = {
  minimal: 2_000,
  low: 12_000,
  medium: 16_000,
  high: 24_000,
};

/**
 * Run ONE specialist from the architect spec. `input` is everything the
 * specialist sees beyond its instructions and the static knowledge prefix
 * — isolated context by construction. When the node declares a `returns`
 * schema the model is bound to it (structured output) and the parsed
 * object is returned; otherwise the raw text is.
 */
export async function callSpecialist<T = unknown>(opts: {
  specialistId: string;
  input: Record<string, unknown>;
  engine: ArchitectEngine;
  includeKnowledge?: boolean;
  maxOutputTokens?: number;
  /** Parse a fenced/free JSON object from plain text instead of binding
   *  the node's returns schema — for specialists whose output IS a whole
   *  AgentSpec (structured-output binding to a loose schema is unreliable
   *  across providers). */
  rawJson?: boolean;
  /** Replace the node's instructions. Interactive surfaces (the copilot,
   *  the prompt rewriter) borrow a specialist's machinery — tier, model,
   *  cost accounting — but do a different job, and a borrowed role makes
   *  a model answer the wrong question. */
  instructionsOverride?: string;
  /** Run this call on a cheaper tier than the node declares. */
  tierOverride?: 'small' | 'medium' | 'large';
  /** Think less (or more) than the node declares, for THIS call: a patch
   *  to a design that already exists is mechanical work, and paying the
   *  designer's full reasoning to re-emit a JSON object is where a failed
   *  build's money went. */
  effortOverride?: 'minimal' | 'low' | 'medium' | 'high';
  /** Bind THIS schema instead of the node's own `returns`. Asking for a
   *  shape in prose is advice; binding a schema is a contract — the
   *  copilot kept omitting its operations array until this existed. */
  schemaOverride?: Record<string, unknown>;
}): Promise<{ result: T; usage: SpecialistUsage; model: string }> {
  const spec = loadArchitectSpec();
  const node = spec.nodes.find(n => n.id === opts.specialistId);
  if (!node || (node.type !== 'subagent' && node.type !== 'agent')) {
    throw new SpecialistError(`Unknown specialist '${opts.specialistId}'.`);
  }

  const tier = (opts.tierOverride ?? node.model?.tier ?? 'large') as 'small' | 'medium' | 'large';
  const modelId = modelForTier(opts.engine, tier);
  const maxTokens = opts.maxOutputTokens ?? node.model?.maxOutputTokens ?? 4096;

  // The spec's own effort setting maps onto how long a reasoning model may
  // think. 'deep' is deliberate and expensive; everything else stays lean.
  // Deliberately capped at 'medium': on a reasoning model, 'high' spent
  // minutes and dollars thinking before writing anything, for a build the
  // estimator and schema validate anyway. The gates catch bad designs far
  // more cheaply than rumination prevents them.
  const EFFORT: Record<string, 'minimal' | 'low' | 'medium' | 'high'> = {
    off: 'minimal',
    standard: 'low',
    deep: 'medium',
  };
  const effort = opts.effortOverride ?? EFFORT[node.model?.effort ?? 'standard'] ?? 'low';
  const { model } = buildChatModel(
    opts.engine.nodeSubType,
    modelId,
    {
      engineType: opts.engine.engineType,
      apiKey: opts.engine.apiKey,
      endpoint: opts.engine.endpoint,
      defaultModel: modelId,
      connectionId: null,
    },
    maxTokens,
    {
      jsonMode: opts.rawJson === true,
      reasoningEffort: effort,
      reasoningHeadroom: ARCHITECT_HEADROOM[effort],
    },
  );

  // Knowledge FIRST and byte-identical per specialist: it is the cacheable
  // prefix, and anything volatile above it would destroy the discount.
  const knowledge = opts.includeKnowledge === false ? '' : loadKnowledgeFor(node.id);
  const roleText = opts.instructionsOverride ?? node.instructions ?? '';
  const system = (knowledge ? knowledge + '\n\n' : '') + `## Your role\n${roleText}`;
  const user = JSON.stringify(opts.input, null, 1);

  const t0 = Date.now();
  const CALL_TIMEOUT_MS = Number(process.env.ARCHITECT_CALL_TIMEOUT_MS) > 0
    ? Number(process.env.ARCHITECT_CALL_TIMEOUT_MS) : 150_000;
  const deadline = <R>(p: Promise<R>): Promise<R> =>
    Promise.race([
      p,
      new Promise<R>((_, reject) =>
        setTimeout(
          () => reject(new SpecialistError(`'${node.label}' took longer than ${Math.round(CALL_TIMEOUT_MS / 1000)}s and was stopped.`)),
          CALL_TIMEOUT_MS,
        ),
      ),
    ]);
  let tokensIn = 0;
  let tokensOut = 0;
  let result: unknown;

  const rate = priceFor(modelId, tier);
  const usageNow = (): SpecialistUsage => ({
    tokensIn, tokensOut, costUsd: (tokensIn * rate.in + tokensOut * rate.out) / 1e6, ms: Date.now() - t0,
  });
  const failed = (message: string): SpecialistError => {
    const e = new SpecialistError(message);
    e.usage = usageNow();
    e.model = modelId;
    return e;
  };

  const boundSchema = opts.schemaOverride ?? (opts.rawJson ? null : node.returns);
  if (boundSchema) {
    const bound = (model as unknown as {
      withStructuredOutput: (schema: Record<string, unknown>, cfg?: { name?: string; includeRaw?: boolean; strict?: boolean }) => {
        invoke: (msgs: Array<[string, string]>) => Promise<{ raw?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } }; parsed?: unknown } | unknown>;
      };
      // STRICT MUST BE SAID OUT LOUD, because the two OpenAI endpoints
      // disagree about the default. Chat Completions leaves strict schema
      // adherence OFF; the Responses API turns it ON. LangChain sends the
      // flag only when it is set, so the same schema silently became strict
      // the day gpt-5 routing moved to the Responses API — and strict
      // demands `additionalProperties: false` on every object AND every
      // property listed in `required`, which these schemas do not do.
      //
      // Live failure: "'additionalProperties' is required to be supplied
      // and to be false", rejected before the model ran, at whichever stage
      // first used a large-tier (gpt-5) model. Retrying could never help.
      //
      // Saying false keeps one behaviour on both endpoints. Optional fields
      // stay optional, which is what these schemas mean.
    }).withStructuredOutput({ ...boundSchema, title: node.id }, { name: node.id, includeRaw: true, strict: false });
    const out = (await deadline(bound.invoke([
      ['system', system],
      ['human', user],
    ]))) as { raw?: { content?: unknown; usage_metadata?: { input_tokens?: number; output_tokens?: number } }; parsed?: unknown };
    result = recoverStructured(out.parsed, out.raw?.content, node.label);
    tokensIn = out.raw?.usage_metadata?.input_tokens ?? 0;
    tokensOut = out.raw?.usage_metadata?.output_tokens ?? 0;
    if (result == null) throw failed(`'${node.label}' returned nothing parseable against its schema.`);
  } else {
    const sys = opts.rawJson
      ? system + '\n\nRespond with ONE JSON object and nothing else — no prose, no code fences.'
      : system;
    const out = await deadline(
      model.invoke([
        ['system', sys],
        ['human', user],
      ]),
    );
    const meta = (out as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
    tokensIn = meta?.input_tokens ?? 0;
    tokensOut = meta?.output_tokens ?? 0;
    // NOT JSON.stringify(out.content). On the Responses API content is an
    // array of blocks, and stringifying the array hands the parser the
    // envelope instead of the answer — see lc/message-text.ts.
    const text = messageText(out.content);
    try {
      result = opts.rawJson ? parseLooseJson(text, node.label) : text;
    } catch (err) {
      throw err instanceof SpecialistError ? failed(err.message) : err;
    }
  }

  const usage = usageNow();
  logger.info(
    { specialist: node.id, model: modelId, tier, effort, tokensIn, tokensOut, costUsd: Number(usage.costUsd.toFixed(4)), ms: usage.ms },
    'architect_specialist_call',
  );
  return { result: result as T, usage, model: modelId };
}

/**
 * THE RESPONSES API HANDS BACK CONTENT BLOCKS, AND THE PARSER KEPT THE BOX.
 *
 * On gpt-5.5 (the Responses API path) `withStructuredOutput` returned, as
 * `parsed`, the message's content-block array coerced into an object:
 * `{"0": {"type": "text", "text": "{...the real answer...}"}}`. Every
 * specialist bound to a `returns` schema read that box as its answer. The
 * Evaluator's verdict became "unclear" while the text inside said `fail`
 * with fifteen uncovered requirements; the Capability Matcher's matched,
 * partial and missing lists were all undefined, which counted as "full
 * coverage". Two measured builds shipped agents their own reviewer had
 * rejected.
 *
 * When the parsed value is that box, the answer is the JSON in its text.
 */
export function recoverStructured(parsed: unknown, rawContent: unknown, label: string): unknown {
  if (!isContentBox(parsed)) return parsed;
  const blocks = Array.isArray(parsed) ? parsed : Object.values(parsed as Record<string, unknown>);
  const text = messageText(blocks);
  return parseLooseJson(text, label);
}

function isContentBox(v: unknown): boolean {
  // The array itself, or the array spread into an object ({"0": block}).
  const blocks: unknown[] | null = Array.isArray(v)
    ? v
    : v && typeof v === 'object' && Object.keys(v as object).length > 0 && Object.keys(v as object).every(k => /^\d+$/.test(k))
      ? Object.values(v as Record<string, unknown>)
      : null;
  if (!blocks || blocks.length === 0) return false;
  const first = blocks[0] as { type?: unknown; text?: unknown } | undefined;
  return !!first && typeof first === 'object' && first.type === 'text' && typeof first.text === 'string';
}

/** Extract the one JSON object from model text — tolerant of code fences
 *  and stray prose, strict about producing a real object. */
function parseLooseJson(text: string, label: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) {
    const seen = text.trim().length === 0 ? '(nothing at all)' : `"${text.trim().slice(0, 200)}"`;
    throw new SpecialistError(`'${label}' did not return a JSON object — it returned ${seen}.`);
  }
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch (e) {
    throw new SpecialistError(`'${label}' returned unparseable JSON: ${e instanceof Error ? e.message : e}`);
  }
}
