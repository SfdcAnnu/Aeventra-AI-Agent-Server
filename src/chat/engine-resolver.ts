/**
 * Engine credential resolver.
 *
 * The runtime chat/flow payload from Apex includes an optional
 * `engineOverride: { engineType, apiKey, endpoint, defaultModel, connectionId }`
 * resolved from the running user's or org's AiEngineConnection__c records.
 *
 * There is deliberately NO server-side .env fallback: every org brings and
 * pays for its own AI provider key. Falling back to a shared server key
 * would mean every customer's agent traffic silently runs through — and
 * bills to — the same provider account, which is both a tenancy leak and
 * a cost/compliance problem for a multi-tenant product. If no connection
 * is configured, this throws — the customer must add one under AI Engine
 * Setup, there is no implicit default.
 *
 * We NEVER persist the key in Node — it's used per-request and dropped.
 * Apex is the source of truth; Node is stateless for credentials.
 */

export interface EngineOverride {
  engineType?:   string | null;
  apiKey?:       string | null;
  endpoint?:     string | null;
  defaultModel?: string | null;
  connectionId?: string | null;
}

export interface ResolvedEngineCredentials {
  apiKey:       string;
  endpoint:     string | null;
  defaultModel: string | null;
  source:       'user';
  connectionId: string | null;
}

/**
 * Resolve credentials for a specific engine from the Apex-supplied override.
 * Throws if none is configured — see module docblock for why there is no
 * .env fallback.
 */
export function resolveEngine(
  engineType: 'claude' | 'openai' | 'gemini',
  override?:  EngineOverride | null,
): ResolvedEngineCredentials {
  if (override && override.engineType === engineType && override.apiKey) {
    return {
      apiKey:       override.apiKey,
      endpoint:     override.endpoint ?? null,
      defaultModel: override.defaultModel ?? null,
      source:       'user',
      connectionId: override.connectionId ?? null,
    };
  }

  throw new Error(
    `No AI Engine Connection configured for ${engineType}. Add one under AI Engine Setup and bind it to this agent's AI node — there is no default/shared key.`,
  );
}
