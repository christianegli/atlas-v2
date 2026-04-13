/**
 * Subconscious module — continuous background processing loop.
 *
 * Runs in the background while the conscious agent handles conversations.
 * Each cycle (1-2 minute jitter) rolls the dice and runs one of:
 *
 *   30% REFLECTION      — promote patterns, monthly principles/blindspots
 *   12% EVOLUTION       — mutation ratchet
 *   16% MEMORY REPLAY   — surface patterns across old episodes
 *   14% CROSS-DOMAIN    — force cross-domain analogies
 *   10% EXTERNAL        — process feed items
 *    8% FORESIGHT        — predict failure modes
 *    7% SELF-INTERROGATION — challenge own principles
 *    3% NARRATIVE THREAD — build project story arcs
 */

import Database from "better-sqlite3";
import { hasUnprocessedEpisodes, extractFromConversation } from "./memory.js";
import {
  logMistake as _logMistake,
  promotePatternsWeekly,
  promotePrinciplesMonthly,
  detectBlindspotsMonthly,
} from "./reflection.js";
import { runEvolutionCycle } from "./evolution.js";
import {
  runMemoryReplay,
  runCrossDomainCollision,
  runExternalStimulation,
  runSelfInterrogation,
  runForesight,
  runNarrativeThread,
} from "./stimulation.js";
import { fetchAllFeeds } from "./feeds.js";
import fs from "fs";
import path from "path";

export interface SubconsciousState {
  running: boolean;
  notificationCount: number;
  notificationCountDate: string;
  quietUntil: number | null;
  lastFeedFetch: number;
}

const MAX_NOTIFICATIONS_PER_DAY = 3;
const FEED_FETCH_INTERVAL_MS = 120 * 60 * 1000; // 2 hours

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Process any episodes with missing summaries using Ollama extraction. */
async function processUnprocessedEpisodes(db: Database.Database): Promise<void> {
  const raw = db
    .prepare(
      `SELECT id, raw_messages FROM episodes
       WHERE (summary IS NULL OR summary = '') AND raw_messages IS NOT NULL LIMIT 5`
    )
    .all() as Array<{ id: number; raw_messages: string }>;

  for (const ep of raw) {
    try {
      const messages = JSON.parse(ep.raw_messages) as Array<{
        role: "user" | "assistant";
        content: string;
      }>;
      const extracted = await extractFromConversation(messages);

      db.prepare(`
        UPDATE episodes
        SET summary = ?, entities = ?, decisions = ?, commitments = ?, topics = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(
        extracted.summary,
        JSON.stringify(extracted.entities),
        JSON.stringify(extracted.decisions),
        JSON.stringify(extracted.commitments),
        JSON.stringify(extracted.topics),
        ep.id
      );
    } catch (err) {
      console.error("[subconscious] Failed to process episode", ep.id, err);
    }
  }
}

/**
 * Main subconscious loop. Call this once at startup and let it run indefinitely.
 * It will stop when state.running is set to false.
 */
export async function runSubconscious(
  db: Database.Database,
  mindPath: string,
  notifyFn: (content: string) => Promise<void>,
  state: SubconsciousState
): Promise<void> {
  const feedsPath = path.join(process.cwd(), "feeds.json");

  while (state.running) {
    // Jitter: 1–2 minutes between cycles
    const jitter = 60000 + Math.random() * 60000;

    try {
      const today = getDateString();

      // Reset notification count at midnight
      if (state.notificationCountDate !== today) {
        state.notificationCount = 0;
        state.notificationCountDate = today;
      }

      const isQuiet = state.quietUntil !== null && Date.now() < state.quietUntil;

      /** Notification wrapper: respects quiet mode and daily cap. */
      const throttledNotify = async (content: string): Promise<void> => {
        if (isQuiet) return;
        if (state.notificationCount >= MAX_NOTIFICATIONS_PER_DAY) return;
        state.notificationCount++;
        await notifyFn(content);
      };

      // Periodic feed fetch (every 2 hours)
      if (Date.now() - state.lastFeedFetch > FEED_FETCH_INTERVAL_MS) {
        await fetchAllFeeds(db, feedsPath);
        state.lastFeedFetch = Date.now();
      }

      // Contrarian provocation from stimuli.md (10% chance)
      if (Math.random() < 0.1) {
        const stimuliPath = path.join(mindPath, "stimuli.md");
        if (fs.existsSync(stimuliPath)) {
          const lines = fs
            .readFileSync(stimuliPath, "utf-8")
            .split("\n")
            .filter((l) => l.trim().startsWith("- "))
            .map((l) => l.replace(/^- /, "").trim());

          if (lines.length > 0) {
            const stimulus = lines[Math.floor(Math.random() * lines.length)];
            await throttledNotify(`[subconscious] Provocation:\n${stimulus}`);
          }
        }
      }

      // Main decision tree
      if (hasUnprocessedEpisodes(db)) {
        await processUnprocessedEpisodes(db);
      } else {
        const roll = Math.random();

        if (roll < 0.30) {
          // REFLECTION (30%)
          await promotePatternsWeekly(db, mindPath);
          const dayOfMonth = new Date().getDate();
          if (dayOfMonth === 1) {
            await promotePrinciplesMonthly(db, mindPath);
            await detectBlindspotsMonthly(db, mindPath);
          }
        } else if (roll < 0.42) {
          // EVOLUTION (12%)
          await runEvolutionCycle(db, mindPath);
        } else if (roll < 0.58) {
          // MEMORY REPLAY (16%)
          await runMemoryReplay(db, mindPath, throttledNotify);
        } else if (roll < 0.72) {
          // CROSS-DOMAIN (14%)
          await runCrossDomainCollision(db, mindPath, throttledNotify);
        } else if (roll < 0.82) {
          // EXTERNAL (10%)
          await runExternalStimulation(db, mindPath, throttledNotify);
        } else if (roll < 0.90) {
          // FORESIGHT (8%)
          await runForesight(db, mindPath, throttledNotify);
        } else if (roll < 0.97) {
          // SELF-INTERROGATION (7%)
          await runSelfInterrogation(db, mindPath, throttledNotify);
        } else {
          // NARRATIVE THREAD (3%)
          await runNarrativeThread(db, mindPath, throttledNotify);
        }
      }
    } catch (err) {
      console.error("[subconscious] Cycle error:", err);
    }

    await sleep(jitter);
  }
}

/** Create fresh subconscious state for a new run. */
export function createSubconsciousState(): SubconsciousState {
  return {
    running: true,
    notificationCount: 0,
    notificationCountDate: getDateString(),
    quietUntil: null,
    lastFeedFetch: 0,
  };
}

/** Silence subconscious notifications for durationMs milliseconds. */
export function setQuietMode(state: SubconsciousState, durationMs: number): void {
  state.quietUntil = Date.now() + durationMs;
}

/** Clear quiet mode immediately. */
export function clearQuietMode(state: SubconsciousState): void {
  state.quietUntil = null;
}
