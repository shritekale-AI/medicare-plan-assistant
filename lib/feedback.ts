/**
 * Feedback persistence.
 *
 * SERVER ONLY — this imports `fs`. Client components must import from
 * `lib/feedback-types` instead. See the note there.
 *
 * STORAGE is a labelled seam, not a production design. Feedback is appended to a JSON
 * file, which works locally and on any single long-lived server. On Vercel the
 * filesystem is ephemeral, so entries survive only until the instance recycles. Real
 * UAT needs a datastore; `FEEDBACK_STORE_PATH` and the functions below are the whole
 * surface that would have to change.
 */

import fs from "fs";
import path from "path";
import type { FeedbackEntry } from "./feedback-types";

export * from "./feedback-types";

const STORE_PATH =
  process.env.FEEDBACK_STORE_PATH ?? path.join(process.cwd(), "data", "feedback.json");

export function readFeedback(): FeedbackEntry[] {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    return Array.isArray(parsed) ? (parsed as FeedbackEntry[]) : [];
  } catch {
    // A corrupt store must not take the app down — feedback is not load-bearing for
    // answering a member's question.
    return [];
  }
}

function writeAll(entries: FeedbackEntry[]): void {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(entries, null, 2));
}

export function appendFeedback(entry: FeedbackEntry): void {
  const all = readFeedback();
  all.unshift(entry);
  writeAll(all);
}

export function updateFeedback(id: string, patch: Partial<FeedbackEntry>): FeedbackEntry | null {
  const all = readFeedback();
  const i = all.findIndex((e) => e.id === id);
  if (i === -1) return null;
  all[i] = { ...all[i], ...patch };
  writeAll(all);
  return all[i];
}

/** Roll-up for the admin view. */
export function feedbackStats(entries: FeedbackEntry[]) {
  const down = entries.filter((e) => e.rating === "down");
  const analysed = entries.filter((e) => e.analysis);
  return {
    total: entries.length,
    up: entries.filter((e) => e.rating === "up").length,
    down: down.length,
    analysed: analysed.length,
    pending: entries.length - analysed.length,
    // The number worth watching: negative reviews the assessment did NOT agree with.
    // A high count means either the reviewers or the triage is miscalibrated, and
    // either way somebody needs to look.
    disputed: analysed.filter((e) => e.rating === "down" && e.analysis?.agrees === false).length,
    blockers: analysed.filter((e) => e.analysis?.severity === "blocker").length,
    goldenCandidates: analysed.filter((e) => e.analysis?.goldenSetCase).length,
  };
}

export function newId(): string {
  return `fb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
