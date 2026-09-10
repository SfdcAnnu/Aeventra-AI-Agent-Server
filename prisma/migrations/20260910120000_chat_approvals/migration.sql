-- Phase 7 — chat-mode approval-as-suspension (see prisma/schema.prisma ChatApproval)
CREATE TABLE "ChatApproval" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentApiName" TEXT NOT NULL,
    "planVersion" TEXT,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recordContextId" TEXT,
    "recordContextType" TEXT,
    "toolName" TEXT NOT NULL,
    "argsJson" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "resultText" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "timeoutAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChatApproval_orgId_status_idx" ON "ChatApproval"("orgId", "status");

CREATE INDEX "ChatApproval_orgId_sessionId_idx" ON "ChatApproval"("orgId", "sessionId");
