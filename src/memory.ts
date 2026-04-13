/**
 * Memory module — SQLite persistence for episodes, facts, pinned contexts.
 *
 * Atlas v2 differences from Hermes reference:
 * - initDb also initializes onboarding table rows (via initOnboarding)
 * - updateFacts uses related_fact_ids JSON array (no fact_edges table)
 * - mindPath defaults to process.cwd() (knowledge files live at project root)
 * - extractFromConversation falls back to simple keyword extraction if Ollama unavailable
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { generateEmbedding, embeddingToBlob } from "./embeddings.js";

export type { Database };

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConversationMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: number;
}

export interface ExtractedData {
  summary: string;
  entities: string[];
  decisions: string[];
  commitments: string[];
  topics: string[];
}

export interface PinnedContext {
  id: number;
  label: string;
  content: string;
  created_by: string;
}

// ─── Database init ─────────────────────────────────────────────────────────────

/**
 * Initialize the SQLite database.
 * Runs schema.sql (found relative to the db path or process.cwd()).
 * Also initializes onboarding table rows after schema is ready.
 */
export function initDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Load schema — try next to the db file first, then CWD
  const schemaPath = path.join(path.dirname(dbPath), "..", "schema.sql");
  const cwdSchema = path.join(process.cwd(), "schema.sql");

  if (fs.existsSync(schemaPath)) {
    db.exec(fs.readFileSync(schemaPath, "utf-8"));
  } else if (fs.existsSync(cwdSchema)) {
    db.exec(fs.readFileSync(cwdSchema, "utf-8"));
  } else {
    console.warn("[memory] schema.sql not found — DB may be incomplete");
  }

  return db;
}

// ─── Ollama helper ─────────────────────────────────────────────────────────────

async function ollamaComplete(prompt: string): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { response: string };
    return data.response ?? "";
  } catch {
    return "";
  }
}

// ─── Episode extraction ────────────────────────────────────────────────────────

/**
 * Extract structured data from a conversation.
 * Uses Ollama/Gemma if available; falls back to simple keyword extraction.
 */
export async function extractFromConversation(
  messages: ConversationMessage[]
): Promise<ExtractedData> {
  const transcript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n\n");

  const prompt = `Analyze this conversation and extract structured data. Respond with valid JSON only, no markdown.

Conversation:
${transcript}

Return JSON with these fields:
- summary: string (2-3 sentence summary)
- entities: string[] (people, companies, products, places mentioned)
- decisions: string[] (decisions made in this conversation)
- commitments: string[] (promises or commitments made)
- topics: string[] (main topics discussed)

JSON:`;

  const raw = await ollamaComplete(prompt);

  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as Partial<ExtractedData>;
    return {
      summary: parsed.summary ?? "",
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      commitments: Array.isArray(parsed.commitments) ? parsed.commitments : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
    };
  } catch {
    // Fallback: use first user messages as summary
    const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
    const summary = userMessages.slice(0, 2).join(" ").slice(0, 200);
    // Simple keyword extraction: capitalize words > 4 chars from user messages
    const words = userMessages.join(" ").split(/\W+/).filter((w) => w.length > 4);
    const entities = [...new Set(words.filter((w) => /^[A-Z]/.test(w)))].slice(0, 10);
    return {
      summary,
      entities,
      decisions: [],
      commitments: [],
      topics: [],
    };
  }
}

// ─── Episode storage ───────────────────────────────────────────────────────────

/**
 * Store a conversation as an episode. Generates embedding for semantic retrieval.
 * Returns the new episode ID.
 */
