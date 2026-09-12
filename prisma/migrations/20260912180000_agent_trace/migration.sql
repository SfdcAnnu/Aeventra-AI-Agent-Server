-- Agent tracing: one row per turn, one child row per model/tool call.
-- Internal only; read through /api/admin/traces behind ADMIN_API_KEY.

CREATE TABLE "AgentTrace" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orgId" TEXT NOT NULL,
    "userId" TEXT,
    "agentApiName" TEXT NOT NULL,
    "agentId" TEXT,
    "agentName" TEXT,
    "sessionId" TEXT,
    "correlationId" TEXT,
    "recordId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'chat',
    "status" TEXT NOT NULL DEFAULT 'complete',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "modelCalls" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "usageByModel" JSONB,
    "payloadsPurgedAt" TIMESTAMP(3),

    CONSTRAINT "AgentTrace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentTraceStep" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "requestJson" JSONB,
    "requestParts" JSONB,
    "responseJson" JSONB,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "cacheRead" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "isError" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentTraceStep_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentTrace_orgId_createdAt_idx" ON "AgentTrace"("orgId", "createdAt");
CREATE INDEX "AgentTrace_orgId_agentApiName_createdAt_idx" ON "AgentTrace"("orgId", "agentApiName", "createdAt");
CREATE INDEX "AgentTrace_orgId_userId_createdAt_idx" ON "AgentTrace"("orgId", "userId", "createdAt");
CREATE INDEX "AgentTrace_orgId_status_createdAt_idx" ON "AgentTrace"("orgId", "status", "createdAt");
CREATE INDEX "AgentTrace_sessionId_idx" ON "AgentTrace"("sessionId");
CREATE INDEX "AgentTrace_correlationId_idx" ON "AgentTrace"("correlationId");
-- Drives the retention sweep, which scans by age across every org.
CREATE INDEX "AgentTrace_createdAt_idx" ON "AgentTrace"("createdAt");

CREATE INDEX "AgentTraceStep_traceId_seq_idx" ON "AgentTraceStep"("traceId", "seq");

-- Cascade: purging a trace takes its steps with it, so a filtered delete
-- from the console never leaves orphaned payloads behind.
ALTER TABLE "AgentTraceStep"
    ADD CONSTRAINT "AgentTraceStep_traceId_fkey"
    FOREIGN KEY ("traceId") REFERENCES "AgentTrace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
