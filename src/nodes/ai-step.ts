import { register } from './registry';
import type { NodeExecutor } from './registry';
import { runHeadlessAiStep, parseScoreTail } from '../chat/headless';
import { normalizeOutputs, parseOutputs } from '../orchestrator/structured-output';
import { logger } from '../logger';

/**
 * AI orchestrator nodes for FLOW (trigger-mode) runs.
 *
 * These call the same runtime chat calls, so the approval gate, the tool
 * allow-list, the turn budget and the loop detector apply to a triggered
 * run exactly as they do to a person typing.
 *
 * GEMINI IS REGISTERED HERE NOW. It used to live in nodes/ai.ts, which
 * refused outright the moment a tool catalog was attached: "Gemini
 * orchestrator with tool catalogs is not wired yet." That was never a
 * Gemini limitation — it was a consequence of the old adapters, which
 * delegated the tool loop to each provider's own Managed MCP, and Google
 * has none. The runtime binds ordinary tool definitions to any provider,
 * so an engine that works in chat now works from a trigger.
 *
 * (Registered AFTER nodes/ai.ts in engine.ts's side-effect imports, so
 * these overwrite ai.ts's placeholders — einstein/sentiment/embed there
 * are untouched.)
 */
const aiStepExec = (subType: string): NodeExecutor => async (node, ctx) => {
  // AN AI STEP WITH DECLARED OUTPUTS returns named fields, not free text
  // (orchestrator/structured-output.ts): {!judge.mood}, {!judge.risk} for
  // the conditions after it. One repair round if the answer does not fit.
  const outputs = normalizeOutputs((node.config as { outputs?: unknown }).outputs);
  const alias = String((node.config as { outputVariable?: unknown }).outputVariable ?? '').trim() || undefined;
  if (outputs.length > 0) {
    try {
      let result = await runHeadlessAiStep(ctx, node, { outputs });
      let parsed = parseOutputs(result.assistantText, outputs);
      let calls = 1;
      if (parsed.problems.length > 0) {
        logger.warn({ nodeId: node.id, problems: parsed.problems }, 'ai_step_output_repair');
        result = await runHeadlessAiStep(ctx, node, { outputs, repair: parsed.problems.join('; ') });
        parsed = parseOutputs(result.assistantText, outputs);
        calls = 2;
      }
      if (parsed.problems.length > 0) {
        return {
          nodeId: node.id, nodeSubType: subType, success: false,
          error: `The AI step's answer did not match its outputs after ${calls} tries: ${parsed.problems.join('; ')}`,
          output: { finalText: result.assistantText, toolCalls: result.toolCalls },
        };
      }
      logger.info({ nodeId: node.id, subType, fields: Object.keys(parsed.values), calls, modelUsed: result.modelUsed }, 'flow_ai_step_structured');
      return {
        nodeId: node.id, nodeSubType: subType, success: true,
        output: { ...parsed.values, finalText: result.assistantText, toolCalls: result.toolCalls, modelUsed: result.modelUsed, tokensIn: result.tokensIn, tokensOut: result.tokensOut },
        customAlias: alias,
        toolsUsed: result.toolCalls.map(c => `${c.name}${c.isError ? '(err)' : ''}`),
      };
    } catch (err) {
      logger.error({ err, nodeId: node.id, subType }, 'flow_ai_step_failed');
      return { nodeId: node.id, nodeSubType: subType, success: false, error: (err as Error).message };
    }
  }
  try {
    const result = await runHeadlessAiStep(ctx, node);
    const { score, priority, cleanText } = parseScoreTail(result.assistantText);

    if (result.policyViolations && result.policyViolations.length > 0) {
      const detail = result.policyViolations
        .map(v => `"${v.tool}" (${v.serverName} only allows: ${v.allowedTools.join(', ')})`)
        .join('; ');
      logger.error({ nodeId: node.id, subType, orgId: ctx.orgId, policyViolations: result.policyViolations }, 'flow_ai_step_policy_violation');
      return {
        nodeId: node.id,
        nodeSubType: subType,
        success: false,
        error: `Policy violation: the model called a tool outside this node's allowed list — ${detail}`,
        output: { finalText: cleanText, score, priority, toolCalls: result.toolCalls, policyViolations: result.policyViolations },
      };
    }

    logger.info({
      nodeId: node.id, subType, orgId: ctx.orgId,
      toolCallCount: result.toolCalls.length, modelUsed: result.modelUsed,
    }, 'flow_ai_step_complete');

    return {
      nodeId: node.id,
      nodeSubType: subType,
      success: true,
      output: {
        finalText: cleanText,
        // score/priority duplicated INSIDE output (not just top-level) —
        // ExecutionContext.recordResult only copies `output` into ctx.state,
        // so {!ai.score} / {!ai.priority} interpolation in a downstream
        // if_else node reads from here, not from the NodeResult fields.
        score,
        priority,
        toolCalls: result.toolCalls,
        modelUsed: result.modelUsed,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      },
      score,
      priority,
      reason: cleanText,
      toolsUsed: result.toolCalls.map(c => `${c.name}${c.isError ? '(err)' : ''}`),
    };
  } catch (err) {
    logger.error({ err, nodeId: node.id, subType }, 'flow_ai_step_failed');
    return { nodeId: node.id, nodeSubType: subType, success: false, error: (err as Error).message };
  }
};

register('claude', aiStepExec('claude'));
register('gpt4', aiStepExec('gpt4'));
register('gemini', aiStepExec('gemini'));
