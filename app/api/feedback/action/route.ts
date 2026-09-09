import { NextResponse } from "next/server";
import { readFeedback, updateFeedback } from "@/lib/feedback";
import { runTriage } from "@/lib/triage";
import {
  appendLearnedRule,
  learnedRulesBlock,
  learnedStoreDurable,
  readLearnedRules,
  removeLearnedRule,
  validateRule,
} from "@/lib/learned";
import type { ActionKind, FeedbackAction, FeedbackEntry } from "@/lib/feedback-types";

export const runtime = "nodejs";
export const maxDuration = 60;

const VALID: ActionKind[] = ["none", "golden_set", "prompt_change", "wont_fix", "escalated"];

/**
 * Record what a human decided, and — for an accepted prompt change — actually apply it.
 *
 * WHY THE RULE IS RE-DERIVED SERVER-SIDE
 * The obvious implementation takes the promptFix the client already has and stores it.
 * That would mean text chosen by the browser is spliced into a system prompt, which is
 * a privilege-escalation bug wearing the costume of a feature: anyone who can call this
 * endpoint could author instructions for the assistant.
 *
 * So accepting a prompt change re-runs triage on the feedback content and stores the
 * rule THAT produces. Feedback text is still user-authored, but it reaches the model as
 * data inside a triage prompt rather than as instruction — the same boundary the
 * retrieval layer draws around documents. The rule is then filtered against a denylist
 * and capped, and a human has already approved the intent.
 *
 * The golden-set action stays a decision record: appending to the suite that gates
 * release is a pull request, not a button.
 */
export async function POST(req: Request) {
  let body: { id?: string; kind?: ActionKind; note?: string; entry?: FeedbackEntry };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON." }, { status: 400 });
  }

  if (!body.kind || !VALID.includes(body.kind)) {
    return NextResponse.json(
      { error: "bad_request", message: `kind must be one of: ${VALID.join(", ")}` },
      { status: 400 }
    );
  }

  // Prefer the inline entry; fall back to the store for the console's seeded rows.
  const entry: FeedbackEntry | undefined =
    body.entry && body.entry.answer ? body.entry : readFeedback().find((e) => e.id === body.id);

  if (!entry) {
    return NextResponse.json(
      { error: "not_found", message: "That entry is not present on this instance — send it inline." },
      { status: 404 }
    );
  }

  const action: FeedbackAction = {
    kind: body.kind,
    takenAt: new Date().toISOString(),
    note: (body.note ?? "").slice(0, 2000) || undefined,
  };

  let applied: { rule: string; section: string; active: number } | null = null;

  if (body.kind === "prompt_change") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "not_configured", message: "ANTHROPIC_API_KEY is not set." },
        { status: 503 }
      );
    }

    // Re-derive rather than trust the client's copy.
    const result = await runTriage(entry, apiKey);
    if (!result.ok) {
      return NextResponse.json({ error: "analysis_failed", message: result.reason }, { status: 502 });
    }
    const fix = result.analysis.promptFix;
    if (!fix) {
      return NextResponse.json(
        {
          error: "no_candidate",
          message:
            "Triage did not produce a prompt rule for this one. That usually means the fix belongs in code, or the reviewer's objection was not a behavioural defect.",
        },
        { status: 409 }
      );
    }

    const verdict = validateRule({
      section: fix.section,
      rule: fix.rule,
      rationale: fix.rationale,
      verification: fix.verification,
      fromFeedback: entry.id,
      reviewerRole: entry.reviewerRole,
    });
    if (!verdict.ok) {
      return NextResponse.json({ error: "rule_rejected", message: verdict.reason }, { status: 422 });
    }

    try {
      appendLearnedRule(verdict.rule);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      return NextResponse.json(
        { error: "store_unavailable", message: `Could not store the rule: ${message}` },
        { status: 503 }
      );
    }

    action.accepted = { promptFix: fix };
    applied = {
      rule: verdict.rule.rule,
      section: verdict.rule.section,
      active: readLearnedRules().length,
    };
  }

  if (body.kind === "golden_set") {
    action.accepted = { goldenSetCase: entry.analysis?.goldenSetCase };
  }

  try {
    updateFeedback(entry.id, { action });
  } catch {
    /* ephemeral store — the response carries the outcome */
  }

  return NextResponse.json({
    ok: true,
    action,
    applied,
    durable: learnedStoreDurable(),
  });
}

/** GET — the live rules and everything a human approved, shaped for a pull request. */
export async function GET() {
  const rules = readLearnedRules();
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

  return NextResponse.json({
    learnedRules: rules,
    durable: learnedStoreDurable(),
    promptOverlay: learnedRulesBlock(),
    goldenSet,
    counts: { learnedRules: rules.length, goldenSet: goldenSet.length },
  });
}

/** DELETE — revoke an accepted rule. It stops affecting answers on the next turn. */
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "bad_request", message: "id is required." }, { status: 400 });
  }
  const removed = removeLearnedRule(id);
  return NextResponse.json({ ok: removed, remaining: readLearnedRules().length });
}
