/**
 * Embeddings module — Ollama-backed vector generation and similarity math.
 *
 * Gracefully degrades when Ollama is unavailable: returns empty arrays
 * and logs a one-time warning. The rest of the system continues without
 * semantic search — falling back to recency + entity matching.
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";

/** Cached availability check — null means not yet tested. */
let ollamaAvailable: boolean | null = null;

/**
 * Check if Ollama is reachable. Result is cached after the first check.
 */
export async function checkOllamaAvailable(): Promise<boolean> {
  if (ollamaAvailable !== null) return ollamaAvailable;
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    ollamaAvailable = res.ok;
  } catch {
    ollamaAvailable = false;
    console.warn(
      "[embeddings] Ollama not available at",
      OLLAMA_BASE_URL,
      "— embeddings disabled, falling back to keyword retrieval"
    );
  }
  return ollamaAvailable;
}

/**
 * Generate an embedding vector for the given text.
 * Returns an empty array if Ollama is unavailable or the request fails.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const available = await checkOllamaAvailable();
  if (!available) return [];

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      console.warn("[embeddings] Ollama embeddings request failed:", res.status);
      return [];
    }

    const data = (await res.json()) as { embedding: number[] };
    return data.embedding ?? [];
  } catch (err) {
    console.warn("[embeddings] Error generating embedding:", err);
    return [];
  }
}

/**
 * Cosine similarity between two vectors.
 * Returns 0 if either vector is empty or they have different lengths.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/** Serialize a float array for SQLite BLOB storage. */
export function embeddingToBlob(embedding: number[]): Buffer {
  const arr = new Float32Array(embedding);
  return Buffer.from(arr.buffer);
}

/** Deserialize a SQLite BLOB back to a float array. */
export function blobToEmbedding(blob: Buffer): number[] {
  const arr = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(arr);
}
