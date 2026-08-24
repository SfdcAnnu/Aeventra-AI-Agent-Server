/**
 * Central tool dispatcher.
 *
 * Maps `(catalogSubType, toolName) → handler function`. Used by the AI
 * orchestrator executors (claude/gpt4/gemini) when they need to actually
 * invoke a tool the model picked.
 *
 * Also exposes the OpenAI/Anthropic-compatible tool schemas (`getCatalogTools`)
 * so the AI knows what each tool's parameters look like.
 */

import {
  sfGetRecord,
  sfQuery,
  sfListSObjects,
  sfDescribeSObject,
  sfRunReport,
  sfCreateRecord,
  sfUpdateRecord,
  sfDeleteRecord,
  sfCreateTask,
  sfPostChatter,
  sfApexInvocable,
} from './servers/salesforce-crm';
import {
  storageListFiles,
  storageReadFile,
  storageWriteFile,
  storageMoveFile,
} from './servers/storage';
import { emailSend, emailSendTemplate } from './servers/email';
import { channelPostMessage } from './servers/channels';
import { loadConnector, type ConnectorRecord } from '../salesforce/connectors';
import { logger } from '../logger';

/** Provider key → catalog type. Matches ConnectorCatalog__mdt.MapsToCatalogType__c. */
const PROVIDER_TO_CATALOG: Record<string, CatalogSubType> = {
  salesforce_mcp: 'salesforce_crm_tools',
  gdrive:         'storage_tools',
  onedrive:       'storage_tools',
  sharepoint:     'storage_tools',
  outlook:        'email_tools',
  gmail:          'email_tools',
  slack:          'channel_tools',
  teams:          'channel_tools',
};

export type CatalogSubType =
  | 'salesforce_crm_tools'
  | 'storage_tools'
  | 'email_tools'
  | 'channel_tools';

