/**
 * Conscious agent — Claude via pi-agent-core with retrieval-augmented generation.
 *
 * Atlas v2 differences from Hermes reference:
 * - Uses consciousModel / consciousStreamFn from llm.ts (proxy or direct Anthropic)
 * - No apiKey in options — handled by llm.ts
 * - Onboarding: weaves a question into the response at natural pauses
 * - webSearch tool: curl DuckDuckGo HTML endpoint, no API key required
 * - mindPath defaults to process.cwd() (knowledge files at project root)
 */

import { Agent, type AgentTool, type AgentEvent, type StreamFn } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { consciousModel, consciousStreamFn } from "./llm.js";
import type { TObject, TString, Static } from "@sinclair/typebox";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import {
  storeEpisode,
  extractFromConversation,
  updateFacts,
  type ConversationMessage,
} from "./memory.js";
import { retrieve, buildContextString } from "./retrieval.js";
import {
  logInteraction,
  detectCorrection,
  computeDailyMetrics,
  formatMetrics,
  getTodayMetrics,
} from "./metrics.js";
import { isTask, proposeDod, formatDodForUser } from "./dod.js";
import { logMistake, updatePreferences } from "./reflection.js";
import { getOnboardingQuestion, isOnboardingComplete, skipQuestion } from "./onboarding.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AtlasAgentOptions {
  db: Database.Database;
  mindPath?: string;
  sessionId?: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// ─── Tool schema types ────────────────────────────────────────────────────────

type ReadSchema = TObject<{ path: TString }>;
type WriteSchema = TObject<{ path: TString; content: TString }>;
type EditSchema = TObject<{ path: TString; old_string: TString; new_string: TString }>;
type BashSchema = TObject<{ command: TString }>;
type WebSearchSchema = TObject<{ query: TString }>;

// ─── Tool definitions ──────────────────────────────────────────────────────────

