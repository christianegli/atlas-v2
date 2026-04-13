/**
 * Onboarding module — progressive knowledge acquisition during early conversations.
 *
 * Atlas starts empty. This module tracks what it still needs to learn about
 * the principal and surfaces 1-2 questions per conversation until the
 * knowledge base is meaningfully populated.
 *
 * Completion criteria (from onboarding.md):
 *   - All Tier 1 questions answered
 *   - At least 3 Tier 2 questions answered
 *   - At least 1 Tier 3 question answered
 *
 * Answers are written immediately to the appropriate target file and stored
 * as facts in the database. Questions feel like a colleague getting to know
 * you, not an intake form.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { addPinnedContext } from "./memory.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OnboardingQuestion {
  id: string;
  question: string;
  tier: 1 | 2 | 3;
  targetFile: string;
}

// ─── Question bank ─────────────────────────────────────────────────────────────

/**
 * Full onboarding question bank, ordered by tier (impact priority).
 * Source: onboarding.md
 */
export const QUESTION_BANK: OnboardingQuestion[] = [
  // Tier 1 — Foundation
  { id: "name",            question: "What should I call you?",                                           tier: 1, targetFile: "preferences.md" },
  { id: "timezone",        question: "What timezone are you in?",                                         tier: 1, targetFile: "preferences.md" },
  { id: "language",        question: "What language do you want to work in by default?",                   tier: 1, targetFile: "preferences.md" },
  { id: "primary_project", question: "What's the most important thing you're working on right now?",       tier: 1, targetFile: "program.md"     },
  { id: "primary_goal",    question: "What does success look like for that in the next 90 days?",          tier: 1, targetFile: "program.md"     },

  // Tier 2 — Working style
  { id: "output_pref",        question: "Do you prefer complete drafts or rough outlines to react to?",    tier: 2, targetFile: "preferences.md" },
  { id: "decision_filter",    question: "How do you decide what to work on? Any rule of thumb?",           tier: 2, targetFile: "preferences.md" },
  { id: "tone",               question: "How direct do you want me to be — pull no punches, or read the room?", tier: 2, targetFile: "preferences.md" },
  { id: "emoji_policy",       question: "Emojis: yes, no, or context-dependent?",                         tier: 2, targetFile: "preferences.md" },
  { id: "secondary_projects", question: "Any other projects I should know about?",                        tier: 2, targetFile: "program.md"     },

  // Tier 3 — People & context
  { id: "key_people",    question: "Who are the most important people in your professional world right now?", tier: 3, targetFile: "facts"         },
  { id: "tools",         question: "What tools and languages do you use daily?",                          tier: 3, targetFile: "preferences.md" },
  { id: "infrastructure",question: "Where do you run things — local, specific cloud?",                    tier: 3, targetFile: "preferences.md" },
  { id: "feeds",         question: "Any publications or blogs I should monitor for you?",                 tier: 3, targetFile: "feeds.json"     },
];

// ─── DB initialization ─────────────────────────────────────────────────────────

/**
 * Populate the onboarding table with all questions if they don't exist yet.
 * Safe to call multiple times (uses INSERT OR IGNORE).
 */
