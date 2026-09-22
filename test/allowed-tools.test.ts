import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sanitizeAllowedTools } from '../src/chat/adapters/shared';

/**
 * An empty allowedTools array does NOT mean "nothing allowed" downstream.
 * openai.ts only sets `allowed_tools` when the array is non-empty, and
 * claude.ts skips its violation check on an empty list — so returning []
 * for a stale list handed the model the whole catalogue. The log event
 * said so out loud: allowed_tools_all_stale_exposing_all.
 *
 * Renaming a tool on an MCP server is ordinary. The cost must be "this
 * agent loses a tool", never "this agent gains deleteSobjectRecord".
 */
const catalog = (...names: string[]) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tools: names.map(name => ({ name })) }) });

describe('sanitizeAllowedTools', () => {
  beforeEach(() => vi.stubGlobal('fetch', catalog('getObjectSchema', 'createSobjectRecord', 'soqlQuery')));
  afterEach(() => vi.unstubAllGlobals());

  // A fresh base url per test: the catalogue is cached for ten minutes.
  let n = 0;
  const base = () => `https://mcp.example${n++}`;

  it('drops the server when every saved name has rotted', async () => {
    // The real case: an agent saved when the tools were get_record/create_record.
    expect(await sanitizeAllowedTools(base(), ['get_record', 'create_record'])).toBeNull();
  });

  it('never returns [] for a stale list, because [] means "no restriction"', async () => {
    expect(await sanitizeAllowedTools(base(), ['long_gone'])).not.toEqual([]);
  });

  it('keeps the names that still exist and drops the rest', async () => {
    expect(await sanitizeAllowedTools(base(), ['soqlQuery', 'get_record'])).toEqual(['soqlQuery']);
  });

  it('leaves a fully valid list alone', async () => {
    const saved = ['getObjectSchema', 'createSobjectRecord'];
    expect(await sanitizeAllowedTools(base(), saved)).toEqual(saved);
  });

  it('treats a list SAVED empty as the whole catalogue, which is a real choice', async () => {
    expect(await sanitizeAllowedTools(base(), [])).toEqual([]);
  });

  it('passes the list through when the catalogue cannot be read', async () => {
    // A free-tier host mid-wake must not silently narrow a working agent.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    expect(await sanitizeAllowedTools(base(), ['get_record'])).toEqual(['get_record']);
  });

  it('passes through when the catalogue comes back empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tools: [] }) }));
    expect(await sanitizeAllowedTools(base(), ['get_record'])).toEqual(['get_record']);
  });

  it('is case-sensitive, because the MCP server is', async () => {
    expect(await sanitizeAllowedTools(base(), ['soqlquery'])).toBeNull();
  });
});
