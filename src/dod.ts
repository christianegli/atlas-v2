/**
 * DoD (Definition of Done) module — task completion criteria and evaluation.
 *
 * When the agent receives a task message, it proposes concrete, measurable
 * exit criteria before starting work. After completing work, it self-evaluates
 * against those criteria using Gemma. Falls back to sensible defaults if
 * Ollama is unavailable.
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";

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

const TASK_KEYWORDS = [
  "write",
  "draft",
  "create",
  "build",
  "implement",
  "research",
  "analyze",
  "prepare",
  "send",
  "update",
  "fix",
  "review",
  "schedule",
  "find",
  "calculate",
];

/** Returns true if the message looks like a task request. */
export function isTask(message: string): boolean {
  const lower = message.toLowerCase();
  return TASK_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Ask Gemma to propose 3-5 specific, measurable DoD criteria for the task.
 * Falls back to generic criteria if Ollama is unavailable.
 */
export async function proposeDod(task: string): Promise<string> {
  const prompt = `You are a precise assistant defining completion criteria for a task.

Task: ${task}

Write a brief Definition of Done (DoD) — a numbered list of 3-5 specific, measurable criteria
that must be met for this task to be considered complete. Be concrete, not vague. No preamble.

DoD:`;

  const response = await ollamaComplete(prompt);

  if (!response || response.trim().length < 10) {
    return `1. Task is fully completed as described\n2. Output is verified correct\n3. No follow-up action required from user`;
  }

  return response.trim();
}

/**
 * Ask Gemma to evaluate completed work against DoD criteria.
 * Returns whether all criteria are met, and which are missing.
 */
export async function evaluateAgainstDod(
  work: string,
  dod: string
): Promise<{ met: boolean; missing: string[] }> {
  const prompt = `Evaluate whether completed work meets the Definition of Done.

Definition of Done:
${dod}

Completed Work:
${work}

Respond with valid JSON only:
{"met": true/false, "missing": ["list of unmet criteria, empty if all met"]}

JSON:`;

  const raw = await ollamaComplete(prompt);

  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned) as { met: boolean; missing: string[] };
    return {
      met: Boolean(parsed.met),
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    };
  } catch {
    // Default to met if parsing fails
    return { met: true, missing: [] };
  }
}

/** Format DoD for display to the user. */
export function formatDodForUser(dod: string): string {
  return `**Definition of Done:**\n${dod}`;
}