export function initOnboarding(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO onboarding (question_id, question, answered)
    VALUES (?, ?, 0)
  `);

  const insertAll = db.transaction(() => {
    for (const q of QUESTION_BANK) {
      insert.run(q.id, q.question);
    }
  });

  insertAll();
}

// ─── State queries ─────────────────────────────────────────────────────────────

/** Get next N unanswered questions, prioritizing tier 1 → 2 → 3. */
export function getNextQuestions(
  db: Database.Database,
  count = 2
): OnboardingQuestion[] {
  const answered = db
    .prepare("SELECT question_id FROM onboarding WHERE answered = 1 OR answer = '__skipped__'")
    .all() as Array<{ question_id: string }>;

  const answeredIds = new Set(answered.map((r) => r.question_id));

  const remaining = QUESTION_BANK.filter((q) => !answeredIds.has(q.id));
  // Already sorted by tier in QUESTION_BANK; just take the first N
  return remaining.slice(0, count);
}

/**
 * Check whether onboarding is complete:
 *   - All Tier 1 answered
 *   - At least 3 Tier 2 answered
 *   - At least 1 Tier 3 answered
 */
export function isOnboardingComplete(db: Database.Database): boolean {
  const rows = db
    .prepare("SELECT question_id, answered, answer FROM onboarding")
    .all() as Array<{ question_id: string; answered: number; answer: string | null }>;

  const doneIds = new Set(
    rows
      .filter((r) => r.answered === 1 && r.answer !== "__skipped__")
      .map((r) => r.question_id)
  );

  const tier1 = QUESTION_BANK.filter((q) => q.tier === 1);
  const tier2 = QUESTION_BANK.filter((q) => q.tier === 2);
  const tier3 = QUESTION_BANK.filter((q) => q.tier === 3);

  const allTier1Done = tier1.every((q) => doneIds.has(q.id));
  const tier2DoneCount = tier2.filter((q) => doneIds.has(q.id)).length;
  const tier3DoneCount = tier3.filter((q) => doneIds.has(q.id)).length;

  return allTier1Done && tier2DoneCount >= 3 && tier3DoneCount >= 1;
}

// ─── Answer recording ──────────────────────────────────────────────────────────

/**
 * Record an answer to an onboarding question.
 * Writes to the appropriate file immediately, then marks the question answered in DB.
 */
export async function recordAnswer(
  db: Database.Database,
  mindPath: string,
  questionId: string,
  answer: string
): Promise<void> {
  const question = QUESTION_BANK.find((q) => q.id === questionId);
  if (!question) return;

  // Write to the target file/store
  try {
    switch (question.targetFile) {
      case "preferences.md":
        await writeToPreferences(mindPath, questionId, answer);
        break;
      case "program.md":
        await writeToProgram(mindPath, questionId, answer);
        // For primary project: also pin it
        if (questionId === "primary_project") {
          addPinnedContext(db, answer.slice(0, 40), answer, "system");
        }
        break;
      case "facts":
        writeFact(db, questionId, answer);
        break;
      case "feeds.json":
        await writeToFeeds(mindPath, answer);
        break;
    }
  } catch (err) {
    console.error(`[onboarding] Failed to write answer for ${questionId}:`, err);
  }

  // Always store in onboarding table
  db.prepare(`
    UPDATE onboarding
    SET answered = 1, answer = ?, answered_at = datetime('now'), asked_at = COALESCE(asked_at, datetime('now'))
    WHERE question_id = ?
  `).run(answer, questionId);

  // Also store as a durable fact
  try {
    db.prepare(`
      INSERT INTO facts (subject, predicate, object, confidence)
      VALUES (?, ?, ?, 1.0)
      ON CONFLICT(subject, predicate) DO UPDATE SET object = excluded.object, updated_at = datetime('now')
    `).run("principal", questionId, answer);
  } catch { /* non-critical */ }
}

/** Mark a question as skipped (won't be re-asked automatically). */
export function skipQuestion(db: Database.Database, questionId: string): void {
  db.prepare(`
    UPDATE onboarding
    SET asked_at = COALESCE(asked_at, datetime('now')), answer = '__skipped__'
    WHERE question_id = ?
  `).run(questionId);
}

// ─── File writers ──────────────────────────────────────────────────────────────

/** Map from question ID to preferences.md placeholder text. */
const PREFS_PLACEHOLDER_MAP: Record<string, { section: string; placeholder: string }> = {
  name:            { section: "## Communication", placeholder: "- Name: [to be learned]" },
  language:        { section: "## Communication", placeholder: "- Languages: [to be learned]" },
  tone:            { section: "## Communication", placeholder: "- Tone: [to be learned]" },
  emoji_policy:    { section: "## Visual / Formatting", placeholder: "- Emoji policy: [to be learned]" },
  output_pref:     { section: "## Work Style", placeholder: "- Output preference: [to be learned]" },
  decision_filter: { section: "## Work Style", placeholder: "- Decision filter: [to be learned]" },
  tools:           { section: "## Technical", placeholder: "- Languages / tools: [to be learned]" },
  infrastructure:  { section: "## Technical", placeholder: "- Infrastructure: [to be learned]" },
  timezone:        { section: "## Timezone & Schedule", placeholder: "- Timezone: [to be learned]" },
};

const PREFS_REPLACEMENT_MAP: Record<string, string> = {
  name:            "- Name: ",
  language:        "- Languages: ",
  tone:            "- Tone: ",
  emoji_policy:    "- Emoji policy: ",
  output_pref:     "- Output preference: ",
  decision_filter: "- Decision filter: ",
  tools:           "- Languages / tools: ",
  infrastructure:  "- Infrastructure: ",
  timezone:        "- Timezone: ",
};

async function writeToPreferences(mindPath: string, questionId: string, answer: string): Promise<void> {
  const prefsPath = path.join(mindPath, "preferences.md");
  if (!fs.existsSync(prefsPath)) return;

  let content = fs.readFileSync(prefsPath, "utf-8");

  const info = PREFS_PLACEHOLDER_MAP[questionId];
  const replacement = PREFS_REPLACEMENT_MAP[questionId];

  if (info && replacement) {
    // Replace the [to be learned] placeholder with the actual value
    content = content.replace(info.placeholder, `${replacement}${answer}`);
  } else {
    // Append to end of file for unknown mappings
    content += `\n## ${questionId}\n${answer}\n`;
  }

  fs.writeFileSync(prefsPath, content, "utf-8");
}

