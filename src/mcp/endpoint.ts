/**
 * Where a connector's MCP endpoint is.
 *
 * Archon's own servers are catalogued by origin (https://x.onrender.com)
 * and serve /mcp, a public /tools catalog and /health. A provider-hosted
 * server — Google's https://drivemcp.googleapis.com/mcp/v1 — is catalogued
 * by its full endpoint: nothing is appended to it, it has no public
 * catalog to read tool names from, and nothing of ours needs waking.
 *
 * The one base of ours that carries a path is the server's own platform
 * endpoint, http://127.0.0.1:<port>/platform (or PLATFORM_TOOLS_URL): it
 * serves /platform/mcp and /platform/tools exactly like a catalogued
 * origin does. Treating it as provider-hosted POSTed every turn to
 * /platform itself (a GET-only wake ping), so the copilot lost its tools
 * on every deployment from the day the Drive rule landed.
 */
export const PLATFORM_PATH = '/platform';

export function isHostedEndpoint(base: string): boolean {
  try {
    const path = new URL(base).pathname.replace(/\/+$/, '');
    return path !== '' && path !== PLATFORM_PATH;
  } catch {
    return false;
  }
}

/** The URL to POST MCP requests to. */
export function mcpEndpoint(base: string): string {
  const b = base.replace(/\/+$/, '');
  return isHostedEndpoint(b) ? b : `${b}/mcp`;
}
