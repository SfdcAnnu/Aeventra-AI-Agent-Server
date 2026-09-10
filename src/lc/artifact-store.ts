/**
 * artifact-store — Phase 3: large tool results stay server-side, passed to
 * the model BY REFERENCE (doc §6.2, Rule 9). One broad SOQL returning
 * thousands of rows used to flood the context window and inflate every
 * subsequent call in the turn; now the model receives a compact summary —
 * `{artifact, totalRecords, fields, preview}` — plus a read_artifact tool
 * to page through the real data only when it actually needs more.
 *
 * Storage is an in-process TTL map (same single-instance stance as the MCP
 * connection cache): artifacts survive across the turns of a conversation
 * for ARTIFACT_TTL, then expire; read_artifact on an expired handle tells
 * the model to simply re-run the original tool. Bounded by entry count and
 * per-artifact size so a pathological result can't hold the process
 * hostage.
 */
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { logger } from '../logger';

const envInt = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

/** Results at or under this many characters stay inline — normal lookups
 *  never touch the artifact path. */
export const ARTIFACT_THRESHOLD = envInt('ARTIFACT_THRESHOLD_CHARS', 2_000);
const TTL_MS = envInt('ARTIFACT_TTL_MS', 30 * 60 * 1000);
const MAX_ENTRIES = envInt('ARTIFACT_MAX_ENTRIES', 200);
const MAX_STORED_CHARS = envInt('ARTIFACT_MAX_CHARS', 1_000_000);

interface ArtifactEntry {
  data: string;
  createdAt: number;
  tool: string;
  kind: 'json-records' | 'text';
  records?: unknown[];
  truncated: boolean;
}

const store = new Map<string, ArtifactEntry>();

function sweep(): void {
  const now = Date.now();
  for (const [id, e] of store) {
    if (now - e.createdAt > TTL_MS) store.delete(id);
  }
  // Size cap — evict oldest first (Map preserves insertion order).
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Salesforce-style record list: {"records":[...]} or a bare array. */
function parseRecords(raw: string): unknown[] | null {
  try {
    const j = JSON.parse(raw) as unknown;
    if (Array.isArray(j)) return j;
    const recs = (j as { records?: unknown }).records;
    return Array.isArray(recs) ? recs : null;
  } catch {
    return null;
  }
}

function fieldNames(record: unknown): string[] {
  if (record === null || typeof record !== 'object') return [];
  return Object.keys(record as Record<string, unknown>).filter(k => k !== 'attributes').slice(0, 25);
}

/** Store a large result and return the compact reference the model sees.
 *  Small results pass through untouched. */
export function spillIfLarge(toolName: string, result: string): string {
  if (result.length <= ARTIFACT_THRESHOLD) return result;
  sweep();

  const id = `art_${randomBytes(5).toString('hex')}`;
  const truncated = result.length > MAX_STORED_CHARS;
  const data = truncated ? result.slice(0, MAX_STORED_CHARS) : result;
  const records = parseRecords(data);

  store.set(id, {
    data,
    createdAt: Date.now(),
    tool: toolName,
    kind: records ? 'json-records' : 'text',
    records: records ?? undefined,
    truncated,
  });
  logger.info({ artifact: id, tool: toolName, chars: result.length, records: records?.length ?? null }, 'artifact_stored');

  if (records) {
    return JSON.stringify({
      artifact: id,
      note: 'Large result stored by reference — use read_artifact for more records. Reuse exact values from the preview when they suffice.',
      totalRecords: records.length,
      fields: fieldNames(records[0]),
      preview: records.slice(0, 3),
    });
  }
  return JSON.stringify({
    artifact: id,
    note: 'Large result stored by reference — use read_artifact to fetch further sections.',
    totalChars: result.length,
    preview: data.slice(0, 500),
  });
}

/** The dereference tool — bound alongside the agent's other tools. */
export function buildReadArtifactTool(): StructuredToolInterface {
  return tool(
    async (args: { artifact_id: string; offset?: number; limit?: number }) => {
      const id = String(args.artifact_id ?? '');
      const entry = store.get(id);
      if (!entry || Date.now() - entry.createdAt > TTL_MS) {
        store.delete(id);
        return `Artifact ${id} has expired or does not exist — re-run the original tool to regenerate the data.`;
      }
      const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
      if (entry.kind === 'json-records' && entry.records) {
        const limit = Math.min(Math.max(1, Math.floor(Number(args.limit ?? 10)) || 10), 25);
        const slice = entry.records.slice(offset, offset + limit);
        return JSON.stringify({
          artifact: id,
          totalRecords: entry.records.length,
          offset,
          returned: slice.length,
          records: slice,
          ...(entry.truncated ? { note: 'Source was truncated at storage time.' } : {}),
        });
      }
      const limit = Math.min(Math.max(100, Math.floor(Number(args.limit ?? 4000)) || 4000), 8000);
      return entry.data.slice(offset, offset + limit) +
        (offset + limit < entry.data.length ? `\n…(more available — next offset: ${offset + limit})` : '');
    },
    {
      name: 'read_artifact',
      description: 'Read more of a large tool result that was stored by reference (an earlier result gave you an "artifact" id and a preview). For record lists: offset/limit are record indices (max 25 per read). For text: offset/limit are character positions.',
      schema: z.object({
        artifact_id: z.string().describe('The artifact id from the earlier tool result, e.g. "art_1a2b3c4d5e"'),
        offset: z.number().optional().describe('Start position (records or characters). Default 0.'),
        limit: z.number().optional().describe('How much to read. Default 10 records / 4000 characters.'),
      }),
    },
  ) as StructuredToolInterface;
}