async function writeToProgram(mindPath: string, questionId: string, answer: string): Promise<void> {
  const programPath = path.join(mindPath, "program.md");
  if (!fs.existsSync(programPath)) return;

  let content = fs.readFileSync(programPath, "utf-8");

  if (questionId === "primary_project" || questionId === "secondary_projects") {
    // Replace the placeholder in Active Projects section
    const placeholder = "[No active projects yet — will be populated during onboarding]";
    if (content.includes(placeholder)) {
      content = content.replace(placeholder, `- ${answer}`);
    } else {
      // Append under the ## Active Projects section
      content = content.replace(
        /## Active Projects\n([\s\S]*?)(?=\n##|$)/,
        (match, existing) => `## Active Projects\n${existing.trimEnd()}\n- ${answer}\n`
      );
    }
  } else if (questionId === "primary_goal") {
    // Append goal under Active Projects
    content = content.replace(
      /## Active Projects\n([\s\S]*?)(?=\n##|$)/,
      (match, existing) => `## Active Projects\n${existing.trimEnd()}\n  Goal (90d): ${answer}\n`
    );
  }

  fs.writeFileSync(programPath, content, "utf-8");
}

function writeFact(db: Database.Database, questionId: string, answer: string): void {
  // For key_people: parse comma-separated names and store each as a fact
  if (questionId === "key_people") {
    const people = answer.split(/[,;]+/).map((p) => p.trim()).filter((p) => p.length > 1);
    for (const person of people) {
      try {
        db.prepare(`
          INSERT INTO facts (subject, predicate, object, confidence)
          VALUES (?, 'is_key_person', 'true', 1.0)
          ON CONFLICT(subject, predicate) DO UPDATE SET object = excluded.object, updated_at = datetime('now')
        `).run(person, "is_key_person");
      } catch { /* ignore */ }
    }
  }
}

async function writeToFeeds(mindPath: string, answer: string): Promise<void> {
  const feedsPath = path.join(mindPath, "feeds.json");

  // Parse any URLs from the answer
  const urlRegex = /https?:\/\/[^\s,]+/g;
  const urls = answer.match(urlRegex) ?? [];

  let feedsConfig: { feeds: Array<{ url: string; name: string; category: string }>; fetchIntervalMinutes: number };

  try {
    const existing = fs.existsSync(feedsPath) ? fs.readFileSync(feedsPath, "utf-8") : "{}";
    feedsConfig = JSON.parse(existing) as typeof feedsConfig;
    if (!feedsConfig.feeds) feedsConfig.feeds = [];
    if (!feedsConfig.fetchIntervalMinutes) feedsConfig.fetchIntervalMinutes = 120;
  } catch {
    feedsConfig = { feeds: [], fetchIntervalMinutes: 120 };
  }

  for (const url of urls) {
    const alreadyExists = feedsConfig.feeds.some((f) => f.url === url);
    if (!alreadyExists) {
      feedsConfig.feeds.push({
        url,
        name: url.replace(/^https?:\/\/(www\.)?/, "").split("/")[0],
        category: "general",
      });
    }
  }

  fs.writeFileSync(feedsPath, JSON.stringify(feedsConfig, null, 2), "utf-8");
}

// ─── Greeting builder ──────────────────────────────────────────────────────────

/**
 * Build the first-message greeting for new users.
 * Returns null if onboarding is already complete.
 *
 * Weaves in the first 1-2 unanswered questions naturally.
 */
export function buildOnboardingGreeting(db: Database.Database): string | null {
  if (isOnboardingComplete(db)) return null;

  const next = getNextQuestions(db, 2);
  if (next.length === 0) return null;

  const isFirstEver = db
    .prepare("SELECT COUNT(*) as cnt FROM onboarding WHERE asked_at IS NOT NULL")
    .get() as { cnt: number };

  if (isFirstEver.cnt === 0) {
    // True first message
    const q1 = next[0].question;
    const q2 = next[1]?.question;

    let greeting = `Hi — I'm Atlas, your personal AI agent.\n\nI start completely empty, so I need to learn from you.\n`;
    greeting += q2
      ? `${q1} And ${q2.charAt(0).toLowerCase()}${q2.slice(1)}`
      : q1;
    greeting += `\n\n(You can skip this and just start working — I'll ask again gradually.)`;

    // Mark tier 1 questions as "asked"
    for (const q of next) {
      db.prepare(`UPDATE onboarding SET asked_at = datetime('now') WHERE question_id = ?`).run(q.id);
    }

    return greeting;
  }

  return null; // Not the first session — weave questions in naturally via agent.ts
}

// ─── Weave-in helper ───────────────────────────────────────────────────────────

/**
 * Return a single question to append to a response, or null if onboarding
 * is complete or no questions are pending.
 *
 * Call this at natural pauses (end of a task, beginning of conversation).
 */
export function getOnboardingQuestion(db: Database.Database): OnboardingQuestion | null {
  if (isOnboardingComplete(db)) return null;

  const next = getNextQuestions(db, 1);
  if (next.length === 0) return null;

  const q = next[0];

  // Mark as asked
  db.prepare(`
    UPDATE onboarding SET asked_at = COALESCE(asked_at, datetime('now')) WHERE question_id = ?
  `).run(q.id);

  return q;
}
