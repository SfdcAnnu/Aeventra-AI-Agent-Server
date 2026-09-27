-- PKCE on the org Setup and per-user Connect flows: the verifier waits
-- with the state until the code exchange. Nullable, so a flow already in
-- progress when this ships still completes.
ALTER TABLE "PendingSetup" ADD COLUMN "codeVerifier" TEXT;
ALTER TABLE "PendingOAuth" ADD COLUMN "codeVerifier" TEXT;
