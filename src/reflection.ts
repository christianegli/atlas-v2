/**
 * Reflection module — mistake logging, pattern promotion, principle distillation,
 * blindspot detection, and preference learning from corrections.
 *
 * Runs in the subconscious loop (weekly for patterns, monthly for principles/blindspots).
 * All outputs append to flat markdown files — never overwrite.
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";

export interface MistakeEntry {
  label: string;
  mistake: string;
  correction: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ollamaComplete(prompt: string): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: AbortSignal.timeout(90000),
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

function safeWriteFile(filePath: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
  } catch (err) {
    console.error("[reflection] Failed to write", filePath, err);
  }
}

// ─── Mistake logging ───────────────────────────────────────────────────────────

/**
 * Append a mistake entry to mistakes.md.
 * Called when the user corrects the agent.
 */
export async function logMistake(
  _db: Database.Database,
  mindPath: string,
  entry: MistakeEntry
): Promise<void> {
  const mistakesPath = path.join(mindPath, "mistakes.md");
  const existing = safeReadFile(mistakesPath);

  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  const newEntry = `\n## ${now} — ${entry.label}\n- **Mistake:** ${entry.mistake}\n- **Correction:** ${entry.correction}\n`;

  safeWriteFile(mistakesPath, existing + newEntry);
}

// ─── Pattern promotion (weekly) ────────────────────────────────────────────────

/**
 * Read mistakes.md and extract NEW recurring patterns into patterns.md.
 * Runs weekly in the subconscious loop.
 */
export async function promotePatternsWeekly(
  db: Database.Database,
  mindPath: string
): Promise<void> {
  const mistakesPath = path.join(mindPath, "mistakes.md");
  const patternsPath = path.join(mindPath, "patterns.md");

  const mistakes = safeReadFile(mistakesPath);
  if (!mistakes || mistakes.trim().length < 100) return;

  const existingPatterns = safeReadFile(patternsPath);

  const prompt = `You are analyzing a log of mistakes to identify recurring patterns.

Mistakes log:
${mistakes}

Existing patterns:
${existingPatterns}

Identify 1-3 NEW recurring patterns not already in the existing patterns. Each pattern should:
- Describe a systematic mistake type
- Explain the root cause
- Provide the correction rule

Format each pattern as:
## Pattern: [name]
**Root cause:** [explanation]
**Rule:** [correction]

Only output new patterns. If no new patterns, output: NONE`;

  const response = await ollamaComplete(prompt);

  if (!response || response.trim() === "NONE" || response.trim().length < 20) return;

  safeWriteFile(patternsPath, existingPatterns + "\n" + response.trim() + "\n");

  try {
    db.prepare(`
      INSERT INTO interactions (session_id, user_message, assistant_response, platform)
      VALUES ('system', '[system] weekly pattern promotion', ?, 'system')
    `).run("Promoted patterns from mistakes.md");
  } catch { /* non-critical */ }
}

// ─── Principle distillation (monthly) ─────────────────────────────────────────

/**
 * Distill patterns.md into durable principles in principles.md.
 * Runs on the 1st of each month.
 */
export async function promotePrinciplesMonthly(
  db: Database.Database,
  mindPath: string
): Promise<void> {
  const patternsPath = path.join(mindPath, "patterns.md");
  const principlesPath = path.join(mindPath, "principles.md");

  const patterns = safeReadFile(patternsPath);
  if (!patterns || patterns.trim().length < 100) return;

  const existingPrinciples = safeReadFile(principlesPath);

  const prompt = `You are distilling behavioral patterns into durable principles.

Patterns (short-term observations):
${patterns}

Existing principles (long-term rules):
${existingPrinciples}

Identify 1-2 NEW durable principles from the patterns. A principle must:
- Be general enough to apply in many situations
- Not already be captured in existing principles
- Be stated as a rule, not an observation

Format:
## P[N] — [Principle name]
[One paragraph explanation]

Only output new principles. If none, output: NONE`;

  const response = await ollamaComplete(prompt);

  if (!response || response.trim() === "NONE" || response.trim().length < 20) return;

  safeWriteFile(principlesPath, existingPrinciples + "\n" + response.trim() + "\n");

  try {
    db.prepare(`
      INSERT INTO interactions (session_id, user_message, assistant_response, platform)
      VALUES ('system', '[system] monthly principle promotion', ?, 'system')
    `).run("Promoted principles from patterns.md");
  } catch { /* non-critical */ }
}

// ─── Blindspot detection (monthly) ────────────────────────────────────────────

/**
 * Identify systematic reasoning blindspots from mistakes and patterns.
 * Runs on the 1st of each month.
 */
export async function detectBlindspotsMonthly(
  db: Database.Database,
  mindPath: string
): Promise<void> {
  const mistakesPath = path.join(mindPath, "mistakes.md");
  const patternsPath = path.join(mindPath, "patterns.md");
  const blindspotsPath = path.join(mindPath, "blindspots.md");

  const mistakes = safeReadFile(mistakesPath);
  const patterns = safeReadFile(patternsPath);
  const existingBlinds = safeReadFile(blindspotsPath);

  if (!mistakes && !patterns) return;

  const prompt = `You are identifying systematic blindspots in an AI agent's reasoning.

Mistakes log:
${mistakes}

Patterns:
${patterns}

Existing blindspots:
${existingBlinds}

A blindspot is an area where the agent systematically fails to consider certain factors or perspectives.
Identify 1-2 NEW blindspots not already listed.

Format:
## [Blindspot name]
**Description:** [what the agent fails to see]
**Trigger:** [what situations trigger this]
**Mitigation:** [how to counteract it]

Only output new blindspots. If none, output: NONE`;

  const response = await ollamaComplete(prompt);

  if (!response || response.trim() === "NONE" || response.trim().length < 20) return;

  safeWriteFile(blindspotsPath, existingBlinds + "\n" + response.trim() + "\n");

  try {
    db.prepare(`
      INSERT INTO interactions (session_id, user_message, assistant_response, platform)
      VALUES ('system', '[system] monthly blindspot detection', ?, 'system')
    `).run("Detected blindspots");
  } catch { /* non-critical */ }
}

// ─── Preference learning ───────────────────────────────────────────────────────

/**
 * Extract preference signals from a user correction and update preferences.md.
 * Called whenever a correction is detected.
 */
export async function updatePreferences(
  mindPath: string,
  correction: string
): Promise<void> {
  const prefsPath = path.join(mindPath, "preferences.md");
  const existing = safeReadFile(prefsPath);

  const prompt = `An AI assistant was corrected by the user. Extract any preference information from this correction.

Correction: "${correction}"

Existing preferences:
${existing}

If the correction reveals a new or updated preference, append it to the preferences file.
If it reveals nothing new, output: NONE

Output format (if new preference found):

## Updated preference
[Description of the preference]`;

  const response = await ollamaComplete(prompt);

  if (!response || response.trim() === "NONE" || response.trim().length < 10) return;

  safeWriteFile(prefsPath, existing + "\n" + response.trim() + "\n");
}
