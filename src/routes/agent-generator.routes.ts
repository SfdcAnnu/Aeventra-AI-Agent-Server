/**
 * AI agent generation — sessionAuth, org-scoped. Turns a plain-English
 * requirement (+ optional Q&A round-trip) into a canvas-ready agent graph.
 * See server/src/agent-generator/ for the actual generation logic.
 */
import { Router } from 'express';
import { z } from 'zod';
import { sessionAuth } from '../auth/session';
import { logger } from '../logger';
import { generateAgent } from '../agent-generator/generate';
import type { QaTurn, ResolvedCapability } from '../agent-generator/generate';
import { analyzeRequirement, verifyOtherAnswer, type Capability } from '../agent-generator/analyze';
import { gatherGrounding, renderGrounding, type GroundingPack } from '../agent-generator/grounding';
import { extractTextFromUpload } from '../kb/file-extract';

export const agentGeneratorRouter = Router();

const engineOverrideSchema = z.object({
  engineType:   z.string().nullish(),
  apiKey:       z.string().nullish(),
  endpoint:     z.string().nullish(),
  defaultModel: z.string().nullish(),
  connectionId: z.string().nullish(),
}).optional();

// ── POST /api/agent/analyze — v2 pass 1 ──────────────────────────────
// Gathers the org grounding pack (live MCP tools, Apex/Flows, objects)
// and produces the capability plan the Review step renders. The pack is
// returned to the client and echoed back on verify/generate calls —
// stateless server, no cross-request cache to invalidate.

const analyzeSchema = z.object({
  requirementText: z.string().default(''),
  fileBase64: z.string().optional(),
  fileName: z.string().optional(),
  mode: z.enum(['trigger', 'chat']).default('chat'),
  engineOverride: engineOverrideSchema,
}).refine(v => v.requirementText.trim().length > 0 || Boolean(v.fileBase64), {
  message: 'Provide a requirement description and/or upload a document.',
});

agentGeneratorRouter.post('/api/agent/analyze', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = analyzeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }
  try {
    const fileText = parsed.data.fileBase64
      ? await extractTextFromUpload(parsed.data.fileBase64, parsed.data.fileName ?? null)
      : '';
    const requirementText = [parsed.data.requirementText, fileText].filter(Boolean).join('\n\n');
    const grounding = await gatherGrounding(orgId, requirementText);
    const plan = await analyzeRequirement(
      { orgId, requirementText, mode: parsed.data.mode, grounding },
      parsed.data.engineOverride,
    );
    res.json({ plan, grounding, requirementText });
  } catch (err) {
    logger.error({ err, orgId }, 'agent_analyze_failed');
    res.status(502).json({ error: 'analyze_failed', message: (err as Error).message });
  }
});

// ── POST /api/agent/verify-answer — v2 pass 1.5 ─────────────────────
// Interprets a free-text "Other" answer for one capability. Round
// discipline lives in analyze.ts: round 1 may return one follow-up,
// round 2 always finalizes.

const verifySchema = z.object({
  mode: z.enum(['trigger', 'chat']).default('chat'),
  capability: z.record(z.string(), z.unknown()),
  answerText: z.string().min(1),
  round: z.number().int().min(1).max(2).default(1),
  grounding: z.record(z.string(), z.unknown()),
  engineOverride: engineOverrideSchema,
});

agentGeneratorRouter.post('/api/agent/verify-answer', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await verifyOtherAnswer(
      {
        orgId,
        mode: parsed.data.mode,
        grounding: parsed.data.grounding as unknown as GroundingPack,
        capability: parsed.data.capability as unknown as Capability,
        answerText: parsed.data.answerText,
        round: parsed.data.round,
      },
      parsed.data.engineOverride,
    );
    res.json(result);
  } catch (err) {
    logger.error({ err, orgId }, 'agent_verify_answer_failed');
    res.status(502).json({ error: 'verify_failed', message: (err as Error).message });
  }
});

const requestSchema = z
  .object({
    requirementText: z.string().default(''),
    fileBase64: z.string().optional(),
    fileName: z.string().optional(),
    qaHistory: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
    /** Defaults to 'trigger' to match AgentDefinition__c.ExecuteType__c's own field default. */
    mode: z.enum(['trigger', 'chat']).default('trigger'),
    /** v2 guided flow — the finalized capability contract + grounding pack
     *  from /api/agent/analyze, echoed back by the client. */
    resolvedCapabilities: z.array(z.record(z.string(), z.unknown())).optional(),
    grounding: z.record(z.string(), z.unknown()).optional(),
    /** Node subtypes the org holds active AI engine connections for —
     *  resolved Apex-side; the generator refuses to bind any other engine. */
    availableEngines: z.array(z.string()).optional(),
    engineOverride: engineOverrideSchema,
  })
  // Text, a document, or dictated-then-transcribed voice all land in
  // requirementText client-side (see agent-generator-data.ts) — a file is
  // the one genuinely separate input, so at least one of the two is
  // required, not both.
  .refine((v) => v.requirementText.trim().length > 0 || Boolean(v.fileBase64), {
    message: 'Provide a requirement description and/or upload a document.',
  });

agentGeneratorRouter.post('/api/agent/generate', sessionAuth, async (req, res) => {
  const orgId = req.orgId!;
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    return;
  }
  const { fileBase64, fileName, qaHistory, engineOverride, mode } = parsed.data;

  try {
    // Real PDF parsing (not a naive base64->utf8 decode, which produces
    // binary noise for anything but plain text) — same extractor the KB
    // upload pipeline already uses, so a real requirement document
    // (spec.pdf, a process doc) reads correctly here too.
    const fileText = fileBase64 ? await extractTextFromUpload(fileBase64, fileName ?? null) : '';
    const requirementText = [parsed.data.requirementText, fileText].filter(Boolean).join('\n\n');

    const result = await generateAgent(
      {
        orgId,
        requirementText,
        qaHistory: qaHistory as QaTurn[],
        mode,
        resolvedCapabilities: parsed.data.resolvedCapabilities as unknown as ResolvedCapability[] | undefined,
        groundingText: parsed.data.grounding
          ? renderGrounding(parsed.data.grounding as unknown as GroundingPack)
          : undefined,
        availableEngines: parsed.data.availableEngines,
      },
      engineOverride,
    );
    if (result.kind === 'questions') {
      res.json({ kind: 'questions', questions: result.questions });
      return;
    }
    res.json({ kind: 'agent', ...result.agent });
  } catch (err) {
    logger.error({ err, orgId }, 'agent_generate_failed');
    res.status(502).json({ error: 'generate_failed', message: (err as Error).message });
  }
});
