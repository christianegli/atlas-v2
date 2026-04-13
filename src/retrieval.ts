/**
 * Retrieval module — 5-signal hybrid retrieval over episodes, facts, and pinned contexts.
 *
 * Signals (weights configurable in program.md "Memory Retrieval Weights"):
 *   1. Vector similarity  — semantic match via Ollama embeddings
 *   2. Recency score      — exponential decay over time
 *   3. Entity match       — query tokens found in episode entities
 *   4. Access frequency   — logarithmic score for frequently accessed episodes
 *   5. Project relevance  — match against pinned context labels/content
 *
 * After initial scoring, a Gemma reranker pass reorders the top 15 candidates.
 * Results are trimmed to a token budget (pinned contexts are never trimmed).
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { generateEmbedding, cosineSimilarity, blobToEmbedding } from "./embeddings.js";
import {
  getPinnedContexts,
  getAllEpisodes,
  incrementEpisodeAccess,
  type PinnedContext,
} from "./memory.js";

export interface RetrievalResult {
  type: "episode" | "fact" | "pinned";
  id: number;
  content: string;
  score: number;
  source?: string;
}

interface RetrievalWeights {
  vector_similarity: number;
  recency_score: number;
  entity_match: number;
  access_frequency: number;
  project_relevance: number;
}

// ─── Weight loading ────────────────────────────────────────────────────────────

function loadWeightsFromProgram(mindPath: string): RetrievalWeights {
  const defaults: RetrievalWeights = {
    vector_similarity: 0.35,
    recency_score: 0.20,
    entity_match: 0.20,
    access_frequency: 0.10,
    project_relevance: 0.15,
  };

  try {
    const programPath = path.join(mindPath, "program.md");
    if (!fs.existsSync(programPath)) return defaults;

    const content = fs.readFileSync(programPath, "utf-8");
    const section = content.match(/## Memory Retrieval Weights\n([\s\S]*?)(?=\n##|\n$)/);
    if (!section) return defaults;

    const block = section[1];
    const parseWeight = (key: string): number => {
      const match = block.match(new RegExp(`${key}:\\s*([0-9.]+)`));
      return match ? parseFloat(match[1]) : NaN;
    };

    const w: RetrievalWeights = {
      vector_similarity: parseWeight("vector_similarity"),
      recency_score: parseWeight("recency_score"),
      entity_match: parseWeight("entity_match"),
      access_frequency: parseWeight("access_frequency"),
      project_relevance: parseWeight("project_relevance"),
    };

    if (Object.values(w).some((v) => isNaN(v))) return defaults;

    const total = Object.values(w).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1.0) > 0.05) return defaults;

    return w;
  } catch {
    return defaults;
  }
}

// ─── Scoring functions ─────────────────────────────────────────────────────────

/** Exponential decay: 1.0 at 0 days, ~0.5 at 7 days, ~0.1 at 30 days. */
function recencyScore(createdAt: string): number {
  const ageMs = Date.now() - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-0.1 * ageDays);
}

/** Fraction of episode entities found in the query (capped at 1.0 for 3+ matches). */
function entityMatchScore(query: string, entitiesJson: string): number {
  try {
    const entities: string[] = JSON.parse(entitiesJson);
    const queryLower = query.toLowerCase();
    let matches = 0;
    for (const entity of entities) {
      if (queryLower.includes(entity.toLowerCase())) matches++;
    }
    return Math.min(1, matches / 3);
  } catch {
    return 0;
  }
}

/** Logarithmic: higher access count → higher score, with diminishing returns. */
function accessFrequencyScore(accessCount: number): number {
  return Math.min(1, Math.log1p(accessCount) / Math.log1p(20));
}

/**
 * Project relevance: overlap between episode tokens and pinned context labels/content.
 * Uses simple token matching — no embedding needed.
 */
