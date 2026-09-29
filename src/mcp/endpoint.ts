/**
 * Where a connector's MCP endpoint is.
 *
 * Archon's own servers are catalogued by origin (https://x.onrender.com)
 * and serve /mcp, a public /tools catalog and /health. A provider-hosted
 * server — Google's https://drivemcp.googleapis.com/mcp/v1 — is catalogued
 * by its full endpoint: nothing is appended to it, it has no public
 * catalog to read tool names from, and nothing of ours needs waking.
 */
export function isHostedEndpoint(base: string): boolean {
  try {
    return new URL(base).pathname.replace(/\/+$/, '') !== '';
  } catch {
    return false;
  }
}

/** The URL to POST MCP requests to. */
export function mcpEndpoint(base: string): string {
  const b = base.replace(/\/+$/, '');
  return isHostedEndpoint(b) ? b : `${b}/mcp`;
}
