/**
 * Fetch attachment bytes from the customer's Salesforce Files.
 *
 * Optimizations:
 *   • Fast-return [] when refs is empty — zero SF work.
 *   • LWC passes contentVersionId + metadata captured at upload time, so we
 *     skip the SOQL lookup entirely on the common path.
 *   • Primary download uses the Shepherd servlet (/sfc/servlet.shepherd/...)
 *     which does NOT count against the org's REST API 24-hour bucket.
 *   • Falls back to /services/data/.../VersionData if Shepherd 4xx's (rare —
 *     restricted orgs where the servlet is disabled).
 *   • Binary fetches run in parallel (Promise.all) so 5 files ≈ time of the
 *     single slowest file, not 5× the slowest.
 */
import { logger } from '../../logger';
import { getOrgConnection } from '../../salesforce/per-org-connection';
import { InstallsCache } from '../../db/installs-cache';

export interface AttachmentRef {
  contentDocumentId: string;
  contentVersionId?: string;
  fileName?:         string;
  mimeType?:         string;
  fileType?:         string;
  fileExtension?:    string;
}

export interface LoadedAttachment {
  contentDocumentId: string;
  fileName:          string;
  mimeType:          string;
  base64:            string;
  kind:              'image' | 'pdf' | 'text' | 'other';
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const TEXT_EXTS  = new Set(['txt', 'csv', 'md', 'log', 'json']);

export async function loadAttachments(
  orgId: string,
  refs:  AttachmentRef[],
): Promise<LoadedAttachment[]> {
  if (!refs || refs.length === 0) return [];

  const t0 = Date.now();

  // ── Resolve any refs that are missing versionId (unusual — LWC captures both) ──
  // We only pay for a SOQL call if some refs are missing versionId.
  const needsLookup = refs.filter(r => !r.contentVersionId);
  let byDocId: Map<string, { versionId: string; title?: string; ext?: string }> = new Map();

  if (needsLookup.length > 0) {
    const conn = await getOrgConnection(orgId);
    const idList = needsLookup.map(r => `'${escapeSoql(r.contentDocumentId)}'`).join(',');
    const versions = await conn.query<{
      Id: string;
      ContentDocumentId: string;
      Title: string;
      FileExtension: string;
    }>(`SELECT Id, ContentDocumentId, Title, FileExtension
        FROM ContentVersion
        WHERE ContentDocumentId IN (${idList}) AND IsLatest = true`);
    byDocId = new Map(versions.records.map(v => [v.ContentDocumentId, {
      versionId: v.Id,
      title:     v.Title,
      ext:       v.FileExtension,
    }]));
  }

  // Reads from RAM after the first request per org (see InstallsCache).
  const install = await InstallsCache.findByOrgId(orgId);
  if (!install?.sfInstanceUrl || !install?.sfAccessToken) {
    logger.warn({ orgId }, 'attachments_no_install');
    return [];
  }
  const instanceUrl = install.sfInstanceUrl.replace(/\/+$/, '');
  const bearer = install.sfAccessToken;

  // ── Parallel downloads via Shepherd (falls back to REST on 4xx) ──
  const settled = await Promise.all(refs.map(async (ref): Promise<LoadedAttachment | null> => {
    const looked = byDocId.get(ref.contentDocumentId);
    const versionId = ref.contentVersionId ?? looked?.versionId;
    if (!versionId) {
      logger.warn({ orgId, cdId: ref.contentDocumentId }, 'attachment_no_version');
      return null;
    }
    const fileName = ref.fileName ?? looked?.title ?? 'file';
    const ext = (ref.fileExtension || looked?.ext || (fileName.split('.').pop() ?? '')).toLowerCase();
    const kind = classifyKind(ext);
    const mimeType = ref.mimeType && ref.mimeType !== 'application/octet-stream' ? ref.mimeType : mimeFor(ext);

    try {
      const buf = await downloadWithFallback(instanceUrl, versionId, bearer);
      return {
        contentDocumentId: ref.contentDocumentId,
        fileName,
        mimeType,
        base64:            buf.toString('base64'),
        kind,
      };
    } catch (err) {
      logger.error({ err, orgId, cdId: ref.contentDocumentId, versionId }, 'attachment_fetch_failed');
      return null;
    }
  }));

  const loaded = settled.filter((x): x is LoadedAttachment => x !== null);
  logger.info({
    orgId,
    requested:      refs.length,
    loaded:         loaded.length,
    soqlUsed:      needsLookup.length > 0,
    ms:            Date.now() - t0,
  }, 'attachments_loaded');
  return loaded;
}

/**
 * Try Shepherd first (no API-limit cost). Fall back to REST if it fails,
 * so restricted orgs where the servlet is disabled still work.
 */
async function downloadWithFallback(
  instanceUrl: string,
  versionId:   string,
  bearer:      string,
): Promise<Buffer> {
  const shepherd = `${instanceUrl}/sfc/servlet.shepherd/version/download/${versionId}`;
  let res = await fetch(shepherd, {
    method:   'GET',
    headers:  { Authorization: `Bearer ${bearer}` },
    redirect: 'follow',
  });
  if (!res.ok) {
    // Fall back to REST — costs 1 API-limit unit but always available.
    logger.warn({ status: res.status, versionId }, 'shepherd_download_failed_falling_back');
    const rest = `${instanceUrl}/services/data/v62.0/sobjects/ContentVersion/${versionId}/VersionData`;
    res = await fetch(rest, {
      method:  'GET',
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!res.ok) throw new Error(`REST /VersionData failed: ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function classifyKind(ext: string): LoadedAttachment['kind'] {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'pdf')       return 'pdf';
  if (TEXT_EXTS.has(ext))  return 'text';
  return 'other';
}

function mimeFor(ext: string): string {
  switch (ext) {
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'pdf':  return 'application/pdf';
    case 'csv':  return 'text/csv';
    case 'md':   return 'text/markdown';
    case 'json': return 'application/json';
    case 'txt':
    case 'log':  return 'text/plain';
    default:     return 'application/octet-stream';
  }
}

function escapeSoql(v: string): string {
  return String(v).replace(/['\\]/g, '');
}
