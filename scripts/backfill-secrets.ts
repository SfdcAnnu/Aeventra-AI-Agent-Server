/**
 * Encrypt the credential columns that were written before ENCRYPTION_KEY
 * existed.
 *
 *   ENCRYPTION_KEY=<32 bytes> npx tsx scripts/backfill-secrets.ts [--dry]
 *
 * Safe to run against a live database, and safe to run twice. The read
 * path accepts plaintext and ciphertext alike, so rows convert one at a
 * time with the server still serving, and an already-sealed value is
 * skipped rather than sealed again — double-sealing would produce
 * something that decrypts to ciphertext, which nothing would notice until
 * a Salesforce call failed with a bearer nobody could explain.
 *
 * sessionKey is not touched. It is a lookup column, and a randomised
 * ciphertext cannot be looked up (see db/installs.repo.ts).
 */
import { PrismaClient } from '@prisma/client';
import { seal, isSealed, encryptionEnabled } from '../src/lib/secret-box';

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry');

async function main(): Promise<void> {
  if (!encryptionEnabled()) {
    console.error(
      'ENCRYPTION_KEY is not set, or is not 32 bytes (64 hex chars, or base64).\n' +
      'Nothing was changed — with no key this would rewrite every row as itself.',
    );
    process.exit(1);
  }
  console.log(DRY ? 'DRY RUN — nothing will be written\n' : 'Encrypting existing secrets\n');

  let installs = 0;
  for (const row of await prisma.orgInstall.findMany()) {
    const data: Record<string, string | null> = {};
    if (!isSealed(row.sfAccessToken)) data.sfAccessToken = seal(row.sfAccessToken);
    if (!isSealed(row.sfRefreshToken)) data.sfRefreshToken = seal(row.sfRefreshToken);
    if (Object.keys(data).length === 0) continue;
    installs++;
    if (!DRY) await prisma.orgInstall.update({ where: { orgId: row.orgId }, data });
  }
  console.log(`OrgInstall   ${installs} row(s) ${DRY ? 'would be' : ''} encrypted`);

  let connectors = 0;
  for (const row of await prisma.connector.findMany()) {
    const data: Record<string, string | null> = {};
    if (!isSealed(row.accessToken)) data.accessToken = seal(row.accessToken);
    if (!isSealed(row.refreshToken)) data.refreshToken = seal(row.refreshToken);
    if (!isSealed(row.apiKey)) data.apiKey = seal(row.apiKey);
    // A row whose secrets are all null has nothing to convert.
    if (Object.values(data).every(v => v === null)) continue;
    connectors++;
    if (!DRY) await prisma.connector.update({ where: { id: row.id }, data });
  }
  console.log(`Connector    ${connectors} row(s) ${DRY ? 'would be' : ''} encrypted`);

  console.log(
    '\nDone. Keep this key: without it these rows cannot be read, and the\n' +
    'server will report the connectors as not connected.',
  );
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => void prisma.$disconnect());
