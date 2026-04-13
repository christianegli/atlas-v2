/**
 * Stimulation module — subconscious creative and analytical processes.
 *
 * Six dream types:
 *   1. Memory replay       — find patterns across old episodes
 *   2. Cross-domain        — force analogies between different topic domains
 *   3. External            — process unread feed items for relevance
 *   4. Self-interrogation  — challenge own principles; red-team mode (30% of calls)
 *   5. Foresight           — predict failure modes and missed opportunities
 *   6. Narrative thread    — build project story arcs from episode history
 *
 * All outputs are scored, stored in the dreams table, and appended to dreams.md.
 * High-quality dreams (score >= 0.7) trigger notifications.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { getAllEpisodes, getPinnedContexts } from "./memory.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ollamaComplete(prompt: string): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { response: string };
    return data.response ?? "";
  } catch {
    return "";
  }
}

function safeReadFile(filePath: string): string {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
  } catch {
    return "";
  }
}

/** Append a dream entry to dreams.md (append-only). */
function appendToDreamsFile(mindPath: string, content: string): void {
  const dreamsPath = path.join(mindPath, "dreams.md");
  const existing = safeReadFile(dreamsPath);
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const newEntry = `\n## ${timestamp}\n${content}\n`;
  fs.writeFileSync(dreamsPath, existing + newEntry, "utf-8");
}

/** Ask Gemma to rate the quality of a dream (0.0 - 1.0). */
async function scoreDream(content: string): Promise<number> {
  const prompt = `Rate the quality and insight of this AI-generated reflection on a scale 0.0-1.0.
A high score (>0.7) means it contains a genuinely novel insight, connection, or actionable observation.
A low score (<0.3) means it's generic, obvious, or unhelpful.

Reflection:
${content.slice(0, 500)}

Respond with a single float between 0.0 and 1.0 only.`;

  const raw = await ollamaComplete(prompt);
  const score = parseFloat(raw.trim());
  if (isNaN(score)) return 0.5;
  return Math.max(0, Math.min(1, score));
}

/** Store a dream in the database and return its ID. */
function storeDream(
  db: Database.Database,
  dreamType: string,
  content: string,
  qualityScore: number,
  sourceIds: number[] = []
): number {
  const result = db
    .prepare(`
      INSERT INTO dreams (dream_type, content, quality_score, source_ids)
      VALUES (?, ?, ?, ?)
    `)
    .run(dreamType, content, qualityScore, JSON.stringify(sourceIds));
  return result.lastInsertRowid as number;
}

// ─── Dream types ──────────────────────────────────────────────────────────────

/**
 * Memory replay — surface patterns across 3 random old episodes.
 */
export async function runMemoryReplay(
  db: Database.Database,
  mindPath: string,
  notifyFn?: (content: string) => Promise<void>
): Promise<void> {
  const episodes = getAllEpisodes(db, 100);
  if (episodes.length < 2) return;

  const coldEpisodes = episodes.filter((e) => e.is_hot === 0);
  const pool = coldEpisodes.length >= 3 ? coldEpisodes : episodes;

  const selected: typeof episodes = [];
  const indices = new Set<number>();
  while (selected.length < Math.min(3, pool.length)) {
    const idx = Math.floor(Math.random() * pool.length);
    if (!indices.has(idx)) {
      indices.add(idx);
      selected.push(pool[idx]);
    }
  }

  const summaries = selected
    .map((e, i) => `Episode ${i + 1} (${e.created_at.slice(0, 10)}):\n${e.summary}`)
    .join("\n\n");

  const prompt = `You are reviewing old memories to find connections and patterns.

These are past conversation summaries:
${summaries}

Reflect on these memories:
1. What connections exist between them?
2. What pattern emerges across these conversations?
3. What insight does this suggest about the user's work or priorities?

Be specific and concrete. If there's nothing meaningful, say so briefly.`;

  const response = await ollamaComplete(prompt);
  if (!response || response.length < 50) return;

  const quality = await scoreDream(response);
  const sourceIds = selected.map((e) => e.id);

  storeDream(db, "replay", response, quality, sourceIds);
  appendToDreamsFile(mindPath, `[Memory Replay]\n${response}`);

  if (quality >= 0.7 && notifyFn) {
    await notifyFn(`[subconscious] Memory replay insight:\n${response.slice(0, 500)}`);
  }
}

