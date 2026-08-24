-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "authType" TEXT NOT NULL DEFAULT 'OAuth2',
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT,
    "instanceUrl" TEXT,
    "accountEmail" TEXT,
    "externalAccountId" TEXT,
    "apiKey" TEXT,
    "configuredBy" TEXT,
    "lastConnectedAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "configJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingOAuth" (
    "state" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "returnUrl" TEXT NOT NULL,
    "connectorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingOAuth_pkey" PRIMARY KEY ("state")
);

-- CreateTable
CREATE TABLE "OrgInstall" (
    "orgId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "sfAccessToken" TEXT NOT NULL,
    "sfRefreshToken" TEXT,
    "sfInstanceUrl" TEXT NOT NULL,
    "sfUserId" TEXT,
    "sfUserEmail" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT,
    "configuredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgInstall_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "PendingSetup" (
    "state" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "returnUrl" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingSetup_pkey" PRIMARY KEY ("state")
);

-- CreateIndex
CREATE INDEX "Connector_orgId_idx" ON "Connector"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Connector_orgId_providerKey_configuredBy_key" ON "Connector"("orgId", "providerKey", "configuredBy");

-- CreateIndex
CREATE INDEX "PendingOAuth_orgId_idx" ON "PendingOAuth"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgInstall_sessionKey_key" ON "OrgInstall"("sessionKey");

-- CreateIndex
CREATE INDEX "PendingSetup_orgId_idx" ON "PendingSetup"("orgId");

