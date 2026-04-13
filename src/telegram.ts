/**
 * Telegram interface — Grammy bot routing messages to the Atlas conscious agent.
 *
 * Atlas v2 additions vs Hermes reference:
 * - /onboarding command: show remaining questions and completion status
 * - First message handler: sends onboarding greeting if not yet started
 * - AtlasAgent naming throughout
 *
 * Commands:
 *   /score        — today's performance metrics
 *   /pin          — pin a context chunk
 *   /unpin        — remove a pinned context
 *   /status       — system status summary
 *   /experiments  — list active evolution experiments
 *   /insights     — principles + recent high-quality dreams
 *   /blindspots   — show blindspots.md
 *   /review       — recent experiments summary
 *   /reflect      — trigger a reflection cycle now
 *   /forget       — alias for /unpin
 *   /memory       — show pinned contexts
 *   /dream        — show recent dreams
 *   /quiet        — suppress subconscious notifications for 24h
 *   /onboarding   — show onboarding progress and remaining questions
 */

import { Bot, type Context as GrammyContext } from "grammy";
import Database from "better-sqlite3";
import { AtlasAgent } from "./agent.js";
import {
  getPinnedContexts,
  addPinnedContext,
  removePinnedContext,
} from "./memory.js";
import {
  getTodayMetrics,
  getRollingAverage,
  formatMetrics,
} from "./metrics.js";
import {
  type SubconsciousState,
  setQuietMode,
  clearQuietMode as _clearQuietMode,
} from "./subconscious.js";
import {
  isOnboardingComplete,
  getNextQuestions,
  QUESTION_BANK,
  buildOnboardingGreeting,
} from "./onboarding.js";
import fs from "fs";
import path from "path";

export interface TelegramBotOptions {
  token: string;
  db: Database.Database;
  agent: AtlasAgent;
  subconsciousState: SubconsciousState;
  mindPath?: string;
}

const QUIET_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Track per-chat state
const chatSessions = new Map<number, { lastActivity: number; greetingSent: boolean }>();

function getChatSession(chatId: number): { lastActivity: number; greetingSent: boolean } {
  if (!chatSessions.has(chatId)) {
    chatSessions.set(chatId, { lastActivity: Date.now(), greetingSent: false });
  }
  return chatSessions.get(chatId)!;
}

/** Send a long message split across multiple Telegram messages (4000 char limit). */
async function sendLong(ctx: GrammyContext, text: string): Promise<void> {
  const MAX = 4000;
  if (text.length <= MAX) {
    await ctx.reply(text);
    return;
  }
  for (let i = 0; i < text.length; i += MAX) {
    await ctx.reply(text.slice(i, i + MAX));
  }
}

