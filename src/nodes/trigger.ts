import { register } from './registry';
import type { NodeExecutor } from './registry';

/**
 * Trigger nodes seed the execution with `inputPayload`. They don't do work —
 * they just publish the input data into context state so downstream nodes
 * can reference {!record.Email}, {!record.Phone}, etc.
 */
const triggerExec: NodeExecutor = async (node, ctx) => ({
  nodeId: node.id,
  nodeSubType: node.nodeSubType,
  success: true,
  output: { ...ctx.inputPayload },
});

register('record', triggerExec);
register('schedule', triggerExec);
register('webhook', triggerExec);
register('platform_event', triggerExec);