/**
 * Cross-domain collision — force an analogy between two different topic domains.
 */
export async function runCrossDomainCollision(
  db: Database.Database,
  mindPath: string,
  notifyFn?: (content: string) => Promise<void>
): Promise<void> {
  const episodes = getAllEpisodes(db, 100);
  if (episodes.length < 4) return;

  const episodesWithTopics = episodes.filter((e) => e.topics && e.topics !== "[]");
  if (episodesWithTopics.length < 2) return;

  const domains = new Map<string, typeof episodes>();
  for (const ep of episodesWithTopics) {
    try {
      const topics = JSON.parse(ep.topics) as string[];
      const domain = topics[0] ?? "general";
      if (!domains.has(domain)) domains.set(domain, []);
      domains.get(domain)!.push(ep);
    } catch { continue; }
  }

  const domainKeys = Array.from(domains.keys());
  if (domainKeys.length < 2) return;

  const domainA = domainKeys[Math.floor(Math.random() * domainKeys.length)];
  let domainB = domainKeys[Math.floor(Math.random() * domainKeys.length)];
  while (domainB === domainA && domainKeys.length > 1) {
    domainB = domainKeys[Math.floor(Math.random() * domainKeys.length)];
  }

  const epA = domains.get(domainA)![0];
  const epB = domains.get(domainB)![0];

  const prompt = `Force a creative connection between two different domains.

Domain A (${domainA}): ${epA.summary}

Domain B (${domainB}): ${epB.summary}

Find a non-obvious structural similarity or transferable insight between these.
What does Domain A teach us about Domain B? Be specific and concrete.
Start directly with the insight, no preamble.

After your analysis, format the conclusion as:
## Analogy
[what Domain A teaches about Domain B]
## Tension
[where the analogy breaks down]
## Actionable implication
[what should be done differently]`;

  const response = await ollamaComplete(prompt);
  if (!response || response.length < 50) return;

  const quality = await scoreDream(response);
  storeDream(db, "collision", response, quality, [epA.id, epB.id]);
  appendToDreamsFile(mindPath, `[Cross-Domain: ${domainA} × ${domainB}]\n${response}`);

  if (quality >= 0.7 && notifyFn) {
    await notifyFn(`[subconscious] Cross-domain insight (${domainA} × ${domainB}):\n${response.slice(0, 500)}`);
  }
}

/**
 * External stimulation — process unread feed items for relevance and insight.
 */
export async function runExternalStimulation(
  db: Database.Database,
  mindPath: string,
  notifyFn?: (content: string) => Promise<void>
): Promise<void> {
  const unprocessed = db
    .prepare(
      `SELECT id, title, content, summary, feed_name, category
       FROM feed_items WHERE processed = 0 ORDER BY created_at DESC LIMIT 5`
    )
    .all() as Array<{
    id: number;
    title: string;
    content: string | null;
    summary: string | null;
    feed_name: string;
    category: string;
  }>;

  if (unprocessed.length === 0) return;

  const pinned = getPinnedContexts(db);
  const projectContext = pinned.map((p) => p.label).join(", ") || "general work";

  for (const item of unprocessed) {
    const text = item.content ?? item.summary ?? item.title;

    const prompt = `You are analyzing a news/blog item for relevance to someone working on: ${projectContext}.

Article: "${item.title}" from ${item.feed_name}
${text.slice(0, 1000)}

1. Relevance score (0.0-1.0) to the user's work
2. Key insight or implication (2-3 sentences)
3. Action item if relevant (or "none")

Respond as JSON: {"relevance": 0.0, "insight": "...", "action": "..."}`;

    const raw = await ollamaComplete(prompt);

    let relevance = 0.3;
    let insight = "";
    let action = "none";

    try {
      const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned) as { relevance: number; insight: string; action: string };
      relevance = parsed.relevance ?? 0.3;
      insight = parsed.insight ?? "";
      action = parsed.action ?? "none";
    } catch {
      insight = raw.slice(0, 300);
    }

    db.prepare("UPDATE feed_items SET processed = 1, relevance_score = ? WHERE id = ?").run(relevance, item.id);

    if (relevance >= 0.5 && insight) {
      const content = `Feed: ${item.feed_name}\nTitle: ${item.title}\nInsight: ${insight}${action !== "none" ? `\nAction: ${action}` : ""}`;
      storeDream(db, "external", content, relevance, []);
      appendToDreamsFile(mindPath, `[External: ${item.feed_name}]\n${content}`);

      if (relevance >= 0.7 && notifyFn) {
        await notifyFn(`[subconscious] Feed insight from ${item.feed_name}:\n${content.slice(0, 500)}`);
      }
    }
  }
}

