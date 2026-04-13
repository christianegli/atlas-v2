/**
 * Evolution module — self-improvement ratchet via targeted mutations to mind files.
 *
 * Cycle: measure → diagnose → propose → synthetic backtest → apply → evaluate.
 *
 * Atlas v2 differences from Hermes reference:
 * - MUTABLE_FILES = ["program.md", "retrieval_weights.json", "patterns.md", "principles.md", "stimuli.md"]
 * - mindPath = project root (process.cwd()), so proposed_code_changes.md goes there too
 * - experiments table uses hypothesis, synthetic_backtest_pass, effect_size (v2 schema)
 */

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { getRollingAverage, type DailyMetrics } from "./metrics.js";

const execAsync = promisify(exec);

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";

export interface Mutation {
  type: "targeted" | "speculative" | "meta-evolution";
  targetFile: string;
  description: string;
  hypothesis: string;
  newContent: string;
}

/**
 * Only these mind files may be auto-mutated.
 * TypeScript source files are never auto-mutated — proposals go to proposed_code_changes.md.
 */
const MUTABLE_FILES = [
  "program.md",
  "retrieval_weights.json",
  "patterns.md",
  "principles.md",
  "stimuli.md",
];

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

async function gitCommand(cwd: string, cmd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git ${cmd}`, { cwd });
    return stdout.trim();
  } catch (err) {
    const e = err as { message?: string };
    return e.message ?? "";
  }
}

async function ensureGitRepo(repoPath: string): Promise<void> {
  const gitDir = path.join(repoPath, ".git");
  if (!fs.existsSync(gitDir)) {
    await gitCommand(repoPath, "init");
    await gitCommand(repoPath, 'config user.email "atlas@local"');
    await gitCommand(repoPath, 'config user.name "Atlas"');
    await gitCommand(repoPath, "add -A");
    await gitCommand(repoPath, 'commit -m "Initial mind state" --allow-empty');
  }
}

// ─── Mutation proposal ─────────────────────────────────────────────────────────

/** Propose a targeted mutation based on performance metrics and recent mistakes. */
export async function proposeMutation(
  metrics: DailyMetrics,
  mistakes: string
): Promise<Mutation | null> {
  const prompt = `You are improving an AI agent's behavior files based on performance data.

Metrics (7-day rolling average):
- Correction rate: ${(metrics.correction_rate * 100).toFixed(1)}%
- Total interactions: ${metrics.total_interactions}

Recent mistakes:
${mistakes.slice(0, 2000)}

Based on this data, propose ONE targeted mutation to improve agent behavior.
Only mutate one of: ${MUTABLE_FILES.join(", ")}.

Respond with JSON:
{
  "targetFile": "program.md",
  "description": "what you're changing and why",
  "hypothesis": "expected improvement",
  "newContent": "the new content to add or modify"
}

If no mutation is warranted (correction rate < 5%), respond: NONE`;

  const raw = await ollamaComplete(prompt);
  if (!raw || raw.trim() === "NONE") return null;

  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      targetFile: string;
      description: string;
      hypothesis: string;
      newContent: string;
    };

    if (!MUTABLE_FILES.includes(parsed.targetFile)) return null;

    return {
      type: "targeted",
      targetFile: parsed.targetFile,
      description: parsed.description ?? "Targeted mutation",
      hypothesis: parsed.hypothesis ?? parsed.description ?? "Expected improvement",
      newContent: parsed.newContent ?? "",
    };
  } catch {
    return null;
  }
}

/** Propose a speculative mutation — explore improvements not driven by specific errors. */
export async function proposeSpeculativeMutation(): Promise<Mutation | null> {
  const ideas = [
    "Add a new behavioral rule to program.md about conciseness",
    "Update program.md to add a reminder about verifying facts before stating them",
    "Add a new section on handling ambiguous requests",
    "Update retrieval weights to increase recency bias",
  ];

  const idea = ideas[Math.floor(Math.random() * ideas.length)];

  const prompt = `Propose a speculative improvement to an AI agent's program.md.

Idea: ${idea}

Write a specific, concrete mutation. Keep it small and testable.
Respond with JSON:
{
  "targetFile": "program.md",
  "description": "brief description of the change",
  "hypothesis": "expected outcome",
  "newContent": "the new content to add or modify"
}`;

  const raw = await ollamaComplete(prompt);
  if (!raw) return null;

  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      targetFile: string;
      description: string;
      hypothesis: string;
      newContent: string;
    };

    return {
      type: "speculative",
      targetFile: parsed.targetFile ?? "program.md",
      description: parsed.description ?? "Speculative mutation",
      hypothesis: parsed.hypothesis ?? "Expected improvement",
      newContent: parsed.newContent ?? "",
    };
  } catch {
    return null;
  }
}

// ─── Mutation application ──────────────────────────────────────────────────────

/**
 * Apply a mutation to the target file.
 * TypeScript/src files → write to proposed_code_changes.md instead.
 * Returns commit hash on success, "proposed-only" for code proposals.
 */
export async function applyMutation(mindPath: string, mutation: Mutation): Promise<string> {
  // Code files → redirect to proposals file
  if (mutation.targetFile.includes("src/") || mutation.targetFile.endsWith(".ts")) {
    const proposedPath = path.join(mindPath, "proposed_code_changes.md");
    const existing = safeReadFile(proposedPath);
    const timestamp = new Date().toISOString();
    const entry = [
      `\n## ${timestamp} — ${mutation.targetFile}`,
      `**Hypothesis:** ${mutation.hypothesis}`,
      `**Triggered by:** ${mutation.type}`,
      `**Status:** pending`,
      ``,
      mutation.description,
      ``,
      `---`,
      ``,
    ].join("\n");
    fs.writeFileSync(proposedPath, existing + entry, "utf-8");
    return "proposed-only";
  }

  await ensureGitRepo(mindPath);

  const targetPath = path.join(mindPath, mutation.targetFile);
  const beforeContent = safeReadFile(targetPath);
  const afterContent = beforeContent + "\n\n" + mutation.newContent + "\n";
  fs.writeFileSync(targetPath, afterContent, "utf-8");

  await gitCommand(mindPath, "add -A");
  const commitMsg = `mutation: ${mutation.description.slice(0, 60)}`;
  await gitCommand(mindPath, `commit -m "${commitMsg}"`);

  const commitHash = await gitCommand(mindPath, "rev-parse HEAD");
  return commitHash;
}

