-- Adds per-node input capture and a human-readable label to RunStep, so a
-- run's node-by-node trace can be shown in Salesforce (was output-only before).
ALTER TABLE "RunStep" ADD COLUMN "input" JSONB;
ALTER TABLE "RunStep" ADD COLUMN "nodeLabel" TEXT;
