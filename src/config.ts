import { config as loadEnv } from 'dotenv';
// override: true — .env wins over pre-existing shell / OS env vars, so a
// stale system-level OPENAI_API_KEY can't shadow the project's key.
loadEnv({ override: true });

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY'),
  },

  openai: {
    apiKey: optional('OPENAI_API_KEY'),
  },

  gemini: {
    apiKey: optional('GEMINI_API_KEY'),
  },

  // Google OAuth client — powers the Gmail connector's Connect flow.
  // Same Google Cloud OAuth client as the Gmail MCP server; register
  // <SERVER_PUBLIC_URL>/api/connectors/oauth/callback as a redirect URI.
  google: {
    clientId:     optional('GOOGLE_CLIENT_ID'),
    clientSecret: optional('GOOGLE_CLIENT_SECRET'),
  },

  // Microsoft (Entra ID) app — powers the Outlook connector's Connect flow.
  // Same Azure app as the Outlook MCP server; register
  // <SERVER_PUBLIC_URL>/api/connectors/oauth/callback as a redirect URI.
  microsoft: {
    clientId:     optional('MS_CLIENT_ID'),
    clientSecret: optional('MS_CLIENT_SECRET'),
    tenant:       optional('MS_TENANT', 'common'),
  },

  salesforce: {
    loginUrl: optional('SF_LOGIN_URL', 'https://login.salesforce.com'),
    clientId: optional('SF_CLIENT_ID'),
    clientSecret: optional('SF_CLIENT_SECRET'),
    callbackEvent: optional('SF_CALLBACK_PLATFORM_EVENT', 'AgentExecutionResult__e'),

    // OAuth secrets for the Salesforce MCP connector (External Client App).
    // Use the SAME consumer key/secret your standalone MCP server uses, so
    // tokens it produces are accepted by SF for either caller.
    mcpClientId:     optional('SF_MCP_CLIENT_ID'),
    mcpClientSecret: optional('SF_MCP_CLIENT_SECRET'),

    // Public URL of the standalone Salesforce MCP server (Streamable HTTP).
    // Tool calls forward here with the user's access token as a Bearer.
    remoteMcpUrl: optional('SF_REMOTE_MCP_URL'),
  },

  // Public-facing base URL of THIS server. Used to build the OAuth
  // redirect_uri the External Client App / Auth Provider sends users back to.
  // Example: https://synapse.example.com  (or ngrok URL for dev)
  serverPublicUrl: optional('SERVER_PUBLIC_URL', 'http://localhost:3000'),

  // SQLite for dev; swap to postgres in prod by changing DATABASE_URL.
  databaseUrl: optional('DATABASE_URL', 'file:./synapse.db'),
} as const;
