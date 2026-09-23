import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * THE "HAS ANY KB?" QUESTION WAS ASKED OF POSTGRES ON EVERY TURN.
 *
 * buildKbBlock caches per (org, agent, QUERY), and the query is the
 * person's message, so every new message re-ran the count -- ~230-470ms,
 * the last per-turn read left once the others were cached, paid by an
 * agent with no documents at all.
 */

let counts = 0;
let readyDocs = 0;

vi.mock('../src/db/client', () => ({
  prisma: { kbDocument: { count: vi.fn(async () => { counts++; return readyDocs; }) } },
}));
vi.mock('../src/kb/embeddings', () => ({ embedQuery: vi.fn() }));
vi.mock('../src/kb/backends', () => ({ resolveBackend: vi.fn() }));

const { hasReadyKbDocumentsCached, invalidateKbReady, _clearKbReadyCache } = await import('../src/kb/retriever');

let clockOffset = 0;
const realNow = Date.now;

describe('hasReadyKbDocumentsCached', () => {
  beforeEach(() => {
    counts = 0; readyDocs = 0; clockOffset = 0;
    _clearKbReadyCache();
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  });

  it('asks Postgres once, then answers from memory -- a NO especially', async () => {
    expect(await hasReadyKbDocumentsCached('org', 'agent')).toBe(false);
    expect(await hasReadyKbDocumentsCached('org', 'agent')).toBe(false);
    expect(await hasReadyKbDocumentsCached('org', 'agent')).toBe(false);
    expect(counts).toBe(1);
  });

  it('keys by agent: one agent having documents says nothing about another', async () => {
    readyDocs = 1;
    expect(await hasReadyKbDocumentsCached('org', 'a')).toBe(true);
    readyDocs = 0;
    expect(await hasReadyKbDocumentsCached('org', 'b')).toBe(false);
    expect(counts).toBe(2);
  });

  it('a document becoming Ready is seen on the next turn', async () => {
    expect(await hasReadyKbDocumentsCached('org', 'agent')).toBe(false);
    readyDocs = 1;
    invalidateKbReady('org', 'agent');
    expect(await hasReadyKbDocumentsCached('org', 'agent')).toBe(true);
    expect(counts).toBe(2);
  });

  it('a delete that knows only the org forgets every agent in it', async () => {
    readyDocs = 1;
    await hasReadyKbDocumentsCached('org', 'a');
    await hasReadyKbDocumentsCached('org', 'b');
    await hasReadyKbDocumentsCached('other', 'a');
    readyDocs = 0;
    invalidateKbReady('org');
    expect(await hasReadyKbDocumentsCached('org', 'a')).toBe(false);
    expect(await hasReadyKbDocumentsCached('org', 'b')).toBe(false);
    expect(await hasReadyKbDocumentsCached('other', 'a')).toBe(true);   // untouched
    expect(counts).toBe(5);
  });

  it('expires on its own, so a missed write site costs minutes, not forever', async () => {
    await hasReadyKbDocumentsCached('org', 'agent');
    clockOffset += 6 * 60_000;
    await hasReadyKbDocumentsCached('org', 'agent');
    expect(counts).toBe(2);
  });
});
