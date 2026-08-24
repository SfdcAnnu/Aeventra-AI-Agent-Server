import { register } from './registry';
import type { NodeExecutor } from './registry';

/**
 * Email + SMS + chat channel nodes.
 *
 * MVP just logs and pretends to send. Real wiring (SendGrid, Twilio, Slack)
 * lives behind the `channels` MCP server you'll add later.
 */

function passthrough(subType: string, tool: string): NodeExecutor {
  return async (node, ctx) => ({
    nodeId: node.id,
    nodeSubType: subType,
    success: true,
    output: {
      to: ctx.interpolate(String(node.config.to ?? '')),
      subject: ctx.interpolate(String(node.config.subject ?? '')),
      body: ctx.interpolate(String(node.config.body ?? node.config.message ?? '')),
      channel: ctx.interpolate(String(node.config.channel ?? '')),
      sent: false,
      note: `Stubbed — wire a real provider behind channels MCP to actually send. (${tool})`,
    },
    toolsUsed: [`channels:${tool}`],
  });
}

register('outlook', passthrough('outlook', 'send_outlook'));
register('gmail', passthrough('gmail', 'send_gmail'));
register('sendgrid', passthrough('sendgrid', 'send_sendgrid'));
register('twilio', passthrough('twilio', 'send_sms'));
register('whatsapp', passthrough('whatsapp', 'send_whatsapp'));
register('slack', passthrough('slack', 'post_slack'));
register('teams', passthrough('teams', 'post_teams'));