/** OpenAI-style tool definition (function-calling). */
export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Per-catalog tool registry — schemas + descriptions for the AI. */
const TOOL_DEFS: Record<CatalogSubType, Record<string, ToolDef>> = {
  salesforce_crm_tools: {
    // ── Phase 1 — read ──
    list_sobjects: {
      type: 'function',
      function: {
        name: 'list_sobjects',
        description: 'List all queryable Salesforce SObjects in this org (standard + custom). Use when the user did not name a specific object.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    describe_sobject: {
      type: 'function',
      function: {
        name: 'describe_sobject',
        description: 'Get the fields, types, picklist values, and required flags for one SObject. Call BEFORE get_record / query_records when unsure which fields exist.',
        parameters: {
          type: 'object',
          properties: { objectType: { type: 'string', description: 'API name of the SObject (e.g. Lead, Account, MyCustom__c)' } },
          required: ['objectType'], additionalProperties: false,
        },
      },
    },
    get_record: {
      type: 'function',
      function: {
        name: 'get_record',
        description: 'Retrieve a single Salesforce record by ID.',
        parameters: {
          type: 'object',
          properties: {
            objectType: { type: 'string' },
            recordId: { type: 'string', description: '15 or 18 character Salesforce record ID' },
            fields: { type: 'array', items: { type: 'string' } },
          },
          required: ['objectType', 'recordId', 'fields'], additionalProperties: false,
        },
      },
    },
    query_records: {
      type: 'function',
      function: {
        name: 'query_records',
        description: 'Run a SOQL query. Always include LIMIT to bound the response.',
        parameters: {
          type: 'object',
          properties: { soql: { type: 'string' } },
          required: ['soql'], additionalProperties: false,
        },
      },
    },
    run_report: {
      type: 'function',
      function: {
        name: 'run_report',
        description: 'Execute a saved Salesforce report and return its rows.',
        parameters: {
          type: 'object',
          properties: { reportId: { type: 'string' } },
          required: ['reportId'], additionalProperties: false,
        },
      },
    },
    // ── Phase 2 — writes (gated by approval) ──
    create_record: phase2('create_record', 'Create a new Salesforce record. Returns the new record Id.', {
      objectType: { type: 'string' }, fields: { type: 'object', additionalProperties: true },
    }, ['objectType', 'fields']),
    update_record: phase2('update_record', 'Update fields on an existing Salesforce record.', {
      objectType: { type: 'string' }, recordId: { type: 'string' }, fields: { type: 'object', additionalProperties: true },
    }, ['objectType', 'recordId', 'fields']),
    delete_record: phase2('delete_record', 'Delete a Salesforce record.', {
      objectType: { type: 'string' }, recordId: { type: 'string' },
    }, ['objectType', 'recordId']),
    create_task: phase2('create_task',
      'Create a Task on a record. dueDate accepts ISO yyyy-MM-dd or shorthand "TODAY", "TODAY+1", "TODAY+7".',
      {
        subject:     { type: 'string' },
        whatId:      { type: 'string', description: 'WhatId — Account / Opportunity / Case / custom object' },
        whoId:       { type: 'string', description: 'WhoId — Lead or Contact' },
        dueDate:     { type: 'string' },
        priority:    { type: 'string', enum: ['High', 'Normal', 'Low'] },
        status:      { type: 'string' },
        description: { type: 'string' },
        ownerId:     { type: 'string' },
      },
      ['subject']),
    post_chatter: phase2('post_chatter',
      'Post a Chatter feed item on a record. `mentions` is an optional array of user IDs to @mention.',
      {
        recordId: { type: 'string' },
        message:  { type: 'string' },
        mentions: { type: 'array', items: { type: 'string' } },
      },
      ['recordId', 'message']),
    apex_invocable: phase2('apex_invocable', 'Invoke an Apex Invocable method.', {
      className: { type: 'string' }, params: { type: 'object', additionalProperties: true },
    }, ['className']),
  },

  storage_tools: {
    // ── Phase 1 — read ──
    list_files: {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files in a folder. Returns metadata: id, name, mimeType, size, modified.',
        parameters: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Folder ID or path. Empty string for root.' },
            query: { type: 'string' },
          },
          required: ['folder'], additionalProperties: false,
        },
      },
    },
    read_file: {
      type: 'function',
      function: {
        name: 'read_file',
        description: "Read a file's contents. Returns text for text files, base64 for binary.",
        parameters: {
          type: 'object',
          properties: { fileId: { type: 'string' } },
          required: ['fileId'], additionalProperties: false,
        },
      },
    },
    search: {
      type: 'function',
      function: {
        name: 'search',
        description: 'Full-text search across the connector. Returns matching files with snippets.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, mimeType: { type: 'string' } },
          required: ['query'], additionalProperties: false,
        },
      },
    },
    get_file_metadata: {
      type: 'function',
      function: {
        name: 'get_file_metadata',
        description: 'Get metadata for a single file (size, mimeType, owner, modified) without downloading content.',
        parameters: {
          type: 'object',
          properties: { fileId: { type: 'string' } },
          required: ['fileId'], additionalProperties: false,
        },
      },
    },
    // ── Phase 2 — writes ──
    write_file: phase2('write_file', 'Create or replace a file. Returns the file ID.', {
      folder: { type: 'string' }, name: { type: 'string' },
      content: { type: 'string', description: 'Text content. For binary, base64 encode first.' },
      mimeType: { type: 'string' },
    }, ['folder', 'name', 'content']),
    update_file: phase2('update_file', 'Replace the contents of an existing file.', {
      fileId: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string' },
    }, ['fileId', 'content']),
    create_folder: phase2('create_folder', 'Create a new folder.', {
      parentFolder: { type: 'string' }, name: { type: 'string' },
    }, ['parentFolder', 'name']),
    move_file: phase2('move_file', 'Move a file to a different folder.', {
      fileId: { type: 'string' }, destinationFolder: { type: 'string' },
    }, ['fileId', 'destinationFolder']),
    delete_file: phase2('delete_file', 'Permanently delete a file.', {
      fileId: { type: 'string' },
    }, ['fileId']),
    share_file: phase2('share_file', 'Generate a shareable link or grant access to a file.', {
      fileId: { type: 'string' }, role: { type: 'string', description: 'reader / writer / commenter' },
      audience: { type: 'string', description: 'anyone / domain / email address' },
    }, ['fileId', 'role']),
  },

  email_tools: {
    // ── Phase 1 — read ──
    list_emails: {
      type: 'function',
      function: {
        name: 'list_emails',
        description: 'List recent emails in a folder/label. Returns id, from, subject, snippet, date.',
        parameters: {
          type: 'object',
          properties: {
            folder: { type: 'string', description: 'Inbox / folder name (Outlook) or label (Gmail). Empty for INBOX.' },
            maxResults: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: [], additionalProperties: false,
        },
      },
    },
    read_email: {
      type: 'function',
      function: {
        name: 'read_email',
        description: 'Get the full body + attachments metadata for a single email.',
        parameters: {
          type: 'object',
          properties: { messageId: { type: 'string' } },
          required: ['messageId'], additionalProperties: false,
        },
      },
    },
    search_emails: {
      type: 'function',
      function: {
        name: 'search_emails',
        description: 'Search emails. Gmail accepts its query syntax (from:, subject:, has:attachment). Outlook accepts KQL.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, maxResults: { type: 'integer' } },
          required: ['query'], additionalProperties: false,
        },
      },
    },
    // ── Phase 2 — writes ──
    send_email: phase2('send_email', 'Send a one-off email. Returns the provider message ID.', {
      to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' },
      cc: { type: 'array', items: { type: 'string' } },
    }, ['to', 'subject', 'body']),
    reply_email: phase2('reply_email', 'Reply to an existing email thread.', {
      messageId: { type: 'string' }, body: { type: 'string' }, replyAll: { type: 'boolean' },
    }, ['messageId', 'body']),
    forward_email: phase2('forward_email', 'Forward an email to another recipient.', {
      messageId: { type: 'string' }, to: { type: 'string' }, body: { type: 'string' },
    }, ['messageId', 'to']),
    create_draft: phase2('create_draft', 'Save a draft message without sending.', {
      to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' },
    }, ['to', 'subject', 'body']),
    send_template: phase2('send_template', 'Send using a provider-side template.', {
      to: { type: 'string' }, templateId: { type: 'string' }, mergeVars: { type: 'object', additionalProperties: true },
    }, ['to', 'templateId']),
  },

  channel_tools: {
    // ── Phase 1 — read ──
    list_channels: {
      type: 'function',
      function: {
        name: 'list_channels',
        description: 'List channels the bot/user has access to (Slack channels, Teams channels, Twilio sub-accounts).',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    list_users: {
      type: 'function',
      function: {
        name: 'list_users',
        description: 'List users / members visible to this connector (used to resolve a name to an ID).',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    read_channel_history: {
      type: 'function',
      function: {
        name: 'read_channel_history',
        description: 'Read recent messages in a channel. Returns id, author, text, timestamp.',
        parameters: {
          type: 'object',
          properties: { channel: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
          required: ['channel'], additionalProperties: false,
        },
      },
    },
    // ── Phase 2 — writes ──
    post_message: phase2('post_message', 'Post a message to a channel/DM/chat.', {
      channel: { type: 'string', description: 'Channel ID, webhook URL, or phone number depending on provider.' },
      message: { type: 'string' },
    }, ['channel', 'message']),
    update_message: phase2('update_message', 'Update a previously posted message.', {
      channel: { type: 'string' }, messageId: { type: 'string' }, message: { type: 'string' },
    }, ['channel', 'messageId', 'message']),
    add_reaction: phase2('add_reaction', 'Add an emoji reaction to a message.', {
      channel: { type: 'string' }, messageId: { type: 'string' }, emoji: { type: 'string' },
    }, ['channel', 'messageId', 'emoji']),
    upload_file: phase2('upload_file', 'Share a file in a channel.', {
      channel: { type: 'string' }, fileName: { type: 'string' }, content: { type: 'string' }, comment: { type: 'string' },
    }, ['channel', 'fileName', 'content']),
  },
};

/** Helper: build a Phase 2 tool def with a "[Phase 2]" tag in the description. */
function phase2(
  name: string,
  desc: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDef {
  return {
    type: 'function',
    function: {
      name,
      description: `[Phase 2 — requires approval gate] ${desc}`,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}

/** Returns the tool defs for a catalog, filtered to the allowed list. */
export function getCatalogTools(catalogType: CatalogSubType, allowedToolNames: string[]): ToolDef[] {
  const all = TOOL_DEFS[catalogType] ?? {};
  return allowedToolNames
    .map((name) => all[name])
    .filter((t): t is ToolDef => !!t);
}

/** Returns metadata about each catalog so the AI can see what's available at the meta level (two-tier dispatch). */
export interface CatalogSummary {
  name: string;       // unique name shown to the AI (e.g. "salesforce_crm")
  catalogType: CatalogSubType;
  description: string;
  toolCount: number;
}

export function catalogSummary(args: {
  catalogType: CatalogSubType;
  nameOverride?: string;
  description?: string;
  allowedTools: string[];
}): CatalogSummary {
  return {
    name: args.nameOverride ?? catalogTypeToName(args.catalogType),
    catalogType: args.catalogType,
    description: args.description ?? defaultDescription(args.catalogType),
    toolCount: args.allowedTools.length,
  };
}

function catalogTypeToName(t: CatalogSubType): string {
  return t.replace(/_tools$/, '');
}

function defaultDescription(t: CatalogSubType): string {
  switch (t) {
    case 'salesforce_crm_tools':
      return 'Read Salesforce records, query SOQL, describe schemas.';
    case 'storage_tools':
      return 'List, read, and write files in cloud storage.';
    case 'email_tools':
      return 'Send transactional emails.';
    case 'channel_tools':
      return 'Post messages to chat / SMS channels.';
  }
}

/**
 * Dispatch a tool call to the right MCP server function.
 *
 * Either pass `connectorId` (preferred — loads provider + credentials from SF)
 * or `provider` (legacy fallback when no connector is configured).
 */
export async function dispatchTool(args: {
  catalogType: CatalogSubType;
  toolName: string;
  toolInput: Record<string, unknown>;
  connectorId?: string;
  provider?: string;
}): Promise<unknown> {
  const { catalogType, toolName, toolInput, connectorId } = args;

  let connector: ConnectorRecord | null = null;
  let provider = args.provider;

  if (connectorId) {
    connector = await loadConnector(connectorId);
    provider = connector.providerKey;
    // Belt-and-braces: make sure the connector matches the catalog type the AI is in
    const expected = PROVIDER_TO_CATALOG[connector.providerKey];
    if (expected && expected !== catalogType) {
      logger.warn(
        { connectorId, providerKey: connector.providerKey, expected, catalogType },
        'connector_catalog_type_mismatch',
      );
    }
  }

  switch (catalogType) {
    case 'salesforce_crm_tools':
      return dispatchSalesforce(toolName, toolInput, connector);
    case 'storage_tools':
      return dispatchStorage(toolName, toolInput, provider ?? 'gdrive', connector);
    case 'email_tools':
      return dispatchEmail(toolName, toolInput, provider ?? 'outlook', connector);
    case 'channel_tools':
      return dispatchChannel(toolName, toolInput, provider ?? 'slack', connector);
  }
}

async function dispatchSalesforce(
  name: string,
  input: Record<string, unknown>,
  connector: ConnectorRecord | null,
): Promise<unknown> {
  switch (name) {
    // ── Phase 1 — read ──
    case 'list_sobjects':
      return sfListSObjects({ connector });
    case 'describe_sobject':
      return sfDescribeSObject({ connector, objectType: String(input.objectType) });
    case 'get_record':
      return sfGetRecord({
        connector,
        objectType: String(input.objectType),
        recordId: String(input.recordId),
        fields: Array.isArray(input.fields) ? (input.fields as string[]) : [],
      });
    case 'query_records':
      return sfQuery({ connector, soql: String(input.soql) });
    case 'run_report':
      return sfRunReport({ connector, reportId: String(input.reportId) });

    // ── Phase 2 — write ──
    case 'create_record':
      return sfCreateRecord({
        connector,
        objectType: String(input.objectType),
        fields: (input.fields as Record<string, unknown>) ?? {},
      });
    case 'update_record':
      return sfUpdateRecord({
        connector,
        objectType: String(input.objectType),
        recordId: String(input.recordId),
        fields: (input.fields as Record<string, unknown>) ?? {},
      });
    case 'delete_record':
      return sfDeleteRecord({
        connector,
        objectType: String(input.objectType),
        recordId: String(input.recordId),
      });
    case 'create_task':
      return sfCreateTask({
        connector,
        subject: String(input.subject),
        whatId: input.whatId as string | undefined,
        whoId:  input.whoId  as string | undefined,
        dueDate: input.dueDate as string | undefined,
        priority: input.priority as string | undefined,
        status: input.status as string | undefined,
        description: input.description as string | undefined,
        ownerId: input.ownerId as string | undefined,
      });
    case 'post_chatter':
      return sfPostChatter({
        connector,
        recordId: String(input.recordId),
        message:  String(input.message),
        mentions: Array.isArray(input.mentions) ? (input.mentions as string[]) : undefined,
      });
    case 'apex_invocable':
      return sfApexInvocable({
        connector,
        className: String(input.className),
        params: (input.params as Record<string, unknown>) ?? {},
      });

    default:
      throw new Error(`salesforce_crm_tools: unknown tool ${name}`);
  }
}

async function dispatchStorage(
  name: string,
  input: Record<string, unknown>,
  provider: string,
  connector: ConnectorRecord | null,
): Promise<unknown> {
  switch (name) {
    case 'list_files':
      return storageListFiles({ provider, connector, folder: String(input.folder), query: input.query as string | undefined });
    case 'read_file':
      return storageReadFile({ provider, connector, fileId: String(input.fileId) });
    case 'write_file':
      return storageWriteFile({
        provider, connector,
        folder: String(input.folder),
        name: String(input.name),
        content: String(input.content),
        mimeType: input.mimeType as string | undefined,
      });
    case 'move_file':
      return storageMoveFile({
        provider, connector,
        fileId: String(input.fileId),
        destinationFolder: String(input.destinationFolder),
      });
    default:
      throw new Error(`storage_tools: unknown tool ${name}`);
  }
}

async function dispatchEmail(
  name: string,
  input: Record<string, unknown>,
  provider: string,
  connector: ConnectorRecord | null,
): Promise<unknown> {
  switch (name) {
    case 'send_email':
      return emailSend({
        provider, connector,
        to: String(input.to),
        subject: String(input.subject),
        body: String(input.body),
        cc: Array.isArray(input.cc) ? (input.cc as string[]) : undefined,
      });
    case 'send_template':
      return emailSendTemplate({
        provider, connector,
        to: String(input.to),
        templateId: String(input.templateId),
        mergeVars: (input.mergeVars as Record<string, unknown>) ?? {},
      });
    default:
      throw new Error(`email_tools: unknown tool ${name}`);
  }
}

async function dispatchChannel(
  name: string,
  input: Record<string, unknown>,
  provider: string,
  connector: ConnectorRecord | null,
): Promise<unknown> {
  switch (name) {
    case 'post_message':
      return channelPostMessage({
        provider, connector,
        channel: String(input.channel),
        message: String(input.message),
      });
    default:
      throw new Error(`channel_tools: unknown tool ${name}`);
  }
}
