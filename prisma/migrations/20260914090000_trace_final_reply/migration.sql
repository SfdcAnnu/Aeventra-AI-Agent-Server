-- The reply the customer actually saw.
--
-- A turn can rewrite its answer after the model produces it: a guardrail
-- regeneration replaces it with a second model call, and the mechanical
-- scrub edits the text after every model call has finished. So the final
-- wording is not always present in any recorded step, and a reader
-- comparing the last step against the UI finds two different answers with
-- nothing to explain the gap.

ALTER TABLE "AgentTrace" ADD COLUMN "finalReply" TEXT;
