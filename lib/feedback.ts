/**
 * Feedback persistence.
 *
 * SERVER ONLY — this imports `fs`. Client components must import from
 * `lib/feedback-types` instead.
 *
 * WHY THE STORE IS SHAPED LIKE THIS
 * Two files, for two different reasons.
 *
 * `data/feedback-seed.json` is committed and read-only. It holds worked examples so
 * the review console is populated the moment someone opens it — a triage queue that
 * demonstrates nothing until a reviewer has already used it is a bad first impression,
 * and the disputed cases in particular are the ones worth showing.
 *
 * The runtime store holds what reviewers actually submit. Its location is resolved at
 * call time rather than at module load, because the first deployment of this wrote to
 * `data/feedback.json` and every submission failed with EROFS: on Vercel the bundle
 * directory is read-only and only the OS temp directory is writable. That failure was
 * predicted in a comment and shipped anyway, which is the useful lesson — a "labelled
 * seam" is still a bug if a user hits it.
 *
 * Temp storage is per-instance and evaporates when the instance recycles, so this is
 * durable enough for a demo and NOT durable enough for real UAT. Setting
 * FEEDBACK_STORE_PATH to a mounted volume, or replacing the two IO functions with a
 * database client, is the whole change.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { FeedbackEntry } from "./feedback-types";

export * from "./feedback-types";

const SEED_PATH = path.join(process.cwd(), "data", "feedback-seed.json");

let resolvedStore: string | null = null;

/** Pick a writable location, preferring the repo path locally and temp on serverless. */
function storePath(): string {
  if (resolvedStore) return resolvedStore;

  const candidates = [
    process.env.FEEDBACK_STORE_PATH,
    path.join(process.cwd(), "data", "feedback.json"),
    path.join(os.tmpdir(), "humana-plan-assistant-feedback.json"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      // Probe rather than infer. Read-only filesystems fail at write, not at stat.
      fs.appendFileSync(candidate, "");
      resolvedStore = candidate;
      return candidate;
    } catch {
      // Try the next one.
    }
  }

  resolvedStore = path.join(os.tmpdir(), "humana-plan-assistant-feedback.json");
  return resolvedStore;
}

/** True when writes land somewhere that survives a redeploy. Surfaced in the admin UI. */
export function storeIsDurable(): boolean {
  return storePath().startsWith(os.tmpdir()) === false;
}

export function storeLocation(): string {
  return storePath();
}

function readJsonArray(file: string): FeedbackEntry[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf-8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FeedbackEntry[]) : [];
  } catch {
    // A corrupt store must not take the app down — feedback is not load-bearing for
    // answering a member's question.
    return [];
  }
}

/**
 * Runtime entries first, then any seed example the runtime store has not superseded.
 * Triaging a seed example copies it into the runtime store, so the override wins.
 */
export function readFeedback(): FeedbackEntry[] {
  const runtime = readJsonArray(storePath());
  const seen = new Set(runtime.map((e) => e.id));
  const seed = readJsonArray(SEED_PATH).filter((e) => !seen.has(e.id));
  return [...runtime, ...seed];
}

function writeRuntime(entries: FeedbackEntry[]): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2));
}

export function appendFeedback(entry: FeedbackEntry): void {
  const runtime = readJsonArray(storePath());
  runtime.unshift(entry);
  writeRuntime(runtime);
}

export function updateFeedback(id: string, patch: Partial<FeedbackEntry>): FeedbackEntry | null {
  const runtime = readJsonArray(storePath());
  const i = runtime.findIndex((e) => e.id === id);

  if (i !== -1) {
    runtime[i] = { ...runtime[i], ...patch };
    writeRuntime(runtime);
    return runtime[i];
  }

  // Seed entries live in a read-only file, so triaging one copies it forward.
  const seeded = readJsonArray(SEED_PATH).find((e) => e.id === id);
  if (!seeded) return null;
  const merged = { ...seeded, ...patch };
  runtime.unshift(merged);
  writeRuntime(runtime);
  return merged;
}

/** Roll-up for the admin view. */
export function feedbackStats(entries: FeedbackEntry[]) {
  const analysed = entries.filter((e) => e.analysis);
  return {
    total: entries.length,
    up: entries.filter((e) => e.rating === "up").length,
    down: entries.filter((e) => e.rating === "down").length,
    analysed: analysed.length,
    pending: entries.length - analysed.length,
    // The number worth watching: reviews the assessment did NOT agree with. A high
    // count means either the reviewers or the triage is miscalibrated, and either way
    // somebody needs to look.
    disputed: analysed.filter((e) => e.analysis?.agrees === false).length,
    blockers: analysed.filter((e) => e.analysis?.severity === "blocker").length,
    goldenCandidates: analysed.filter((e) => e.analysis?.goldenSetCase).length,
    actioned: entries.filter((e) => e.action && e.action.kind !== "none").length,
  };
}

export function newId(): string {
  return `fb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
