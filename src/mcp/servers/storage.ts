import { logger } from '../../logger';
import type { ConnectorRecord } from '../../salesforce/connectors';

/**
 * Storage MCP server — Google Drive / OneDrive / SharePoint.
 *
 * STUBS for now. Each function returns "would have done X" and logs the call,
 * so an admin can build an agent and validate the AI picks the right tool
 * before we wire real Drive/OneDrive/SharePoint APIs.
 *
 * Real implementation per provider goes here later. `connector.accessToken`
 * is the OAuth bearer to use; `connector.refreshToken` covers refresh.
 */

interface ProviderArgs { provider: string; connector: ConnectorRecord | null; }

function note(args: ProviderArgs, action: string): string {
  return args.connector
    ? `${args.provider} stub — connector ${args.connector.id} loaded (${args.connector.accountEmail ?? 'no email'}). Real ${action} call not yet wired.`
    : `${args.provider} not yet wired AND no connector picked. Returning stub.`;
}

export async function storageListFiles(args: ProviderArgs & { folder: string; query?: string }) {
  logger.info({ provider: args.provider, connectorId: args.connector?.id, folder: args.folder, query: args.query }, 'storage_list_files_stub');
  return {
    stub: true,
    provider: args.provider,
    folder: args.folder,
    files: [],
    note: note(args, 'list_files'),
  };
}

export async function storageReadFile(args: ProviderArgs & { fileId: string }) {
  logger.info({ provider: args.provider, connectorId: args.connector?.id, fileId: args.fileId }, 'storage_read_file_stub');
  return {
    stub: true,
    provider: args.provider,
    fileId: args.fileId,
    content: '',
    note: note(args, 'read_file'),
  };
}

export async function storageWriteFile(args: ProviderArgs & {
  folder: string;
  name: string;
  content: string;
  mimeType?: string;
}) {
  logger.info(
    { provider: args.provider, connectorId: args.connector?.id, folder: args.folder, name: args.name, bytes: args.content.length },
    'storage_write_file_stub',
  );
  return {
    stub: true,
    provider: args.provider,
    fileId: `stub-${Date.now()}`,
    note: note(args, 'write_file'),
  };
}

export async function storageMoveFile(args: ProviderArgs & { fileId: string; destinationFolder: string }) {
  logger.info({ provider: args.provider, connectorId: args.connector?.id, fileId: args.fileId, destinationFolder: args.destinationFolder }, 'storage_move_file_stub');
  return {
    stub: true,
    provider: args.provider,
    fileId: args.fileId,
    destinationFolder: args.destinationFolder,
    note: note(args, 'move_file'),
  };
}
