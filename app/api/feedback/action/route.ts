import { NextResponse } from "next/server";
import { readFeedback, updateFeedback, type ActionKind, type FeedbackAction } from "@/lib/feedback";

export const runtime = "nodejs";

/**
 * Record what a human decided to do about a piece of feedback.
 *
 * WHY THIS DOES NOT APPLY THE CHANGE ITSELF
 * "Add to golden set" and "change the prompt" both sound like they should just happen.
 * They deliberately don't.
 *
 * The golden set is the thing that decides whether a release is safe. A queue that can
 * append to it unsupervised means a mistaken thumbs-up becomes a permanent assertion,
 * and every future change gets measured against it. The system prompt is worse: it is
 * the behavioural specification of a regulated product, and an agent rewriting it in
 * response to one review — with no eval run and no human reading the diff — is exactly
 * how a system drifts away from what compliance signed off on.
 *
 * So an action is a DECISION RECORD plus a staged artifact the reviewer can copy into
 * a pull request. The human merges it, CI runs the evals, and the change is reviewable
 * like any other behavioural change. That is slower on purpose.
 */

const VALID: ActionKind[] = ["none", "golden_set", "prompt_change", "wont_fix", "escalated"];

export async function POST(req: Request) {
  let body: { id?: string; kind?: ActionKind; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON." }, { status: 400 });
  }

  if (!body.id || !body.kind || !VALID.includes(body.kind)) {
    return NextResponse.json(
      { error: "bad_request", message: `kind must be one of: ${VALID.join(", ")}` },
      { status: 400 }
    );
  }

  const entry = readFeedback().find((e) => e.id === body.id);
  if (!entry) {
    return NextResponse.json({ error: "not_found", message: "Unknown feedback id." }, { status: 404 });
  }

  if (body.kind === "golden_set" && !entry.analysis?.goldenSetCase) {
    return NextResponse.json(
      { error: "no_candidate", message: "Triage did not propose a golden-set case for this one." },
      { status: 409 }
    );
  }
  if (body.kind === "prompt_change" && !entry.analysis?.promptFix) {
    return NextResponse.json(
      { error: "no_candidate", message: "Triage did not propose a prompt change for this one." },
      { status: 409 }
    );
  }

  // Snapshot what was accepted. A later re-triage may produce different wording, and
  // the record should say what the human actually approved, not what the model most
  // recently suggested.
  const action: FeedbackAction = {
    kind: body.kind,
    takenAt: new Date().toISOString(),
    note: (body.note ?? "").slice(0, 2000) || undefined,
    accepted:
      body.kind === "golden_set"
        ? { goldenSetCase: entry.analysis?.goldenSetCase }
        : body.kind === "prompt_change"
          ? { promptFix: entry.analysis?.promptFix }
          : undefined,
  };

  try {
    const updated = updateFeedback(entry.id, { action });
    return NextResponse.json({ ok: true, action: updated?.action ?? action });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    return NextResponse.json(
      { error: "store_unavailable", message: `Could not record the action: ${message}` },
      { status: 503 }
    );
  }
}

/**
 * GET — everything a human has approved, in a form that can go straight into a PR.
 * Golden-set cases come back in the shape evals/golden-set.json expects.
 */
export async function GET() {
  const entries = readFeedback().filter((e) => e.action && e.action.kind !== "none");

  const goldenSet = entries
    .filter((e) => e.action?.kind === "golden_set" && e.action.accepted?.goldenSetCase)
    .map((e) => {
      const g = e.action!.accepted!.goldenSetCase!;
      return {
        id: `from_feedback_${e.id}`,
        category: "regression",
        question: g.question,
        mustAppear: g.mustAppear,
        mustNotAppear: g.mustNotAppear,
        source: `reviewer feedback ${e.id} (${e.reviewerRole})`,
        rationale: g.rationale,
      };
    });

  const promptChanges = entries
    .filter((e) => e.action?.kind === "prompt_change" && e.action.accepted?.promptFix)
    .map((e) => ({ from: e.id, reviewer: e.reviewerRole, ...e.action!.accepted!.promptFix! }));

  return NextResponse.json({
    goldenSet,
    promptChanges,
    counts: { goldenSet: goldenSet.length, promptChanges: promptChanges.length, total: entries.length },
  });
}