/** Revert a mutation by creating a revert commit. */
export async function revertMutation(mindPath: string, commitHash: string): Promise<void> {
  await ensureGitRepo(mindPath);
  await gitCommand(mindPath, `revert ${commitHash} --no-edit`);
}

// ─── Synthetic backtest ────────────────────────────────────────────────────────

/**
 * Approximate whether a mutation is likely to improve metrics.
 *
 * For retrieval_weights.json: passes if baseline correction rate > 10%.
 * For other files: passes if recent rate is not already improving vs prior 7 days.
 *
 * Returns true to allow mutation, false to skip.
 */
export async function syntheticBacktest(
  db: Database.Database,
  mutation: Mutation,
  _mindPath: string
): Promise<boolean> {
  const rows = db
    .prepare(
      `SELECT date(created_at) as day, COUNT(*) as total, SUM(corrections) as corrections
       FROM interactions
       WHERE created_at >= datetime('now', '-14 days')
       GROUP BY day ORDER BY day ASC`
    )
    .all() as Array<{ day: string; total: number; corrections: number }>;

  if (rows.length === 0) return true;

  const overallTotal = rows.reduce((s, r) => s + r.total, 0);
  const overallCorrections = rows.reduce((s, r) => s + r.corrections, 0);
  const baselineCorrectionRate = overallTotal > 0 ? overallCorrections / overallTotal : 0;

  if (mutation.targetFile === "retrieval_weights.json") {
    return baselineCorrectionRate > 0.10;
  }

  const half = Math.ceil(rows.length / 2);
  const prior = rows.slice(0, half);
  const recent = rows.slice(half);

  const priorTotal = prior.reduce((s, r) => s + r.total, 0);
  const priorCorrections = prior.reduce((s, r) => s + r.corrections, 0);
  const priorRate = priorTotal > 0 ? priorCorrections / priorTotal : 0;

  const recentTotal = recent.reduce((s, r) => s + r.total, 0);
  const recentCorrections = recent.reduce((s, r) => s + r.corrections, 0);
  const recentRate = recentTotal > 0 ? recentCorrections / recentTotal : 0;

  // Skip if already improving (recent rate < 95% of prior rate)
  if (recentRate < priorRate * 0.95) return false;

  return true;
}

