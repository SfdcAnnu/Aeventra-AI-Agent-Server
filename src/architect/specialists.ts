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

// Rough $ accounting per tier (same placeholder rates as the estimator).
const TIER_USD_PER_MTOK = {
  large: { in: 15, out: 75 },
  medium: { in: 3, out: 15 },
  small: { in: 0.8, out: 4 },
} as const;

export interface SpecialistUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export class SpecialistError extends Error {}

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
      reasoningEffort: EFFORT[node.model?.effort ?? 'standard'] ?? 'low',
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

  if (node.returns && !opts.rawJson) {
    const bound = (model as unknown as {
      withStructuredOutput: (schema: Record<string, unknown>, cfg?: { name?: string; includeRaw?: boolean }) => {
        invoke: (msgs: Array<[string, string]>) => Promise<{ raw?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } }; parsed?: unknown } | unknown>;
      };
    }).withStructuredOutput({ ...node.returns, title: node.id }, { name: node.id, includeRaw: true });
    const out = (await deadline(bound.invoke([
      ['system', system],
      ['human', user],
    ]))) as { raw?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } }; parsed?: unknown };
    result = out.parsed;
    tokensIn = out.raw?.usage_metadata?.input_tokens ?? 0;
    tokensOut = out.raw?.usage_metadata?.output_tokens ?? 0;
    if (result == null) throw new SpecialistError(`'${node.label}' returned nothing parseable against its schema.`);
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
    const text = typeof out.content === 'string' ? out.content : JSON.stringify(out.content);
    result = opts.rawJson ? parseLooseJson(text, node.label) : text;
  }

  const rate = TIER_USD_PER_MTOK[tier];
  const costUsd = (tokensIn * rate.in + tokensOut * rate.out) / 1e6;
  logger.info(
    { specialist: node.id, model: modelId, tier, tokensIn, tokensOut, costUsd: Number(costUsd.toFixed(4)), ms: Date.now() - t0 },
    'architect_specialist_call',
  );
  return { result: result as T, usage: { tokensIn, tokensOut, costUsd }, model: modelId };
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