/**
 * Self-interrogation — challenge own principles.
 * 30% of calls use red-team mode: look for internal contradictions in program.md.
 */
export async function runSelfInterrogation(
  db: Database.Database,
  mindPath: string,
  notifyFn?: (content: string) => Promise<void>
): Promise<void> {
  const isRedTeam = Math.random() < 0.30;

  if (isRedTeam) {
    const programPath = path.join(mindPath, "program.md");
    const programContent = safeReadFile(programPath);
    if (!programContent) return;

    const prompt = `Read these agent instructions and find edge cases, loopholes, or internal contradictions.
For each issue found, propose a specific fix.

${programContent.slice(0, 3000)}`;

    const response = await ollamaComplete(prompt);
    if (!response || response.length < 50) return;

    const hasFix = /\b(fix|change|update|replace|add|remove|should be|instead)\b/i.test(response);

    if (hasFix) {
      const proposedPath = path.join(mindPath, "proposed_code_changes.md");
      const existing = safeReadFile(proposedPath);
      const timestamp = new Date().toISOString();
      const entry = [
        `\n## ${timestamp} — program.md (red-team)`,
        `**Hypothesis:** Red-team self-interrogation found issues`,
        `**Triggered by:** self-interrogation (red-team)`,
        `**Status:** pending`,
        ``,
        response,
        ``,
        `---`,
        ``,
      ].join("\n");
      fs.writeFileSync(proposedPath, existing + entry, "utf-8");
    } else {
      const hasSpecifics = /\d|[A-Z][a-z]+\s[A-Z]/.test(response);
      const quality = hasSpecifics ? 0.65 : 0.4;
      storeDream(db, "interrogation", `[Red-team]\n${response}`, quality, []);
      appendToDreamsFile(mindPath, `[Self-Interrogation (Red-team)]\n${response}`);
      if (quality >= 0.7 && notifyFn) {
        await notifyFn(`[subconscious] Red-team finding:\n${response.slice(0, 400)}`);
      }
    }
    return;
  }

  // Normal self-interrogation from stimuli.md
  const stimuliPath = path.join(mindPath, "stimuli.md");
  const stimuliContent = safeReadFile(stimuliPath);
  if (!stimuliContent) return;

  const stimuli = stimuliContent
    .split("\n")
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => l.replace(/^- /, "").trim())
    .filter((l) => l.length > 10);

  if (stimuli.length === 0) return;

  const stimulus = stimuli[Math.floor(Math.random() * stimuli.length)];
  const principles = safeReadFile(path.join(mindPath, "principles.md"));
  const blindspots = safeReadFile(path.join(mindPath, "blindspots.md"));

  const prompt = `You are an AI agent challenging your own principles and assumptions.

Question to confront: "${stimulus}"

Your current principles:
${principles.slice(0, 1000)}

Your known blindspots:
${blindspots.slice(0, 500)}

Answer the question honestly. If it reveals a weakness or contradiction in your principles, name it explicitly.
Be direct and specific. No hedging.`;

  const response = await ollamaComplete(prompt);
  if (!response || response.length < 50) return;

  const quality = await scoreDream(response);
  storeDream(db, "interrogation", response, quality, []);
  appendToDreamsFile(mindPath, `[Self-Interrogation]\nQ: ${stimulus}\n\n${response}`);

  if (quality >= 0.7 && notifyFn) {
    await notifyFn(`[subconscious] Self-interrogation:\nQ: ${stimulus}\n\n${response.slice(0, 400)}`);
  }
}

