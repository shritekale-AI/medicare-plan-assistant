import { NextResponse } from "next/server";
import { MODELS } from "@/lib/config";
import { corpusStats } from "@/lib/retrieval";
import {
  appendFeedback,
  feedbackStats,
  newId,
  readFeedback,
  REVIEWER_ROLES,
  type FeedbackEntry,
  type FeedbackEvidence,
  type Rating,
  type ReviewerRole,
} from "@/lib/feedback";

export const runtime = "nodejs";

const MAX_COMMENT = 4000;
const VALID_ROLES = new Set(REVIEWER_ROLES.map((r) => r.value));

/**
 * POST — a reviewer rates one answer.
 *
 * The rating alone is nearly useless for acting on; what makes it actionable is the
 * context captured alongside it. So the exchange, the tools called, the passages
 * retrieved, and the build/corpus/model versions are all stored with it. Without the
 * corpus version in particular, a complaint from three weeks ago cannot be evaluated
 * — the documents may have been revised since, and the answer may have been right at
 * the time.
 */
export async function POST(req: Request) {
  let body: {
    rating?: Rating;
    comment?: string;
    reviewerRole?: ReviewerRole;
    question?: string;
    answer?: string;
    toolsUsed?: string[];
    evidence?: FeedbackEvidence[];
    commit?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON." }, { status: 400 });
  }

  if (body.rating !== "up" && body.rating !== "down") {
    return NextResponse.json(
      { error: "bad_request", message: "rating must be 'up' or 'down'." },
      { status: 400 }
    );
  }
  if (!body.answer || typeof body.answer !== "string") {
    return NextResponse.json(
      { error: "bad_request", message: "answer is required — feedback without the answer it judges cannot be triaged." },
      { status: 400 }
    );
  }

  const role: ReviewerRole =
    body.reviewerRole && VALID_ROLES.has(body.reviewerRole) ? body.reviewerRole : "other";

  const entry: FeedbackEntry = {
    id: newId(),
    createdAt: new Date().toISOString(),
    rating: body.rating,
    comment: (body.comment ?? "").slice(0, MAX_COMMENT),
    reviewerRole: role,
    question: (body.question ?? "").slice(0, MAX_COMMENT),
    answer: body.answer.slice(0, 20_000),
    toolsUsed: Array.isArray(body.toolsUsed) ? body.toolsUsed.slice(0, 20) : [],
    evidence: Array.isArray(body.evidence) ? body.evidence.slice(0, 8) : [],
    commit: body.commit ?? "unknown",
    corpusVersion: corpusStats().corpusVersion,
    model: MODELS.primary,
  };

  try {
    appendFeedback(entry);
  } catch (err) {
    // Ephemeral filesystems are the expected failure here. Say so rather than
    // pretending the feedback was kept.
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: "store_unavailable", message: `Could not persist feedback: ${message}` },
      { status: 503 }
    );
  }

  return NextResponse.json({ ok: true, id: entry.id });
}

/** GET — the admin list, newest first, with a roll-up. */
export async function GET() {
  const entries = readFeedback();
  return NextResponse.json({ entries, stats: feedbackStats(entries) });
}