// ─── Experiment evaluation ─────────────────────────────────────────────────────

/** Fetch active experiments that need evaluation. */
function getActiveExperiments(db: Database.Database): Array<{
  id: number;
  target_file: string;
  git_commit: string | null;
  baseline_metrics: string;
}> {
  return db
    .prepare(`SELECT id, target_file, git_commit, baseline_metrics FROM experiments WHERE status = 'active'`)
    .all() as Array<{
    id: number;
    target_file: string;
    git_commit: string | null;
    baseline_metrics: string;
  }>;
}

/** Evaluate a running experiment. Returns keep/revert/pending. */
export async function evaluateMutation(
  db: Database.Database,
  experimentId: number
): Promise<"kept" | "reverted" | "pending"> {
  const exp = db
    .prepare("SELECT * FROM experiments WHERE id = ?")
    .get(experimentId) as {
    status: string;
    baseline_metrics: string;
    evaluation_start: string;
  } | undefined;

  if (!exp || exp.status !== "active") return "pending";

  const evalStart = new Date(exp.evaluation_start);
  const daysSinceStart = (Date.now() - evalStart.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceStart < 3) return "pending";

  // Parse baseline
  let baselineCorrectionRate = 0;
  try {
    const baseline = JSON.parse(exp.baseline_metrics) as { correction_rate?: number };
    baselineCorrectionRate = baseline.correction_rate ?? 0;
  } catch { /* use 0 */ }

  const current = getRollingAverage(db, 3);
  const sevenDayAvg = getRollingAverage(db, 7);
  const postRate = current.correction_rate;

  const effectSize =
    baselineCorrectionRate > 0
      ? Math.abs(postRate - baselineCorrectionRate) / baselineCorrectionRate
      : 0;

  const improved =
    postRate < baselineCorrectionRate * 0.95 &&
    postRate < sevenDayAvg.correction_rate;

  const worse = postRate > baselineCorrectionRate * 1.2;
  const expired = daysSinceStart >= 5;

  const resultMetrics = JSON.stringify({
    effect_size: effectSize,
    days_elapsed: daysSinceStart,
    post_correction_rate: postRate,
  });

  if (improved) {
    db.prepare(`
      UPDATE experiments
      SET status = 'kept', result_metrics = ?, evaluation_end = datetime('now'),
          updated_at = datetime('now'), effect_size = ?, synthetic_backtest_pass = 1
      WHERE id = ?
    `).run(resultMetrics, effectSize, experimentId);
    return "kept";
  }

  if (worse || (expired && !improved)) {
    db.prepare(`
      UPDATE experiments
      SET status = 'reverted', result_metrics = ?, evaluation_end = datetime('now'),
          updated_at = datetime('now'), effect_size = ?, synthetic_backtest_pass = 0,
          outcome_reason = ?
      WHERE id = ?
    `).run(
      resultMetrics,
      effectSize,
      worse ? "correction rate worsened" : "inconclusive after eval period",
      experimentId
    );
    return "reverted";
  }

  return "pending";
}

// ─── Main evolution cycle ──────────────────────────────────────────────────────

