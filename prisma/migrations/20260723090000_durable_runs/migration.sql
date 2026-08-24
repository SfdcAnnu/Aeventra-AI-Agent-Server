-- (diff tool again proposed dropping KbChunk_embedding_hnsw_idx here — not
-- tracked by Prisma since it's a hand-written vector index; intentionally skipped.)

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentApiName" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "recordId" TEXT,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "contextState" JSONB NOT NULL,
    "aliases" JSONB NOT NULL,
    "frontier" JSONB NOT NULL,
    "visited" JSONB NOT NULL,
    "resumeAt" TIMESTAMP(3),
    "approvalToken" TEXT,
    "approvalNodeId" TEXT,
    "timeoutAt" TIMESTAMP(3),
    "lastError" TEXT,
    "engineOverrideJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeSubType" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "RunStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_correlationId_key" ON "AgentRun"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_approvalToken_key" ON "AgentRun"("approvalToken");

-- CreateIndex
CREATE INDEX "AgentRun_orgId_agentApiName_idx" ON "AgentRun"("orgId", "agentApiName");

-- CreateIndex
CREATE INDEX "AgentRun_status_resumeAt_idx" ON "AgentRun"("status", "resumeAt");

-- CreateIndex
CREATE INDEX "RunStep_runId_idx" ON "RunStep"("runId");

-- AddForeignKey
ALTER TABLE "RunStep" ADD CONSTRAINT "RunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

