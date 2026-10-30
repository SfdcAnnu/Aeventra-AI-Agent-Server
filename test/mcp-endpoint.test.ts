import { describe, it, expect } from 'vitest';
import { isHostedEndpoint, mcpEndpoint } from '../src/mcp/endpoint';
import { platformBaseUrl } from '../src/chat/tool-node-connectors';
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
  // The server's own platform tools live under a path, but they are ours:
  // the copilot's build_agent and inspector tools vanished on Render for a
  // month because this base was taken for a provider-hosted endpoint and
  // POSTed to /platform (the GET-only wake ping) instead of /platform/mcp.
  it('treats the platform base as one of ours: /mcp appended, loopback or public', () => {
    process.env.PORT = '10000';
    delete process.env.PLATFORM_TOOLS_URL;
    const base = platformBaseUrl();
    expect(base).toBe('http://127.0.0.1:10000/platform');
    expect(isHostedEndpoint(base)).toBe(false);
    expect(mcpEndpoint(base)).toBe('http://127.0.0.1:10000/platform/mcp');
    expect(isHostedEndpoint('https://aeventra-ai-agent-server.onrender.com/platform/')).toBe(false);
    expect(mcpEndpoint('https://aeventra-ai-agent-server.onrender.com/platform/')).toBe('https://aeventra-ai-agent-server.onrender.com/platform/mcp');
    delete process.env.PORT;
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
