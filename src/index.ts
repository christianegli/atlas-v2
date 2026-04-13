/**
 * Atlas v2 — Entry point.
 *
 * Startup sequence:
 *   1. Load .env
 *   2. Check Ollama availability (log result)
 *   3. Initialize SQLite database
 *   4. Initialize onboarding table
 *   5. Create conscious agent
 *   6. Start subconscious loop
 *   7. Start Telegram bot
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN  — required
 *   TELEGRAM_CHAT_ID    — optional, for subconscious notifications
 *   DB_PATH             — default: <cwd>/data/atlas.db
 *   MIND_PATH           — default: process.cwd() (knowledge files at project root)
 *   PROXY_BASE_URL      — if set, use OpenAI-compatible proxy instead of direct Anthropic
 *   PROXY_API_KEY       — API key for proxy (default: sk-proxy-local-dummy)
 *   ANTHROPIC_API_KEY   — required when not using proxy
 *   MODEL_ID            — model to use (default: claude-sonnet-4-6)
 *   OLLAMA_BASE_URL     — Ollama base URL (default: http://localhost:11434)
 *   OLLAMA_MODEL        — model for subconscious tasks (default: gemma3:2b)
 *   OLLAMA_EMBED_MODEL  — embedding model (default: nomic-embed-text)
 */

import path from "path";
import fs from "fs";

// ─── Load .env ────────────────────────────────────────────────────────────────

function loadEnv(): void {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    console.warn("[index] No .env file found — using process environment");
    return;
  }

  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

// ─── Imports (after env load so env vars are available) ───────────────────────

import { initDb } from "./memory.js";
import { initOnboarding } from "./onboarding.js";
import { AtlasAgent } from "./agent.js";
import { createBot, sendNotification } from "./telegram.js";
import { runSubconscious, createSubconsciousState } from "./subconscious.js";
import { checkOllamaAvailable } from "./embeddings.js";
import { PROVIDER_MODE } from "./llm.js";

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required. Set it in .env or environment.");
  }

  // mindPath = project root (knowledge files live there, not in a subdirectory)
  const mindPath = process.env.MIND_PATH ?? process.cwd();
  const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), "data", "atlas.db");

  console.log(`[index] Atlas v2 starting`);
  console.log(`[index] Provider mode: ${PROVIDER_MODE}`);
  console.log(`[index] Mind path: ${mindPath}`);
  console.log(`[index] DB path: ${dbPath}`);

  // Check Ollama availability
  const ollamaOk = await checkOllamaAvailable();
  console.log(`[index] Ollama: ${ollamaOk ? "available" : "unavailable (degraded mode — no embeddings/reranking)"}`);

  // Ensure data directory exists
  const dataDir = path.dirname(dbPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Initialize database
  console.log("[index] Initializing database...");
  const db = initDb(dbPath);
  console.log("[index] Database ready");

  // Initialize onboarding table rows
  initOnboarding(db);
  console.log("[index] Onboarding initialized");

  // Create conscious agent
  const sessionId = `session-${Date.now()}`;
  const agent = new AtlasAgent({ db, mindPath, sessionId });
  console.log("[index] Agent initialized");

  // Create subconscious state
  const subconsciousState = createSubconsciousState();

  // Create Telegram bot
  const bot = createBot({
    token: botToken,
    db,
    agent,
    subconsciousState,
    mindPath,
  });

  // Notification function for subconscious
  const telegramChatId = process.env.TELEGRAM_CHAT_ID
    ? parseInt(process.env.TELEGRAM_CHAT_ID, 10)
    : null;

  const notifyFn = async (content: string): Promise<void> => {
    if (!telegramChatId) return;
    await sendNotification(bot, telegramChatId, content);
  };

  // Start subconscious loop in background
  console.log("[index] Starting subconscious loop...");
  runSubconscious(db, mindPath, notifyFn, subconsciousState).catch((err) => {
    console.error("[index] Subconscious loop crashed:", err);
  });

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[index] Received ${signal}, shutting down...`);
    subconsciousState.running = false;
    await bot.stop();
    db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Start bot
  console.log("[index] Starting Telegram bot...");
  await bot.start({
    onStart: (botInfo) => {
      console.log(`[index] Bot started: @${botInfo.username}`);
      console.log(`[index] Provider: ${PROVIDER_MODE} | Ollama: ${ollamaOk ? "on" : "off"}`);
    },
  });
}

main().catch((err) => {
  console.error("[index] Fatal error:", err);
  process.exit(1);
});
