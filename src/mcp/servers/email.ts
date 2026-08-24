import { logger } from '../../logger';
import type { ConnectorRecord } from '../../salesforce/connectors';

/**
 * Email MCP server — Outlook, Gmail, SendGrid.
 *
 * STUBS for now. Wire real providers later:
 *   - outlook:  @microsoft/microsoft-graph-client (sendMail)
 *   - gmail:    googleapis (gmail.users.messages.send)
 *   - sendgrid: @sendgrid/mail
 *
 * Connector token comes in as connector.accessToken for OAuth providers,
 * or connector.apiKey for SendGrid-style.
 */

interface ProviderArgs { provider: string; connector: ConnectorRecord | null; }

function note(args: ProviderArgs, action: string): string {
  return args.connector
    ? `${args.provider} stub — connector ${args.connector.id} loaded. Real ${action} not yet wired.`
    : `${args.provider} not yet wired AND no connector picked. Returning stub.`;
}

export async function emailSend(args: ProviderArgs & {
  to: string;
  subject: string;
  body: string;
  cc?: string[];
}) {
  logger.info({ provider: args.provider, connectorId: args.connector?.id, to: args.to, subject: args.subject }, 'email_send_stub');
  return {
    stub: true,
    provider: args.provider,
    messageId: `stub-${Date.now()}`,
    note: note(args, 'send_email'),
  };
}

export async function emailSendTemplate(args: ProviderArgs & {
  to: string;
  templateId: string;
  mergeVars: Record<string, unknown>;
}) {
  logger.info({ provider: args.provider, connectorId: args.connector?.id, to: args.to, templateId: args.templateId }, 'email_send_template_stub');
  return {
    stub: true,
    provider: args.provider,
    templateId: args.templateId,
    messageId: `stub-${Date.now()}`,
    note: note(args, 'send_template'),
  };
}
