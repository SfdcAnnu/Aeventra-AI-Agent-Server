/**
 * Pluggable KB storage — an org picks ONE backend (KbStorageConfig.backend)
 * and every document for that org indexes/retrieves through it. See
 * schema.prisma's KB models comment block for what each backend actually
 * stores and where.
 */
export interface KbChunkInput {
  chunkIndex: number;
  content: string;
  /** Absent when the backend doesn't use embeddings (e.g. salesforce/SOSL). */
  embedding?: number[];
}

export interface KbRetrievedChunk {
  content: string;
  documentTitle: string;
  /** Backend-specific relevance signal (cosine similarity, SOSL rank, ...) — informational only. */
  score?: number;
}

export interface KbBackend {
  /** True if this backend needs vectors computed before indexDocument/retrieve are called. */
  readonly usesEmbeddings: boolean;

  /** Replaces all chunks for one document (delete-then-insert semantics). */
  indexDocument(args: {
    orgId: string;
    agentApiName: string;
    documentId: string;
    documentTitle: string;
    chunks: KbChunkInput[];
  }): Promise<void>;

  deleteDocument(args: { orgId: string; documentId: string }): Promise<void>;

  retrieve(args: {
    orgId: string;
    agentApiName: string;
    query: string;
    queryEmbedding?: number[];
    k: number;
  }): Promise<KbRetrievedChunk[]>;
}
