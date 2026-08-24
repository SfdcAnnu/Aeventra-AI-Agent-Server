-- Enable pgvector (already present on the live DB — kept here so a fresh
-- environment provisions correctly too).
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "KbStorageConfig" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "backend" TEXT NOT NULL DEFAULT 'archon',
    "connectionUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KbStorageConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbDocument" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentApiName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'upload',
    "status" TEXT NOT NULL DEFAULT 'Indexing',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KbDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "agentApiName" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),

    CONSTRAINT "KbChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KbStorageConfig_orgId_key" ON "KbStorageConfig"("orgId");

-- CreateIndex
CREATE INDEX "KbDocument_orgId_agentApiName_idx" ON "KbDocument"("orgId", "agentApiName");

-- CreateIndex
CREATE INDEX "KbChunk_orgId_agentApiName_idx" ON "KbChunk"("orgId", "agentApiName");

-- AddForeignKey
ALTER TABLE "KbChunk" ADD CONSTRAINT "KbChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KbDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- HNSW index for fast cosine-distance search — Prisma doesn't manage
-- vector indexes itself, hand-written here. Skips org filtering (fine at
-- MVP scale; Postgres will still use the index and post-filter by orgId).
CREATE INDEX "KbChunk_embedding_hnsw_idx" ON "KbChunk" USING hnsw ("embedding" vector_cosine_ops);