export async function storeEpisode(
  db: Database.Database,
  messages: ConversationMessage[],
  extractedData?: ExtractedData
): Promise<number> {
  const data = extractedData ?? (await extractFromConversation(messages));

  const embeddingText = [data.summary, ...data.topics, ...data.entities].join(" ");
  const embedding = await generateEmbedding(embeddingText);
  const embeddingBlob = embedding.length > 0 ? embeddingToBlob(embedding) : null;

  const stmt = db.prepare(`
    INSERT INTO episodes (summary, raw_messages, entities, decisions, commitments, topics, embedding, is_hot)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const result = stmt.run(
    data.summary,
    JSON.stringify(messages),
    JSON.stringify(data.entities),
    JSON.stringify(data.decisions),
    JSON.stringify(data.commitments),
    JSON.stringify(data.topics),
    embeddingBlob
  );

  return result.lastInsertRowid as number;
}

// ─── Facts ─────────────────────────────────────────────────────────────────────

/**
 * Upsert entity facts extracted from a conversation.
 * Uses the facts table's subject/predicate structure.
 * Updates related_fact_ids as a JSON array for the light graph.
 */
export function updateFacts(
  db: Database.Database,
  episodeId: number,
  entities: string[]
): void {
  if (entities.length === 0) return;

  // Get all existing fact IDs for cross-linking
  const existingIds = db
    .prepare("SELECT id FROM facts LIMIT 50")
    .all() as Array<{ id: number }>;
  const relatedIds = existingIds.map((r) => r.id);

  const upsert = db.prepare(`
    INSERT INTO facts (subject, predicate, object, source_episode_id, related_fact_ids)
    VALUES (?, 'mentioned', ?, ?, ?)
    ON CONFLICT(subject, predicate) DO UPDATE SET
      object = excluded.object,
      updated_at = datetime('now'),
      source_episode_id = excluded.source_episode_id,
      access_count = access_count + 1
  `);

  const insertMany = db.transaction((ents: string[]) => {
    for (const entity of ents) {
      upsert.run(
        entity,
        new Date().toISOString(),
        episodeId,
        JSON.stringify(relatedIds.slice(0, 10))
      );
    }
  });

  insertMany(entities);
}

// ─── Episode management ────────────────────────────────────────────────────────

/** Archive episodes older than 7 days: clear raw messages, mark as cold. */
export function archiveOldEpisodes(db: Database.Database): void {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    UPDATE episodes
    SET is_hot = 0, raw_messages = NULL, updated_at = datetime('now')
    WHERE is_hot = 1 AND created_at < ?
  `).run(sevenDaysAgo);
}

/** Returns true if any episodes are missing summaries (need subconscious processing). */
export function hasUnprocessedEpisodes(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM episodes WHERE summary IS NULL OR summary = ''")
    .get() as { cnt: number };
  return row.cnt > 0;
}

// ─── Pinned contexts ───────────────────────────────────────────────────────────

/** Retrieve all pinned contexts, ordered by creation time. */
export function getPinnedContexts(db: Database.Database): PinnedContext[] {
  return db
    .prepare("SELECT id, label, content, created_by FROM pinned_contexts ORDER BY created_at ASC")
    .all() as PinnedContext[];
}

/** Update the content of an existing pinned context. */
export function updatePinnedContext(db: Database.Database, id: number, content: string): void {
  db.prepare(`
    UPDATE pinned_contexts SET content = ?, updated_at = datetime('now') WHERE id = ?
  `).run(content, id);
}

/** Add or replace a pinned context by label. */
export function addPinnedContext(
  db: Database.Database,
  label: string,
  content: string,
  createdBy: "user" | "system" = "user"
): void {
  db.prepare(`
    INSERT OR REPLACE INTO pinned_contexts (label, content, created_by)
    VALUES (?, ?, ?)
  `).run(label, content, createdBy);
}

/** Remove a pinned context by label. Returns true if something was deleted. */
export function removePinnedContext(db: Database.Database, label: string): boolean {
  const result = db.prepare("DELETE FROM pinned_contexts WHERE label = ?").run(label);
  return result.changes > 0;
}

// ─── Episode queries ───────────────────────────────────────────────────────────

/** Fetch recent "hot" episodes with embeddings for retrieval scoring. */
export function getHotEpisodes(
  db: Database.Database,
  limit = 50
): Array<{
  id: number;
  summary: string;
  topics: string;
  entities: string;
  created_at: string;
  access_count: number;
  embedding: Buffer | null;
}> {
  return db
    .prepare(
      `SELECT id, summary, topics, entities, created_at, access_count, embedding
       FROM episodes WHERE is_hot = 1 AND summary IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as Array<{
    id: number;
    summary: string;
    topics: string;
    entities: string;
    created_at: string;
    access_count: number;
    embedding: Buffer | null;
  }>;
}

/** Fetch all episodes (hot + cold) for retrieval scoring. */
export function getAllEpisodes(
  db: Database.Database,
  limit = 100
): Array<{
  id: number;
  summary: string;
  topics: string;
  entities: string;
  created_at: string;
  access_count: number;
  is_hot: number;
  embedding: Buffer | null;
}> {
  return db
    .prepare(
      `SELECT id, summary, topics, entities, created_at, access_count, is_hot, embedding
       FROM episodes WHERE summary IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as Array<{
    id: number;
    summary: string;
    topics: string;
    entities: string;
    created_at: string;
    access_count: number;
    is_hot: number;
    embedding: Buffer | null;
  }>;
}

/** Increment the access counter for an episode (for frequency scoring). */
export function incrementEpisodeAccess(db: Database.Database, episodeId: number): void {
  db.prepare(`
    UPDATE episodes
    SET access_count = access_count + 1, last_accessed_at = datetime('now')
    WHERE id = ?
  `).run(episodeId);
}