function buildTools(): AgentTool[] {
  const readTool: AgentTool<ReadSchema> = {
    name: "read",
    label: "Read file",
    description: "Read the contents of a file at the given path.",
    parameters: Type.Object({ path: Type.String({ description: "File path to read" }) }),
    execute: async (_id, params: Static<ReadSchema>) => {
      try {
        const content = fs.readFileSync(params.path, "utf-8");
        return {
          content: [{ type: "text" as const, text: content }],
          details: { path: params.path },
        };
      } catch (err) {
        throw new Error(`read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };

  const writeTool: AgentTool<WriteSchema> = {
    name: "write",
    label: "Write file",
    description: "Write content to a file, creating it if it doesn't exist.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to write" }),
      content: Type.String({ description: "Content to write" }),
    }),
    execute: async (_id, params: Static<WriteSchema>) => {
      try {
        fs.mkdirSync(path.dirname(params.path), { recursive: true });
        fs.writeFileSync(params.path, params.content, "utf-8");
        return {
          content: [{ type: "text" as const, text: `Written ${params.path}` }],
          details: {},
        };
      } catch (err) {
        throw new Error(`write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };

  const editTool: AgentTool<EditSchema> = {
    name: "edit",
    label: "Edit file",
    description: "Replace a specific string in a file with a new string.",
    parameters: Type.Object({
      path: Type.String({ description: "File path to edit" }),
      old_string: Type.String({ description: "Exact string to replace" }),
      new_string: Type.String({ description: "Replacement string" }),
    }),
    execute: async (_id, params: Static<EditSchema>) => {
      try {
        const content = fs.readFileSync(params.path, "utf-8");
        if (!content.includes(params.old_string)) {
          throw new Error(`String not found in ${params.path}`);
        }
        fs.writeFileSync(params.path, content.replace(params.old_string, params.new_string), "utf-8");
        return {
          content: [{ type: "text" as const, text: `Edited ${params.path}` }],
          details: {},
        };
      } catch (err) {
        throw new Error(`edit failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };

  const bashTool: AgentTool<BashSchema> = {
    name: "bash",
    label: "Run bash command",
    description: "Execute a bash command and return its output. Use for file operations, git, and searches.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run" }),
    }),
    execute: async (_id, params: Static<BashSchema>) => {
      try {
        const output = execSync(params.command, { encoding: "utf-8", timeout: 30000 });
        return {
          content: [{ type: "text" as const, text: output }],
          details: { command: params.command },
        };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        throw new Error((e.stdout ?? "") + (e.stderr ?? e.message ?? ""));
      }
    },
  };

  /**
   * Web search via DuckDuckGo HTML endpoint.
   * No API key required — uses curl to scrape result links.
   */
  const webSearchTool: AgentTool<WebSearchSchema> = {
    name: "web_search",
    label: "Web search",
    description: "Search the web for information. Returns top result URLs and snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    execute: async (_id, params: Static<WebSearchSchema>) => {
      try {
        const encodedQuery = encodeURIComponent(params.query);
        // Use DuckDuckGo HTML endpoint — no API key needed
        const cmd = `curl -sL --max-time 10 -A "Mozilla/5.0" "https://html.duckduckgo.com/html/?q=${encodedQuery}" | grep -oP '(?<=class="result__url">)[^<]+' | head -5`;
        let urls: string[] = [];
        try {
          const raw = execSync(cmd, { encoding: "utf-8", timeout: 15000 });
          urls = raw.split("\n").map((u) => u.trim()).filter((u) => u.length > 5);
        } catch {
          // Fallback: just report query
          urls = [];
        }

        const text =
          urls.length > 0
            ? `Search results for "${params.query}":\n${urls.join("\n")}`
            : `No results found for "${params.query}". Try a more specific query or use bash with curl to fetch a specific URL.`;

        return {
          content: [{ type: "text" as const, text }],
          details: { query: params.query, resultCount: urls.length },
        };
      } catch (err) {
        throw new Error(`web_search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };

  return [readTool, writeTool, editTool, bashTool, webSearchTool] as unknown as AgentTool[];
}

// ─── System prompt ─────────────────────────────────────────────────────────────

/**
 * Build the system prompt from knowledge files at mindPath.
 * Reads: program.md, preferences.md, principles.md, blindspots.md
 */
function loadSystemPrompt(mindPath: string): string {
  const sections: string[] = ["# Atlas — System Prompt\n"];

  const files: Array<[string, string]> = [
    ["## Agent Program", path.join(mindPath, "program.md")],
    ["## Preferences", path.join(mindPath, "preferences.md")],
    ["## Principles", path.join(mindPath, "principles.md")],
    ["## Blindspots", path.join(mindPath, "blindspots.md")],
  ];

  for (const [label, filePath] of files) {
    if (fs.existsSync(filePath)) {
      sections.push(label);
      sections.push(fs.readFileSync(filePath, "utf-8"));
    }
  }

  return sections.join("\n\n");
}

// ─── Agent class ───────────────────────────────────────────────────────────────

export class AtlasAgent {
  private db: Database.Database;
  private mindPath: string;
  private sessionId: string;
  private agent: Agent;
  private sessionHistory: SessionMessage[] = [];
  private currentDod: string | null = null;
  private messageCount = 0;

  constructor(options: AtlasAgentOptions) {
    this.db = options.db;
    this.mindPath = options.mindPath ?? process.cwd();
    this.sessionId = options.sessionId ?? `session-${Date.now()}`;

    const systemPrompt = loadSystemPrompt(this.mindPath);

    this.agent = new Agent({
      initialState: {
        model: consciousModel,
        systemPrompt,
        tools: buildTools(),
      },
      streamFn: consciousStreamFn as unknown as StreamFn,
    });
  }

  /**
   * Process a user message and return the assistant response.
   * Handles retrieval, DoD, onboarding, logging, and episode storage.
   */
  async processMessage(userMessage: string): Promise<string> {
    const start = Date.now();
    this.messageCount++;

    // Detect user corrections
    const isCorrection = detectCorrection(userMessage);

    // Handle skip/not now for onboarding
    const skipSignals = ["skip", "not now", "later", "ask later", "no thanks"];
    if (skipSignals.some((s) => userMessage.toLowerCase().includes(s))) {
      const pending = this.db
        .prepare(
          "SELECT question_id FROM onboarding WHERE asked_at IS NOT NULL AND answered = 0 AND (answer IS NULL OR answer != '__skipped__') LIMIT 1"
        )
        .get() as { question_id: string } | undefined;
      if (pending) {
        skipQuestion(this.db, pending.question_id);
      }
    }

    // Retrieve relevant context
    const results = await retrieve(this.db, userMessage, 10, this.mindPath);
    const contextString = buildContextString(results);

    // Propose DoD for task messages
    let dodNote = "";
    if (isTask(userMessage) && !this.currentDod) {
      this.currentDod = await proposeDod(userMessage);
      dodNote = `\n\n${formatDodForUser(this.currentDod)}`;
    }

    // Build augmented message with retrieved context
    const augmented = contextString
      ? `${contextString}\n\nUser: ${userMessage}`
      : userMessage;

    // Reload system prompt to pick up mind file changes
    this.agent.state.systemPrompt = loadSystemPrompt(this.mindPath);

    // Collect the assistant response from events
    let assistantResponse = "";

    const unsubscribe = this.agent.subscribe(async (event: AgentEvent) => {
      if (event.type === "message_end") {
        const msg = event.message;
        if ("content" in msg && Array.isArray(msg.content)) {
          const textParts = msg.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text);
          if (textParts.length > 0) {
            assistantResponse = textParts.join("");
          }
        }
      }
    });

    try {
      await this.agent.prompt(augmented);
    } finally {
      unsubscribe();
    }

    const latencyMs = Date.now() - start;

    // Extract token usage from the last message
    const messages = this.agent.state.messages;
    let tokensInput = 0;
    let tokensOutput = 0;
    let tokensTotal = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if ("usage" in m && m.usage) {
        const u = m.usage as {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
        tokensInput = u.inputTokens ?? 0;
        tokensOutput = u.outputTokens ?? 0;
        tokensTotal = u.totalTokens ?? (tokensInput + tokensOutput);
        break;
      }
    }

    // Record session history
    this.sessionHistory.push(
      { role: "user", content: userMessage, timestamp: start },
      { role: "assistant", content: assistantResponse, timestamp: Date.now() }
    );

    // Store episode asynchronously (don't block response)
    this.storeSessionAsync(userMessage, assistantResponse).catch((err) =>
      console.error("[agent] Episode storage error:", err)
    );

    // Log interaction
    logInteraction(this.db, {
      sessionId: this.sessionId,
      userMessage,
      assistantResponse,
      tokensInput,
      tokensOutput,
      tokensTotal,
      platform: "telegram",
    });

    // Update daily metrics
    computeDailyMetrics(this.db, new Date().toISOString().slice(0, 10));

    // Handle correction: log mistake and update preferences
    if (isCorrection) {
      await logMistake(this.db, this.mindPath, {
        label: "user-correction",
        mistake: `User corrected response to: ${userMessage.slice(0, 200)}`,
        correction: "Identify what was wrong and adjust behavior",
      });
      await updatePreferences(this.mindPath, userMessage);
    }

    // Clear DoD after substantive response
    if (this.currentDod && assistantResponse.length > 100) {
      this.currentDod = null;
    }

    // Weave in onboarding question at natural pauses
    // Conditions: response is complete, onboarding not done, every 3rd message
    let onboardingNote = "";
    if (
      !isOnboardingComplete(this.db) &&
      this.messageCount % 3 === 0 &&
      assistantResponse.length > 0 &&
      !isCorrection
    ) {
      const question = getOnboardingQuestion(this.db);
      if (question) {
        onboardingNote = `\n\n---\nOne quick question while I have you: ${question.question}`;
      }
    }

    return assistantResponse + dodNote + onboardingNote;
  }

  /** Return formatted today's performance metrics. */
  async getScore(): Promise<string> {
    return formatMetrics(getTodayMetrics(this.db));
  }

  /** Reset the conversation history (start a new session). */
  resetSession(): void {
    this.agent.reset();
    this.sessionHistory = [];
    this.currentDod = null;
    this.messageCount = 0;
    this.sessionId = `session-${Date.now()}`;
  }

  /** Return a copy of the current session history. */
  getSessionHistory(): SessionMessage[] {
    return [...this.sessionHistory];
  }

  /** Store conversation as episode asynchronously. */
  private async storeSessionAsync(
    userMessage: string,
    assistantResponse: string
  ): Promise<void> {
    const messages: ConversationMessage[] = [
      { role: "user", content: userMessage },
      { role: "assistant", content: assistantResponse },
    ];

    const extracted = await extractFromConversation(messages);
    const episodeId = await storeEpisode(this.db, messages, extracted);

    if (extracted.entities.length > 0) {
      updateFacts(this.db, episodeId, extracted.entities);
    }
  }
}
