-- AlterTable
-- (the diff tool also proposed dropping KbChunk_embedding_hnsw_idx here —
-- that's Prisma not knowing about the hand-written HNSW index from the
-- previous migration; intentionally NOT dropping it.)
ALTER TABLE "KbDocument" ADD COLUMN "rawText" TEXT;

