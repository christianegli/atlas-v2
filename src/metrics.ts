/**
 * Metrics module — interaction logging and daily performance statistics.
 *
 * Atlas v2 differences from Hermes reference:
 * - logInteraction writes tokens_input, tokens_output, tokens_total separately
 * - computeDailyMetrics computes correction_rate and proactivity_rate
 * - InteractionData interface matches the v2 interactions schema
 */

import Database from "better-sqlite3";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InteractionData {
  sessionId: string;
  episodeId?: number;
  userMessage: string;
  assistantResponse?: string;
  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  platform?: string;
  proactiveSurfaced?: boolean;
  taskCategory?: string;
}

export interface DailyMetrics {
  date: string;
  total_interactions: number;
  total_tokens: number;
  total_corrections: number;
  correction_rate: number;
  proactivity_rate: number;
  retrieval_hit_rate: number | null;
  dod_completion_rate: number | null;
  user_score_avg: number | null;
}

// ─── Correction detection ──────────────────────────────────────────────────────

const CORRECTION_PATTERNS = [
  /^no[,\.]/i,
  /^nein[,\.]/i,
  /that'?s wrong/i,
  /you'?re wrong/i,
  /that'?s incorrect/i,
  /i meant/i,
  /i mean[^t]/i,
  /not what i (asked|said|meant)/i,
  /actually[,\.]/i,
  /that'?s not right/i,
  /wrong answer/i,
  /incorrect/i,
  /please correct/i,
  /you misunderstood/i,
  /that'?s not what/i,
];

export function detectCorrection(message: string): boolean {
  const trimmed = message.trim();
  return CORRECTION_PATTERNS.some((p) => p.test(trimmed));
}

// ─── Interaction logging ───────────────────────────────────────────────────────

/**
 * Log a single interaction to the database.
 * Writes token counts separately (input, output, total) per v2 schema.
 */
