import { NextResponse } from "next/server";
import { readFeedback, updateFeedback } from "@/lib/feedback";
import { runTriage } from "@/lib/triage";
import type { FeedbackEntry } from "@/lib/feedback-types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Triage one entry, several entries, or an entry supplied inline.
 *
 * The inline form exists because of a real production bug. Feedback was written to the
 * instance temp directory, the triage request landed on a different instance, and the
 * lookup by id returned "unknown feedback". The endpoint reported success, wrote its
 * result to a third instance, and the console showed nothing had changed — so the button
 * looked broken while every individual request was behaving correctly.
 *
 * Accepting the entry in the request body removes the dependency on shared state
 * entirely. The caller already holds the entry; making it prove that is cheaper and more
 * honest than pretending a serverless filesystem is a database.
 */
export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "not_configured", message: "ANTHROPIC_API_KEY is not set." },
      { status: 503 }
    );
  }

  let body: { id?: string; all?: boolean; entry?: FeedbackEntry };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON." }, { status: 400 });
  }

  // Inline entry — stateless, and the path the UI uses.
  if (body.entry && body.entry.answer) {
    const result = await runTriage(body.entry, apiKey);
    if (!result.ok) {
      return NextResponse.json({ error: "analysis_failed", message: result.reason }, { status: 502 });
    }
    // Best-effort persistence. If the store is ephemeral this is a no-op that costs
    // nothing, because the analysis is also returned to the caller.
    try {
      updateFeedback(body.entry.id, { analysis: result.analysis });
    } catch {
      /* ephemeral store — the response is the source of truth */
    }
    return NextResponse.json({ analysed: 1, analysis: result.analysis, id: body.entry.id });
  }

  const stored = readFeedback();
  const targets = body.all
    ? stored.filter((e) => !e.analysis)
    : stored.filter((e) => e.id === body.id);

  if (targets.length === 0) {
    return NextResponse.json(
      {
        error: "not_found",
        message: body.all
          ? "Nothing left to triage on this instance."
          : "That entry is not present on this instance — send the entry inline instead.",
      },
      { status: 404 }
    );
  }

  const done: { id: string; analysis: FeedbackEntry["analysis"] }[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const entry of targets.slice(0, 25)) {
    const result = await runTriage(entry, apiKey);
    if (!result.ok) {
      failed.push({ id: entry.id, reason: result.reason });
      continue;
    }
    try {
      updateFeedback(entry.id, { analysis: result.analysis });
    } catch {
      /* ephemeral */
    }
    done.push({ id: entry.id, analysis: result.analysis });
  }

  // Analyses are returned, not merely stored, so the caller can hold them regardless of
  // whether the next request reaches this instance.
  return NextResponse.json({ analysed: done.length, failed, results: done });
}