function projectRelevanceScore(
  episode: { topics: string; entities: string; summary: string },
  pinnedContexts: PinnedContext[]
): number {
  if (pinnedContexts.length === 0) return 0;

  const pinnedWords = new Set<string>();
  for (const pc of pinnedContexts) {
    pc.label
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 2)
      .forEach((w) => pinnedWords.add(w));
    pc.content
      .toLowerCase()
      .slice(0, 200)
      .split(/\W+/)
      .filter((w) => w.length > 3)
      .forEach((w) => pinnedWords.add(w));
  }

  const epTokens: string[] = [];
  try {
    (JSON.parse(episode.topics ?? "[]") as string[]).forEach((t) =>
      t.toLowerCase().split(/\W+/).filter((w) => w.length > 2).forEach((w) => epTokens.push(w))
    );
  } catch { /* ignore */ }
  try {
    (JSON.parse(episode.entities ?? "[]") as string[]).forEach((e) =>
      e.toLowerCase().split(/\W+/).filter((w) => w.length > 2).forEach((w) => epTokens.push(w))
    );
  } catch { /* ignore */ }
  episode.summary
    ?.toLowerCase()
    .slice(0, 300)
    .split(/\W+/)
    .filter((w) => w.length > 3)
    .forEach((w) => epTokens.push(w));

  if (epTokens.length === 0) return 0;

  let matches = 0;
  for (const token of epTokens) {
    if (pinnedWords.has(token)) matches++;
  }

  return Math.min(1, matches / Math.min(epTokens.length, 10));
}

// ─── Gemma reranker ────────────────────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";

/**
 * Use Gemma to reorder retrieval candidates by query relevance.
 * Falls back to the original order if Ollama is unavailable or parsing fails.
 */
async function rerankerPass(
  candidates: Array<{ episodeId: number; content: string; score: number }>,
  query: string
): Promise<Array<{ episodeId: number; content: string; score: number }>> {
  if (candidates.length <= 1) return candidates;

  const itemsText = candidates
    .map((c, i) => `id: ${i}, text: ${c.content.slice(0, 200)}`)
    .join("\n");

  const prompt = `Given this query: '${query}'
Rank these memory items by relevance (most relevant first). Return ONLY a JSON array of IDs in order.

Items:
${itemsText}

JSON array of IDs:`;

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) return candidates;

    const data = (await res.json()) as { response: string };
    const match = (data.response ?? "").match(/\[[\s\S]*?\]/);
    if (!match) return candidates;

    const ids = JSON.parse(match[0]) as number[];
    if (!Array.isArray(ids)) return candidates;

    const reordered: Array<{ episodeId: number; content: string; score: number }> = [];
    const used = new Set<number>();
    for (const id of ids) {
      if (typeof id === "number" && id >= 0 && id < candidates.length && !used.has(id)) {
        reordered.push(candidates[id]);
        used.add(id);
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      if (!used.has(i)) reordered.push(candidates[i]);
    }

    return reordered;
  } catch {
    return candidates;
  }
}

// ─── Token budget ──────────────────────────────────────────────────────────────

/**
 * Trim results to a token budget.
 * Pinned contexts are always included; episodic/fact results are trimmed last-in-first-out.
 */
function trimToTokenBudget(
  results: RetrievalResult[],
  pinnedIds: Set<number>,
  budgetTokens = 30000
): RetrievalResult[] {
  const roughTokens = (text: string): number => Math.ceil(text.length / 4);

  const pinned = results.filter((r) => r.type === "pinned" || pinnedIds.has(r.id));
  const rest = results.filter((r) => r.type !== "pinned" && !pinnedIds.has(r.id));

  let used = pinned.reduce((acc, r) => acc + roughTokens(r.content), 0);
  const kept: RetrievalResult[] = [...pinned];

  for (const r of rest) {
    const cost = roughTokens(r.content);
    if (used + cost > budgetTokens) break;
    kept.push(r);
    used += cost;
  }

  return kept;
}

// ─── Main retrieval function ───────────────────────────────────────────────────

/**
 * Retrieve relevant context for a given query using 5-signal hybrid scoring.
 *
 * @param db - SQLite database
 * @param query - The user query or topic to retrieve context for
 * @param k - Max number of episodic results to return (after reranking)
 * @param mindPath - Path to knowledge files (defaults to process.cwd())
 */
