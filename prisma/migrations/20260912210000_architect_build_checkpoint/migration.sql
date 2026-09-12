-- Resumable Architect builds.
--
-- A build spends real money across seven stages. Until now its stage
-- outputs lived only in process memory, so hitting the budget ceiling (or a
-- host restart) discarded work that had already been paid for and the next
-- run started from zero. This table is the checkpoint that makes a build
-- resumable.

CREATE TABLE "ArchitectBuild" (
    "id"             TEXT NOT NULL,
    "orgId"          TEXT NOT NULL,
    "requirement"    TEXT NOT NULL,
    "attachmentText" TEXT,
    "status"         TEXT NOT NULL DEFAULT 'queued',
    "steps"          JSONB NOT NULL,
    "checkpoint"     JSONB,
    "costUsd"        DOUBLE PRECISION NOT NULL DEFAULT 0,
    "priorCostUsd"   DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxCostUsd"     DOUBLE PRECISION NOT NULL DEFAULT 2,
    "resumedFrom"    TEXT,
    "result"         JSONB,
    "error"          TEXT,
    "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt"     TIMESTAMP(3),
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ArchitectBuild_pkey" PRIMARY KEY ("id")
);

-- The Builds list: an org's builds, newest first.
CREATE INDEX "ArchitectBuild_orgId_startedAt_idx" ON "ArchitectBuild"("orgId", "startedAt");

-- "What can I resume?" — paused builds for one org.
CREATE INDEX "ArchitectBuild_orgId_status_idx" ON "ArchitectBuild"("orgId", "status");
