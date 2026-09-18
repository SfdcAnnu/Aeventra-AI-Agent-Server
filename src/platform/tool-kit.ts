/**
 * The shape of a platform tool and the two result helpers, in one small
 * module so every tool file (lookups, Architect stages, inspector, agent
 * edits) can import them without importing the registry that lists them.
 */
import { z } from 'zod';
import type { PlatformPrincipal } from './token';

export interface PlatformToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

export interface PlatformTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  readOnly: boolean;
  handler: (args: z.infer<z.ZodObject<Shape>>, principal: PlatformPrincipal) => Promise<PlatformToolResult>;
}

export function define<Shape extends z.ZodRawShape>(t: PlatformTool<Shape>): PlatformTool<z.ZodRawShape> {
  return t as unknown as PlatformTool<z.ZodRawShape>;
}

export const ok = (structured: Record<string, unknown>, text?: string): PlatformToolResult => ({
  text: text ?? JSON.stringify(structured, null, 2),
  structured,
});

/** An error result starts with "Error:" — the runtime's caches and claim
 *  guard read that prefix as "this did not run". */
export const fail = (message: string): PlatformToolResult => ({ text: `Error: ${message}`, structured: { error: message }, isError: true });

/** Bound a string for a tool result: the runtime spills anything over ~2k
 *  characters into a pageable artifact, so long fields are trimmed here
 *  and say so. */
export function clip(s: string | null | undefined, max = 600): string | null {
  if (s == null) return null;
  return s.length > max ? `${s.slice(0, max)}… [${s.length - max} more chars]` : s;
}
