import { logger } from '../../logger';
import type { ConnectorRecord } from '../../salesforce/connectors';

/**
 * Channels MCP server — Slack, Microsoft Teams, Twilio SMS, WhatsApp.
 *
 * STUBS for now. Wire real providers later:
 *   - slack:    @slack/web-api (chat.postMessage)  ← uses connector.accessToken
 *   - teams:    Graph chats/{id}/messages          ← uses connector.accessToken
 *   - twilio:   twilio SDK                         ← uses connector.apiKey + accountSid in configJson
 *   - whatsapp: twilio / Meta Cloud API
 */

interface ProviderArgs { provider: string; connector: ConnectorRecord | null; }

export async function channelPostMessage(args: ProviderArgs & { channel: string; message: string }) {
  logger.info({ provider: args.provider, connectorId: args.connector?.id, channel: args.channel }, 'channel_post_message_stub');
  return {
    stub: true,
    provider: args.provider,
    channel: args.channel,
    messageId: `stub-${Date.now()}`,
    note: args.connector
      ? `${args.provider} stub — connector ${args.connector.id} loaded (${args.connector.accountEmail ?? 'no email'}). Real channel post not yet wired.`
      : `${args.provider} not yet wired AND no connector picked. Returning stub.`,
  };
}