/** Create and configure the Telegram bot. */
export function createBot(options: TelegramBotOptions): Bot {
  const { token, db, agent, subconsciousState } = options;
  const mindPath = options.mindPath ?? process.cwd();

  const bot = new Bot(token);

  // ── /score ──────────────────────────────────────────────────────────────────

  bot.command("score", async (ctx) => {
    const today = getTodayMetrics(db);
    const rolling = getRollingAverage(db, 7);
    await ctx.reply(`Today:\n${formatMetrics(today)}\n\n7-day rolling:\n${formatMetrics(rolling)}`);
  });

  // ── /pin ────────────────────────────────────────────────────────────────────

  bot.command("pin", async (ctx) => {
    const args = ctx.message?.text?.slice("/pin".length).trim() ?? "";
    const spaceIdx = args.indexOf(" ");
    if (spaceIdx === -1) {
      await ctx.reply("Usage: /pin <label> <content>");
      return;
    }
    addPinnedContext(db, args.slice(0, spaceIdx), args.slice(spaceIdx + 1), "user");
    await ctx.reply(`Pinned: ${args.slice(0, spaceIdx)}`);
  });

  // ── /unpin ──────────────────────────────────────────────────────────────────

  bot.command("unpin", async (ctx) => {
    const label = ctx.message?.text?.slice("/unpin".length).trim() ?? "";
    if (!label) { await ctx.reply("Usage: /unpin <label>"); return; }
    const removed = removePinnedContext(db, label);
    await ctx.reply(removed ? `Unpinned: ${label}` : `Not found: ${label}`);
  });

  // ── /status ─────────────────────────────────────────────────────────────────

  bot.command("status", async (ctx) => {
    const pinned = getPinnedContexts(db);
    const episodeCount = (db.prepare("SELECT COUNT(*) as cnt FROM episodes").get() as { cnt: number }).cnt;
    const factCount = (db.prepare("SELECT COUNT(*) as cnt FROM facts").get() as { cnt: number }).cnt;
    const dreamCount = (db.prepare("SELECT COUNT(*) as cnt FROM dreams").get() as { cnt: number }).cnt;
    const onboardingDone = isOnboardingComplete(db);

    const quietStatus =
      subconsciousState.quietUntil && Date.now() < subconsciousState.quietUntil
        ? `quiet until ${new Date(subconsciousState.quietUntil).toISOString()}`
        : "active";

    await ctx.reply(
      [
        `Episodes: ${episodeCount}`,
        `Facts: ${factCount}`,
        `Dreams: ${dreamCount}`,
        `Pinned contexts: ${pinned.length}`,
        `Onboarding: ${onboardingDone ? "complete" : "in progress"}`,
        `Subconscious: ${quietStatus}`,
        `Notifications today: ${subconsciousState.notificationCount}/${3}`,
      ].join("\n")
    );
  });

  // ── /experiments ────────────────────────────────────────────────────────────

  bot.command("experiments", async (ctx) => {
    let exps: Array<{
      id: number;
      type: string;
      target_file: string;
      hypothesis: string;
      status: string;
      proposed_at: string;
    }>;

    try {
      exps = db
        .prepare(
          `SELECT id, type, target_file, hypothesis, status, proposed_at
           FROM experiments ORDER BY proposed_at DESC LIMIT 10`
        )
        .all() as typeof exps;
    } catch {
      await ctx.reply("Could not read experiments table.");
      return;
    }

    if (exps.length === 0) { await ctx.reply("No experiments yet."); return; }

    const lines = exps.map(
      (e) => `[${e.id}] ${e.status} | ${e.type} | ${e.target_file}\n${(e.hypothesis ?? "").slice(0, 80)}`
    );
    await sendLong(ctx, lines.join("\n\n"));
  });

  // ── /insights ───────────────────────────────────────────────────────────────

  bot.command("insights", async (ctx) => {
    const principlesPath = path.join(mindPath, "principles.md");
    const principlesContent = fs.existsSync(principlesPath)
      ? fs.readFileSync(principlesPath, "utf-8").slice(0, 800)
      : "(no principles.md found)";

    const dreams = db
      .prepare(
        `SELECT content, dream_type, created_at FROM dreams
         WHERE quality_score >= 0.7 ORDER BY created_at DESC LIMIT 5`
      )
      .all() as Array<{ content: string; dream_type: string; created_at: string }>;

    const dreamLines = dreams.map(
      (d) => `[${d.created_at.slice(0, 16).replace("T", " ")} | ${d.dream_type}]\n${d.content.slice(0, 200)}`
    );

    await sendLong(
      ctx,
      [
        "**Principles**",
        principlesContent,
        "",
        "**Recent high-quality dreams**",
        dreamLines.length > 0 ? dreamLines.join("\n\n") : "(none yet)",
      ].join("\n")
    );
  });

  // ── /blindspots ─────────────────────────────────────────────────────────────

  bot.command("blindspots", async (ctx) => {
    const blindspotsPath = path.join(mindPath, "blindspots.md");
    if (!fs.existsSync(blindspotsPath)) {
      await ctx.reply("No blindspots.md found.");
      return;
    }
    await sendLong(ctx, fs.readFileSync(blindspotsPath, "utf-8").slice(0, 3000));
  });

  // ── /review ─────────────────────────────────────────────────────────────────

  bot.command("review", async (ctx) => {
    let exps: Array<{
      id: number;
      type: string;
      target_file: string;
      hypothesis: string;
      status: string;
      proposed_at: string;
      effect_size: number | null;
    }>;

    try {
      exps = db
        .prepare(
          `SELECT id, type, target_file, hypothesis, status, proposed_at, effect_size
           FROM experiments ORDER BY proposed_at DESC LIMIT 10`
        )
        .all() as typeof exps;
    } catch {
      await ctx.reply("Could not read experiments.");
      return;
    }

    if (exps.length === 0) { await ctx.reply("No experiments found."); return; }

    const statusEmoji = (s: string): string => {
      if (s === "kept") return "✓";
      if (s === "reverted") return "↩";
      if (s === "proposed-only") return "~";
      return "...";
    };

    const lines = exps.map((e) => {
      const effectStr = e.effect_size != null ? ` | effect: ${e.effect_size.toFixed(2)}` : "";
      return [
        `${statusEmoji(e.status)} ${e.type} — ${e.target_file}${effectStr}`,
        `${(e.hypothesis ?? "").slice(0, 80)}`,
      ].join("\n");
    });

    await sendLong(ctx, lines.join("\n\n"));
  });

  // ── /reflect ────────────────────────────────────────────────────────────────

  bot.command("reflect", async (ctx) => {
    await ctx.reply("Running reflection cycle...");
    try {
      const { promotePatternsWeekly } = await import("./reflection.js");
      await promotePatternsWeekly(db, mindPath);
      await ctx.reply("Reflection complete. Check patterns.md.");
    } catch (err) {
      await ctx.reply(`Reflection failed: ${String(err)}`);
    }
  });

  // ── /forget ─────────────────────────────────────────────────────────────────

  bot.command("forget", async (ctx) => {
    const label = ctx.message?.text?.slice("/forget".length).trim() ?? "";
    if (!label) { await ctx.reply("Usage: /forget <label>"); return; }
    const removed = removePinnedContext(db, label);
    await ctx.reply(removed ? `Forgot: ${label}` : `Not found: ${label}`);
  });

  // ── /memory ─────────────────────────────────────────────────────────────────

  bot.command("memory", async (ctx) => {
    const pinned = getPinnedContexts(db);
    if (pinned.length === 0) { await ctx.reply("No pinned contexts."); return; }
    const lines = pinned.map((p) => `[${p.label}]\n${p.content.slice(0, 200)}`);
    await sendLong(ctx, lines.join("\n\n"));
  });

  // ── /dream ──────────────────────────────────────────────────────────────────

  bot.command("dream", async (ctx) => {
    const dreams = db
      .prepare(
        `SELECT dream_type, content, quality_score, created_at
         FROM dreams ORDER BY created_at DESC LIMIT 5`
      )
      .all() as Array<{
      dream_type: string;
      content: string;
      quality_score: number;
      created_at: string;
    }>;

    if (dreams.length === 0) { await ctx.reply("No dreams yet."); return; }

    const lines = dreams.map(
      (d) =>
        `[${d.dream_type} | score: ${d.quality_score.toFixed(2)} | ${d.created_at.slice(0, 10)}]\n${d.content.slice(0, 300)}`
    );
    await sendLong(ctx, lines.join("\n\n---\n\n"));
  });

  // ── /quiet ──────────────────────────────────────────────────────────────────

  bot.command("quiet", async (ctx) => {
    setQuietMode(subconsciousState, QUIET_DURATION_MS);
    await ctx.reply("Subconscious notifications silenced for 24h.");
  });

  // ── /onboarding ─────────────────────────────────────────────────────────────

  bot.command("onboarding", async (ctx) => {
    const complete = isOnboardingComplete(db);

    if (complete) {
      await ctx.reply("Onboarding complete. I know what I need to know.");
      return;
    }

    const answered = db
      .prepare("SELECT question_id FROM onboarding WHERE answered = 1 AND (answer IS NULL OR answer != '__skipped__')")
      .all() as Array<{ question_id: string }>;

    const skipped = db
      .prepare("SELECT question_id FROM onboarding WHERE answer = '__skipped__'")
      .all() as Array<{ question_id: string }>;

    const answeredIds = new Set(answered.map((r) => r.question_id));
    const skippedIds = new Set(skipped.map((r) => r.question_id));

    const remaining = QUESTION_BANK.filter(
      (q) => !answeredIds.has(q.id) && !skippedIds.has(q.id)
    );

    const next = getNextQuestions(db, 2);

    const lines = [
      `Onboarding in progress:`,
      `  Answered: ${answeredIds.size}/${QUESTION_BANK.length}`,
      `  Skipped: ${skippedIds.size}`,
      `  Remaining: ${remaining.length}`,
      ``,
      `Next questions:`,
      ...next.map((q) => `  [Tier ${q.tier}] ${q.question}`),
    ];

    await ctx.reply(lines.join("\n"));
  });

  // ── Main message handler ─────────────────────────────────────────────────────

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text;

    // Commands are handled above
    if (text.startsWith("/")) return;

    const session = getChatSession(chatId);
    session.lastActivity = Date.now();

    // First ever message → send onboarding greeting if available
    if (!session.greetingSent) {
      session.greetingSent = true;
      const greeting = buildOnboardingGreeting(db);
      if (greeting) {
        await ctx.reply(greeting);
        return;
      }
    }

    await ctx.replyWithChatAction("typing");

    try {
      const response = await agent.processMessage(text);
      await sendLong(ctx, response);
    } catch (err) {
      console.error("[telegram] Error processing message:", err);
      await ctx.reply("Error processing your message. Please try again.");
    }
  });

  bot.catch((err) => {
    console.error("[telegram] Bot error:", err);
  });

  return bot;
}

/** Send a notification message to a specific chat. */
export async function sendNotification(
  bot: Bot,
  chatId: number,
  text: string
): Promise<void> {
  try {
    const MAX = 4000;
    const truncated = text.length > MAX ? text.slice(0, MAX) + "..." : text;
    await bot.api.sendMessage(chatId, truncated);
  } catch (err) {
    console.error("[telegram] Failed to send notification:", err);
  }
}