/**
 * Foresight — predict the most likely failure mode or missed opportunity in the next 14 days.
 * Always surfaces if Ollama produces a response (quality hardcoded to 0.75).
 */
export async function runForesight(
  db: Database.Database,
  mindPath: string,
  notifyFn?: (msg: string) => Promise<void>
): Promise<void> {
  const pinned = getPinnedContexts(db);
  const pinnedText = pinned.map((p) => `[${p.label}]\n${p.content}`).join("\n\n");

  const principles = safeReadFile(path.join(mindPath, "principles.md"));
  const blindspots = safeReadFile(path.join(mindPath, "blindspots.md"));

  const prompt = `Given these active projects, principles, and known blindspots:

${pinnedText.slice(0, 1500)}

PRINCIPLES:
${principles.slice(0, 600)}

BLINDSPOTS:
${blindspots.slice(0, 400)}

Answer two questions:
1. What is the most likely failure mode or missed opportunity in the next 14 days?
2. What specific follow-up action or commitment is most at risk of being missed?

Be specific. Name names, dates, amounts where relevant.`;

  const response = await ollamaComplete(prompt);
  if (!response || response.length < 50) return;

  const quality = 0.75;
  storeDream(db, "foresight", response, quality, []);
  appendToDreamsFile(mindPath, `[Foresight]\n${response}`);

  if (notifyFn) {
    await notifyFn(`[subconscious] Foresight:\n${response.slice(0, 500)}`);
  }
}

/**
 * Narrative thread — create a "project story so far" from 90 days of episodes.
 * Targets the pinned context that hasn't had a narrative update in 30 days.
 */
export async function runNarrativeThread(
  db: Database.Database,
  mindPath: string,
  notifyFn?: (msg: string) => Promise<void>
): Promise<void> {
  const pinned = getPinnedContexts(db);
  if (pinned.length === 0) return;

  let targetContext: typeof pinned[0] | null = null;

  for (const pc of pinned) {
    try {
      const row = db
        .prepare(
          `SELECT id FROM dreams
           WHERE dream_type = 'narrative_thread'
             AND content LIKE ?
             AND created_at >= datetime('now', '-30 days')
           LIMIT 1`
        )
        .get(`%${pc.label}%`) as { id: number } | undefined;

      if (!row) {
        targetContext = pc;
        break;
      }
    } catch {
      targetContext = pc;
      break;
    }
  }

  if (!targetContext) return;

  const projectName = targetContext.label;

  const episodes = db
    .prepare(
      `SELECT id, summary, created_at, topics, entities
       FROM episodes
       WHERE created_at >= datetime('now', '-90 days')
         AND (topics LIKE ? OR entities LIKE ? OR summary LIKE ?)
       ORDER BY created_at ASC LIMIT 20`
    )
    .all(`%${projectName}%`, `%${projectName}%`, `%${projectName}%`) as Array<{
    id: number;
    summary: string | null;
    created_at: string;
    topics: string | null;
    entities: string | null;
  }>;

  const summaries = episodes
    .filter((e) => e.summary)
    .map((e) => `${e.created_at.slice(0, 10)}: ${e.summary}`)
    .join("\n\n");

  if (!summaries) return;

  const prompt = `Create a "project story so far" for: ${projectName}

Based on these conversation summaries:
${summaries.slice(0, 3000)}

Cover:
- Key decisions made
- Current state
- Open questions
- Next milestones

Keep it under 500 words. Be specific.`;

  const response = await ollamaComplete(prompt);
  if (!response || response.length < 50) return;

  const content = `[Project: ${projectName}]\n\n${response}`;
  storeDream(db, "narrative_thread", content, 0.8, episodes.map((e) => e.id));
  appendToDreamsFile(mindPath, `[Narrative Thread: ${projectName}]\n${response}`);

  if (notifyFn) {
    await notifyFn(`[narrative] Project story updated: ${projectName}\n${response.slice(0, 400)}`);
  }
}