export async function retrieve(
  db: Database.Database,
  query: string,
  k = 10,
  mindPath?: string
): Promise<RetrievalResult[]> {
  const resolvedMindPath = mindPath ?? process.env.MIND_PATH ?? process.cwd();
  const weights = loadWeightsFromProgram(resolvedMindPath);

  const results: RetrievalResult[] = [];

  // Pinned contexts are always included at the top
  const pinned = getPinnedContexts(db);
  const pinnedIds = new Set<number>(pinned.map((p) => p.id));

  for (const p of pinned) {
    results.push({
      type: "pinned",
      id: p.id,
      content: `[${p.label}]\n${p.content}`,
      score: 1.0,
      source: "pinned",
    });
  }

  // Generate query embedding for vector similarity
  const queryEmbedding = await generateEmbedding(query);

  // Score all episodes
  const episodes = getAllEpisodes(db, 200);
  const scored: Array<{ episodeId: number; content: string; score: number }> = [];

  for (const ep of episodes) {
    if (!ep.summary) continue;

    let vectorSim = 0;
    if (queryEmbedding.length > 0 && ep.embedding) {
      vectorSim = cosineSimilarity(queryEmbedding, blobToEmbedding(ep.embedding));
    }

    const recency = recencyScore(ep.created_at);
    const entityMatch = entityMatchScore(query, ep.entities ?? "[]");
    const accessFreq = accessFrequencyScore(ep.access_count);
    const projRelevance = projectRelevanceScore(
      { topics: ep.topics ?? "[]", entities: ep.entities ?? "[]", summary: ep.summary ?? "" },
      pinned
    );

    const combined =
      weights.vector_similarity * vectorSim +
      weights.recency_score * recency +
      weights.entity_match * entityMatch +
      weights.access_frequency * accessFreq +
      weights.project_relevance * projRelevance;

    const topics = (() => {
      try {
        return (JSON.parse(ep.topics ?? "[]") as string[]).join(", ");
      } catch {
        return "";
      }
    })();

    scored.push({
      episodeId: ep.id,
      content: `[Episode ${ep.id} | ${ep.created_at.slice(0, 10)}]\n${ep.summary}${topics ? `\nTopics: ${topics}` : ""}`,
      score: combined,
    });
  }

  // Sort descending, take top 15 for reranker
  scored.sort((a, b) => b.score - a.score);
  const top15 = scored.slice(0, 15);

  // Reranker pass (gracefully skipped if Ollama unavailable)
  const reranked = await rerankerPass(top15, query);
  const topK = reranked.slice(0, k);

  for (const item of topK) {
    incrementEpisodeAccess(db, item.episodeId);
    results.push({
      type: "episode",
      id: item.episodeId,
      content: item.content,
      score: item.score,
      source: "episode",
    });
  }

  // Include relevant facts (entity match only — no embedding on facts table)
  const facts = db
    .prepare(
      `SELECT id, subject, predicate, object, updated_at
       FROM facts
       ORDER BY updated_at DESC
       LIMIT 20`
    )
    .all() as Array<{
    id: number;
    subject: string;
    predicate: string;
    object: string;
    updated_at: string;
  }>;

  const queryLower = query.toLowerCase();
  for (const fact of facts) {
    if (queryLower.includes(fact.subject.toLowerCase())) {
      results.push({
        type: "fact",
        id: fact.id,
        content: `[Fact] ${fact.subject}.${fact.predicate} = ${fact.object}`,
        score: 0.8,
        source: "fact",
      });
    }
  }

  // Final sort: pinned first, then by score
  results.sort((a, b) => {
    if (a.type === "pinned" && b.type !== "pinned") return -1;
    if (a.type !== "pinned" && b.type === "pinned") return 1;
    return b.score - a.score;
  });

  return trimToTokenBudget(results, pinnedIds, 30000);
}

/** Format retrieval results into a context block for the system prompt. */
export function buildContextString(results: RetrievalResult[]): string {
  if (results.length === 0) return "";

  const lines = ["--- Retrieved Context ---"];
  for (const r of results) {
    lines.push(r.content);
    lines.push("");
  }
  lines.push("--- End Context ---");
  return lines.join("\n");
}
