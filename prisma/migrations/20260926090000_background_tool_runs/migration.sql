-- Background tool runs: a write the agent queued instead of waiting for.
--
-- Every tool call used to block the turn. A tool marked "run in the
-- background" is queued here -- per session, in order -- and answers the
-- model at once; a worker runs it right after the reply and records the
-- outcome. The next turn waits for this session's pending rows before it
-- reads the record, and reports finished outcomes to the model once
-- (reportedAt), so a failed write is corrected in the next reply.

CREATE TABLE "BackgroundToolRun" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "agentApiName" TEXT NOT NULL,
    "recordContextId" TEXT,
    "recordContextType" TEXT,
    "tool" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "result" TEXT,
    "error" TEXT,
    "ms" INTEGER,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3),

    CONSTRAINT "BackgroundToolRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BackgroundToolRun_sessionId_queuedAt_idx" ON "BackgroundToolRun"("sessionId", "queuedAt");
CREATE INDEX "BackgroundToolRun_orgId_status_idx" ON "BackgroundToolRun"("orgId", "status");