export function logInteraction(db: Database.Database, data: InteractionData): void {
  const isCorrection = detectCorrection(data.userMessage) ? 1 : 0;
  const proactiveSurface = data.proactiveSurfaced ? 1 : 0;

  const tokensInput = data.tokensInput ?? 0;
  const tokensOutput = data.tokensOutput ?? 0;
  const tokensTotal = data.tokensTotal ?? (tokensInput + tokensOutput);

  db.prepare(`
    INSERT INTO interactions
      (session_id, episode_id, user_message, assistant_response,
       tokens_input, tokens_output, tokens_total,
       corrections, platform, proactive_surface, task_category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.sessionId,
    data.episodeId ?? null,
    data.userMessage,
    data.assistantResponse ?? null,
    tokensInput,
    tokensOutput,
    tokensTotal,
    isCorrection,
    data.platform ?? "telegram",
    proactiveSurface,
    data.taskCategory ?? null
  );
}

// ─── Daily metrics ─────────────────────────────────────────────────────────────

/**
 * Compute and persist daily aggregate metrics for the given date.
 * Includes correction_rate and proactivity_rate (v2 schema additions).
 */
export function computeDailyMetrics(db: Database.Database, date: string): void {
  const row = db
    .prepare(
      `SELECT
        COUNT(*) as total_interactions,
        SUM(tokens_total) as total_tokens,
        SUM(corrections) as total_corrections,
        SUM(proactive_surface) as total_proactive
       FROM interactions
       WHERE date(created_at) = ?`
    )
    .get(date) as {
    total_interactions: number;
    total_tokens: number;
    total_corrections: number;
    total_proactive: number;
  };

  if (!row || row.total_interactions === 0) return;

  const correctionRate =
    row.total_interactions > 0 ? (row.total_corrections ?? 0) / row.total_interactions : 0;
  const proactivityRate =
    row.total_interactions > 0 ? (row.total_proactive ?? 0) / row.total_interactions : 0;

  db.prepare(`
    INSERT INTO daily_metrics
      (date, total_interactions, total_tokens, total_corrections,
       correction_rate, proactivity_rate)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      total_interactions = excluded.total_interactions,
      total_tokens = excluded.total_tokens,
      total_corrections = excluded.total_corrections,
      correction_rate = excluded.correction_rate,
      proactivity_rate = excluded.proactivity_rate,
      updated_at = datetime('now')
  `).run(
    date,
    row.total_interactions,
    row.total_tokens ?? 0,
    row.total_corrections ?? 0,
    correctionRate,
    proactivityRate
  );
}

// ─── Health audit ──────────────────────────────────────────────────────────────

/**
 * Run a health check for the given date and return a status string.
 * Checks: unprocessed episodes, git conflicts, token budget overruns.
 */
export async function auditDailyHealth(
  db: Database.Database,
  mindPath: string,
  date: string
): Promise<string> {
  const issues: string[] = [];

  // Check unprocessed episodes older than 4 hours
  try {
    const row = db
      .prepare(
        `SELECT count(*) as cnt FROM episodes
         WHERE is_hot=1 AND summary IS NULL AND created_at < datetime('now', '-4 hours')`
      )
      .get() as { cnt: number };
    if (row && row.cnt > 0) {
      issues.push(`${row.cnt} unprocessed episodes older than 4h`);
    }
  } catch { /* ignore */ }

  // Check git conflicts in mind files
  try {
    const { stdout } = await execAsync(`git -C ${mindPath} status --porcelain`);
    const conflicted = stdout.split("\n").filter((line) => line.startsWith("UU")).length;
    if (conflicted > 0) {
      issues.push(`${conflicted} git conflict(s) in knowledge files`);
    }
  } catch { /* ignore — git may not be set up */ }

  // Check token budget overruns (> 30k total tokens in a single interaction)
  try {
    const row = db
      .prepare(
        `SELECT count(*) as cnt FROM interactions
         WHERE date(created_at) = ? AND tokens_total > 30000`
      )
      .get(date) as { cnt: number };
    if (row && row.cnt > 0) {
      issues.push(`${row.cnt} interaction(s) exceeded 30k token budget`);
    }
  } catch { /* ignore */ }

  return issues.length === 0 ? "OK" : `WARNING: ${issues.join("; ")}`;
}

/**
 * Compute daily metrics and write audit status.
 */
export async function computeDailyMetricsWithAudit(
  db: Database.Database,
  date: string,
  mindPath: string
): Promise<void> {
  computeDailyMetrics(db, date);

  const auditStatus = await auditDailyHealth(db, mindPath, date);
  try {
    db.prepare(`UPDATE daily_metrics SET audit_status = ? WHERE date = ?`).run(auditStatus, date);
  } catch { /* column may not exist on older DBs */ }
}

// ─── Retrieval helpers ─────────────────────────────────────────────────────────

export function getDailyMetrics(db: Database.Database, date: string): DailyMetrics | null {
  const row = db
    .prepare("SELECT * FROM daily_metrics WHERE date = ?")
    .get(date) as DailyMetrics | undefined;
  return row ?? null;
}

export function getRollingAverage(
  db: Database.Database,
  days: number
): DailyMetrics {
  const rows = db
    .prepare(`SELECT * FROM daily_metrics ORDER BY date DESC LIMIT ?`)
    .all(days) as DailyMetrics[];

  if (rows.length === 0) {
    return {
      date: `rolling-${days}d`,
      total_interactions: 0,
      total_tokens: 0,
      total_corrections: 0,
      correction_rate: 0,
      proactivity_rate: 0,
      retrieval_hit_rate: null,
      dod_completion_rate: null,
      user_score_avg: null,
    };
  }

  const avg = (arr: number[]): number =>
    arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    date: `rolling-${days}d`,
    total_interactions: avg(rows.map((r) => r.total_interactions)),
    total_tokens: avg(rows.map((r) => r.total_tokens)),
    total_corrections: avg(rows.map((r) => r.total_corrections)),
    correction_rate: avg(rows.map((r) => r.correction_rate)),
    proactivity_rate: avg(rows.map((r) => r.proactivity_rate)),
    retrieval_hit_rate:
      rows.some((r) => r.retrieval_hit_rate !== null)
        ? avg(rows.filter((r) => r.retrieval_hit_rate !== null).map((r) => r.retrieval_hit_rate as number))
        : null,
    dod_completion_rate:
      rows.some((r) => r.dod_completion_rate !== null)
        ? avg(rows.filter((r) => r.dod_completion_rate !== null).map((r) => r.dod_completion_rate as number))
        : null,
    user_score_avg:
      rows.some((r) => r.user_score_avg !== null)
        ? avg(rows.filter((r) => r.user_score_avg !== null).map((r) => r.user_score_avg as number))
        : null,
  };
}

export function getTodayMetrics(db: Database.Database): DailyMetrics {
  const today = new Date().toISOString().slice(0, 10);
  computeDailyMetrics(db, today);
  return (
    getDailyMetrics(db, today) ?? {
      date: today,
      total_interactions: 0,
      total_tokens: 0,
      total_corrections: 0,
      correction_rate: 0,
      proactivity_rate: 0,
      retrieval_hit_rate: null,
      dod_completion_rate: null,
      user_score_avg: null,
    }
  );
}

export function formatMetrics(m: DailyMetrics): string {
  const lines = [
    `Date: ${m.date}`,
    `Interactions: ${m.total_interactions}`,
    `Tokens: ${m.total_tokens.toLocaleString()}`,
    `Corrections: ${m.total_corrections} (${(m.correction_rate * 100).toFixed(1)}%)`,
    `Proactivity: ${(m.proactivity_rate * 100).toFixed(1)}%`,
    m.user_score_avg !== null ? `User score: ${m.user_score_avg.toFixed(2)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return lines;
}
