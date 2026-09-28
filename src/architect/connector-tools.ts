/**
 * TOOLS OF CONNECTORS THAT ARE NOT CONNECTED YET.
 *
 * A connector's server lists its tools only to a signed-in caller, so a
 * connector nobody has authorised yet showed the designer no tools at all
 * — and a requirement that sends email could never be designed until
 * someone had signed in. The builder now designs with them anyway: the
 * step is saved, skipped at run time with a note until the connector is
 * connected (nodes/call-tool.ts), and a setup item says what to connect.
 *
 * Names are read from the connector servers' own source (the Gmail and
 * Outlook MCP servers publish the same tool set). A connector not listed
 * here is offered with no tools until it is connected.
 */
const MAIL_TOOLS = ['sendEmail', 'createDraft', 'replyEmail', 'searchEmails', 'listEmails', 'readEmail', 'markEmail', 'moveEmail', 'getAttachments', 'getProfile'];

export const KNOWN_CONNECTOR_TOOLS: Record<string, string[]> = {
  gmail: [...MAIL_TOOLS, 'listLabels'],
  outlook: [...MAIL_TOOLS, 'listFolders'],
};

export interface ConnectorOffer { connector: string; tools: string[]; connected: boolean }

/**
 * Every connector the designer may use: the connected ones with the tools
 * their servers reported, and the catalogued ones that are not connected
 * yet with the tools they are known to have.
 */
export function connectorOffers(servers: Array<{ provider: string; tools: Array<{ name: string }>; error?: string }>): ConnectorOffer[] {
  const out: ConnectorOffer[] = [];
  for (const s of servers) {
    if (!s.error && s.tools.length > 0) out.push({ connector: s.provider, tools: s.tools.map(t => t.name), connected: true });
    else if (s.error === 'not connected') out.push({ connector: s.provider, tools: KNOWN_CONNECTOR_TOOLS[s.provider] ?? [], connected: false });
  }
  return out;
}
