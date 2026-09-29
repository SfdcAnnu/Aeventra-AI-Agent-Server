-- Connections become principals: org (shared), group (a department's
-- account) or user (one person's own). Rows that exist are org
-- connections, except the per-user Salesforce ones, which were always a
-- person's own.
ALTER TABLE "Connector" ADD COLUMN "principalType" TEXT NOT NULL DEFAULT 'org';
ALTER TABLE "Connector" ADD COLUMN "subjectType" TEXT;
ALTER TABLE "Connector" ADD COLUMN "subjectKey" TEXT;
ALTER TABLE "Connector" ADD COLUMN "subjectLabel" TEXT;

UPDATE "Connector"
   SET "principalType" = 'user', "subjectType" = 'user', "subjectKey" = "configuredBy"
 WHERE "providerKey" = 'salesforce_mcp' AND "configuredBy" IS NOT NULL;

-- One admin may now own an org row, a group row and their own row for the
-- same provider: the old (org, provider, configuredBy) uniqueness no longer holds.
DROP INDEX IF EXISTS "Connector_orgId_providerKey_configuredBy_key";
CREATE INDEX "Connector_orgId_providerKey_principalType_subjectKey_idx"
    ON "Connector"("orgId", "providerKey", "principalType", "subjectKey");

CREATE TABLE "OrgIdentityPolicy" (
    "orgId" TEXT NOT NULL,
    "defaultRunAs" TEXT NOT NULL DEFAULT 'user',
    "defaultFallback" TEXT NOT NULL DEFAULT 'none',
    "blockOrgFallbackForChat" BOOLEAN NOT NULL DEFAULT true,
    "groupKeyType" TEXT NOT NULL DEFAULT 'permissionSet',
    "sfJwtEnabled" BOOLEAN NOT NULL DEFAULT false,
    "allowedDomainsJson" TEXT,
    "reminderEveryDays" INTEGER NOT NULL DEFAULT 3,
    "reminderMax" INTEGER NOT NULL DEFAULT 3,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrgIdentityPolicy_pkey" PRIMARY KEY ("orgId")
);

CREATE TABLE "ConnectorServerOverride" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "mcpServerUrl" TEXT NOT NULL,
    "authStyle" TEXT NOT NULL DEFAULT 'provider-token',
    "apiKey" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConnectorServerOverride_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConnectorServerOverride_orgId_providerKey_key" ON "ConnectorServerOverride"("orgId", "providerKey");

CREATE TABLE "ConnectionReminder" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentApiName" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConnectionReminder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConnectionReminder_orgId_providerKey_userId_key" ON "ConnectionReminder"("orgId", "providerKey", "userId");
