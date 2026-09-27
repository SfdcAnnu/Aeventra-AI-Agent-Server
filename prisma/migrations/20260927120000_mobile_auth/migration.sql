-- Mobile app auth: server-brokered OAuth sessions and PKCE pending records.
CREATE TABLE "MobileSession" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "username" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MobileSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MobileSession_orgId_userId_idx" ON "MobileSession"("orgId", "userId");

CREATE TABLE "MobileAuthPending" (
    "state" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "loginHost" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MobileAuthPending_pkey" PRIMARY KEY ("state")
);
