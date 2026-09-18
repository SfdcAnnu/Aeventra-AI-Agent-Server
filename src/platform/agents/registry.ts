/**
 * Every agent the platform ships, by API name. The route that syncs them
 * and the cache that lazily creates them on first use both read this —
 * one list, so an agent cannot be syncable but not loadable.
 */
import type { SystemAgentSpec } from '../system-agents';
import { metadataSmokeAgent } from './metadata-smoke';
import { archonCopilotAgent } from './archon-copilot';
import { metadataExpertAgent } from './metadata-expert';

export const SYSTEM_AGENTS: Record<string, SystemAgentSpec> = {
  [archonCopilotAgent.apiName]: archonCopilotAgent,
  [metadataExpertAgent.apiName]: metadataExpertAgent,
  [metadataSmokeAgent.apiName]: metadataSmokeAgent,
};

export function systemAgentSpec(apiName: string): SystemAgentSpec | undefined {
  return SYSTEM_AGENTS[apiName];
}
