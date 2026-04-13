/**
 * Feeds module — RSS/Atom feed fetching and deduplication.
 *
 * Feed configuration lives in feeds.json at the project root.
 * New items are stored in the feed_items table for the subconscious
 * to process during the EXTERNAL stimulation cycle.
 */

import Database from "better-sqlite3";
import fs from "fs";
import RSSParser from "rss-parser";

interface FeedConfig {
  url: string;
  category: string;
  name: string;
}

interface FeedsJson {
  feeds: FeedConfig[];
  fetchIntervalMinutes: number;
}

export interface FeedItem {
  id: number;
  url: string;
  title: string;
  content: string | null;
  summary: string | null;
  published_at: string | null;
  feed_name: string;
  category: string;
  processed: number;
  relevance_score: number | null;
}

const parser = new RSSParser({
  customFields: {
    item: ["summary", "content:encoded", "description"],
  },
});

/**
 * Fetch all configured feeds and store new items in the database.
 * Existing items (by URL) are skipped via INSERT OR IGNORE.
 */
export async function fetchAllFeeds(
  db: Database.Database,
  feedsPath: string
): Promise<void> {
  if (!fs.existsSync(feedsPath)) {
    console.warn("[feeds] feeds.json not found at", feedsPath, "— skipping feed fetch");
    return;
  }

  let config: FeedsJson;
  try {
    config = JSON.parse(fs.readFileSync(feedsPath, "utf-8")) as FeedsJson;
  } catch (err) {
    console.error("[feeds] Failed to parse feeds.json:", err);
    return;
  }

  if (!Array.isArray(config.feeds) || config.feeds.length === 0) return;

  for (const feed of config.feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);
      let newItems = 0;

      for (const item of parsed.items ?? []) {
        const url = item.link ?? item.guid ?? "";
        if (!url) continue;

        const title = item.title ?? "Untitled";
        const content =
          (item as unknown as Record<string, unknown>)["content:encoded"] as string ??
          item.content ??
          null;
        const summary = item.summary ?? item.contentSnippet ?? null;
        const publishedAt = item.pubDate ?? item.isoDate ?? null;

        try {
          db.prepare(`
            INSERT OR IGNORE INTO feed_items (url, title, content, summary, published_at, feed_name, category)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(url, title, content, summary, publishedAt, feed.name, feed.category);
          newItems++;
        } catch {
          // Duplicate URL — expected, skip
        }
      }

      console.log(`[feeds] ${feed.name}: ${newItems} new item(s)`);
    } catch (err) {
      console.warn(`[feeds] Failed to fetch ${feed.name} (${feed.url}):`, err);
    }
  }
}

/** Retrieve unprocessed feed items (up to 20). */
export function getUnprocessedItems(db: Database.Database): FeedItem[] {
  return db
    .prepare(`SELECT * FROM feed_items WHERE processed = 0 ORDER BY created_at DESC LIMIT 20`)
    .all() as FeedItem[];
}

/** Mark a feed item as processed, optionally recording its relevance score. */
export function markItemProcessed(
  db: Database.Database,
  itemId: number,
  relevanceScore?: number
): void {
  db.prepare("UPDATE feed_items SET processed = 1, relevance_score = ? WHERE id = ?").run(
    relevanceScore ?? null,
    itemId
  );
}
