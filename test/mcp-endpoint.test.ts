import { describe, it, expect } from 'vitest';
import { isHostedEndpoint, mcpEndpoint } from '../src/mcp/endpoint';
import { KNOWN_CONNECTOR_TOOLS } from '../src/architect/connector-tools';
import { GOOGLE_SCOPES } from '../src/oauth/google';

describe('an MCP server catalogued by origin, or by its full endpoint', () => {
  it('adds /mcp to one of ours and leaves a provider-hosted endpoint alone', () => {
    expect(mcpEndpoint('https://gmail-mcp-server-baqd.onrender.com')).toBe('https://gmail-mcp-server-baqd.onrender.com/mcp');
    expect(mcpEndpoint('https://gmail-mcp-server-baqd.onrender.com/')).toBe('https://gmail-mcp-server-baqd.onrender.com/mcp');
    expect(mcpEndpoint('https://drivemcp.googleapis.com/mcp/v1')).toBe('https://drivemcp.googleapis.com/mcp/v1');
    expect(mcpEndpoint('https://drivemcp.googleapis.com/mcp/v1/')).toBe('https://drivemcp.googleapis.com/mcp/v1');
  });
  it('knows which is which', () => {
    expect(isHostedEndpoint('https://drivemcp.googleapis.com/mcp/v1')).toBe(true);
    expect(isHostedEndpoint('https://x.onrender.com')).toBe(false);
    expect(isHostedEndpoint('not a url')).toBe(false);
  });
});

describe('Google connectors', () => {
  it('ask for the scopes each server needs, and the designer knows Drive\'s tools before it is connected', () => {
    expect(GOOGLE_SCOPES.gmail).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(GOOGLE_SCOPES.gdrive).toContain('https://www.googleapis.com/auth/drive.file');
    expect(GOOGLE_SCOPES.gdrive).toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(KNOWN_CONNECTOR_TOOLS.gdrive).toContain('search_files');
    expect(KNOWN_CONNECTOR_TOOLS.gdrive).toContain('create_file');
  });
});