/**
 * Run one evolution cycle:
 * 1. Evaluate any active experiments
 * 2. If < 2 active, propose and apply a new mutation
 */
export async function runEvolutionCycle(
  db: Database.Database,
  mindPath: string
): Promise<void> {
  const activeExperiments = getActiveExperiments(db);

  // Evaluate pending experiments
  for (const exp of activeExperiments) {
    const result = await evaluateMutation(db, exp.id);
    if (result === "reverted" && exp.git_commit && exp.git_commit !== "proposed-only") {
      await revertMutation(mindPath, exp.git_commit);
      console.log(`[evolution] Reverted experiment ${exp.id}`);
    } else if (result === "kept") {
      console.log(`[evolution] Kept experiment ${exp.id}`);
    }
  }

  // Max 2 concurrent active experiments
  const stillActive = getActiveExperiments(db);
  if (stillActive.length >= 2) {
    console.log("[evolution] 2 active experiments already running, skipping new mutation");
    return;
  }

  const metrics = getRollingAverage(db, 7);

  const mistakesPath = path.join(mindPath, "mistakes.md");
  const mistakes = fs.existsSync(mistakesPath)
    ? fs.readFileSync(mistakesPath, "utf-8")
    : "";

  let mutation: Mutation | null = null;

  // Monthly meta-evolution on 1st of month
  const dayOfMonth = new Date().getDate();
  if (dayOfMonth === 1) {
    mutation = {
      type: "meta-evolution",
      targetFile: "program.md",
      description: "Monthly meta-review: adjust ratchet cadence based on 30-day experiment success rate",
      hypothesis: "Monthly review improves experiment targeting",
      newContent: "",
    };
  } else {
    mutation = Math.random() < 0.5
      ? await proposeMutation(metrics, mistakes)
      : await proposeSpeculativeMutation();
  }

  if (!mutation) {
    console.log("[evolution] No mutation proposed");
    return;
  }

  // Synthetic backtest
  const backtestPassed = await syntheticBacktest(db, mutation, mindPath);
  const backtestPassedInt = backtestPassed ? 1 : 0;

  if (!backtestPassed) {
    console.log("[evolution] Synthetic backtest failed — skipping mutation");
    try {
      db.prepare(`
        INSERT INTO experiments
          (type, target_file, hypothesis, mutation, before_content,
           baseline_metrics, status, synthetic_backtest_pass, evaluation_start)
        VALUES (?, ?, ?, ?, '', ?, 'reverted', ?, datetime('now'))
      `).run(
        mutation.type,
        mutation.targetFile,
        `[backtest failed] ${mutation.hypothesis}`,
        mutation.description,
        JSON.stringify({ correction_rate: metrics.correction_rate }),
        backtestPassedInt
      );
    } catch { /* ignore */ }
    return;
  }

  const targetPath = path.join(mindPath, mutation.targetFile);
  const beforeContent = fs.existsSync(targetPath)
    ? fs.readFileSync(targetPath, "utf-8")
    : "";

  try {
    const commitHash = await applyMutation(mindPath, mutation);
    const afterContent = fs.existsSync(targetPath)
      ? fs.readFileSync(targetPath, "utf-8")
      : "";

    const isProposedOnly = commitHash === "proposed-only";

    db.prepare(`
      INSERT INTO experiments
        (type, target_file, hypothesis, mutation, before_content, after_content,
         git_commit, baseline_metrics, status, synthetic_backtest_pass, evaluation_start)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      mutation.type,
      mutation.targetFile,
      mutation.hypothesis,
      mutation.description,
      beforeContent,
      afterContent,
      commitHash,
      JSON.stringify({ correction_rate: metrics.correction_rate }),
      isProposedOnly ? "proposed-only" : "active",
      backtestPassedInt
    );

    console.log(`[evolution] Applied ${mutation.type} mutation to ${mutation.targetFile}`);
  } catch (err) {
    console.error("[evolution] Failed to apply mutation:", err);
  }
}
