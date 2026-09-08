import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { MODELS } from "@/lib/config";
import { readFeedback, updateFeedback, type FeedbackAnalysis, type FeedbackEntry } from "@/lib/feedback";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Triage one piece of feedback.
 *
 * THE DESIGN POINT: this does not implement the reviewer's request. It assesses it.
 *
 * A queue that treats every complaint as a defect optimises for whoever complains
 * most, and in a regulated product that is actively dangerous — a compliance reviewer
 * flagging a correct, well-grounded answer is a real occurrence, and "fixing" it means
 * making the system less accurate to satisfy a misunderstanding. Equally, a reviewer
 * may be right for a reason they did not articulate. So the model is given the answer,
 * the passages it was built from, and the comment, and asked to judge the ANSWER
 * against its EVIDENCE — then say whether the reviewer's read holds.
 *
 * It is allowed to disagree, and when it does it must say why, in language a human
 * arbitrator can act on. Disagreements are surfaced as their own count in the admin
 * view precisely because they are the interesting cases.
 */

const ANALYSIS_SYSTEM = `You are triaging reviewer feedback on a Medicare plan assistant that is in pre-pilot review with UAT, legal, and compliance teams.

You will be given: the member's question, the assistant's answer, the passages the answer was actually built from, and a reviewer's rating plus comment.

WHAT THE ASSISTANT IS SUPPOSED TO DO:
- Explain and compare Medicare Advantage plans. Never recommend one — that is licensed activity.
- State every benefit, cost, or coverage fact only from a tool result or a retrieved document, with the document and page cited.
- Say plainly when it cannot find something, and offer a licensed human. Never fill a gap from general knowledge.
- Never give medical advice, never collect Medicare numbers or SSNs, never complete enrollment.
- Write for someone in their late sixties or seventies: short sentences, plain words, no jargon.

YOUR JOB — judge the ANSWER against the EVIDENCE first, then judge the reviewer's read of it.

Do not defer to the reviewer. They may be mistaken, may be applying a rule that does not exist, or may object to correct behaviour — for example objecting that the assistant "refused to recommend a plan", which is required, not a defect. They may also be right for a reason they did not state. Say which.

If the reviewer rated it DOWN and you think the answer was actually fine, set agrees=false and explain in disagreementNote what the reviewer likely misread and what a human arbitrator should check. If the reviewer rated it UP and the answer contains an unsupported or non-compliant claim, also set agrees=false — a positive review of a bad answer is the more dangerous error, because it gets locked in.

CATEGORIES:
- retrieval_miss — the right passage was not retrieved, so the answer was thin or wrong
- unsupported_claim — a claim not derivable from the retrieved passages, including an invented chapter/section locator
- wrong_fact — contradicts the passages or the plan data
- tone_or_clarity — accurate but too complex, too long, cold, or jargon-heavy for the audience
- compliance_risk — recommends a plan, gives medical advice, promises coverage, solicits identifiers, or creates false urgency
- out_of_scope — the assistant was asked for something it correctly does not do
- correct_as_is — the answer is sound and needs no change
- exemplary — the answer is sound AND worth locking in as a regression test

REMEDIATION must be concrete and addressed to the team, not the model. Good: "Add 'routine foot care' to the query-translation examples in lib/prompts.ts." Bad: "Improve retrieval." Return an empty list when nothing should change.

GOLDEN SET CASE — populate this ONLY when the answer is genuinely worth protecting (category exemplary, or correct_as_is where the behaviour is subtle and a future prompt change could plausibly break it). Assert BEHAVIOUR, never phrasing: mustAppear should be facts or moves that have to survive ("cites a page number", "names the specialist copay", "offers a licensed advocate"), mustNotAppear should be things that would signal regression ("best plan for you", "you should enrol"). A test asserting exact wording is a test that fails on an improvement.

Keep assessment under 120 words and each remediation item under 40. Be terse; this is a queue, not an essay.

Reply with JSON only, no fences. Use null for goldenSetCase and disagreementNote when they do not apply:
{"agrees":true,"confidence":"high","category":"correct_as_is","severity":"none","assessment":"...","remediation":[],"goldenSetCase":null,"disagreementNote":null}

When goldenSetCase DOES apply it must carry all four fields:
{"goldenSetCase":{"question":"the question to replay, verbatim","mustAppear":["..."],"mustNotAppear":["..."],"rationale":"why this behaviour is worth protecting"}}`;

/**
 * Coerce the model's enums into the ones the UI knows how to render.
 *
 * The first run returned severity "low", which is not in the set — reasonable English,
 * wrong vocabulary. TypeScript cannot enforce a shape that arrives as parsed JSON at
 * runtime, so anything outside the set is mapped rather than trusted. The alternative
 * is a badge that silently falls back and a filter that quietly misses rows.
 */
const SEVERITIES = ["blocker", "major", "minor", "none"] as const;
const CATEGORIES = [
  "retrieval_miss", "unsupported_claim", "wrong_fact", "tone_or_clarity",
  "compliance_risk", "out_of_scope", "correct_as_is", "exemplary",
] as const;

function normaliseSeverity(v: unknown): FeedbackAnalysis["severity"] {
  const s = String(v ?? "").toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(s)) return s as FeedbackAnalysis["severity"];
  if (s === "low" || s === "trivial" || s === "info") return "minor";
  if (s === "high" || s === "critical" || s === "severe") return "blocker";
  if (s === "medium" || s === "moderate") return "major";
  return "minor";
}

function normaliseCategory(v: unknown): FeedbackAnalysis["category"] {
  const c = String(v ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  return (CATEGORIES as readonly string[]).includes(c)
    ? (c as FeedbackAnalysis["category"])
    : "correct_as_is";
}

function extractJson(text: string): string {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const a = stripped.indexOf("{");
  const b = stripped.lastIndexOf("}");
  return a === -1 || b === -1 || b < a ? stripped : stripped.slice(a, b + 1);
}

function buildPrompt(e: FeedbackEntry): string {
  const passages =
    e.evidence.length > 0
      ? e.evidence
          .map((p, i) => `[Passage ${i + 1} — ${p.document}, page ${p.page}]\n${p.text}`)
          .join("\n\n")
      : "(No document passages were retrieved for this answer. If the answer states benefit or coverage facts anyway, that itself is the finding — unless those facts came from a structured tool, which the tool list below will show.)";

  return `MEMBER'S QUESTION:
${e.question || "(not captured)"}

ASSISTANT'S ANSWER:
${e.answer}

TOOLS THE ASSISTANT CALLED: ${e.toolsUsed.length > 0 ? e.toolsUsed.join(", ") : "none"}

PASSAGES THE ANSWER WAS BUILT FROM:
${passages}

---
REVIEWER: ${e.reviewerRole}
RATING: ${e.rating === "up" ? "THUMBS UP (positive)" : "THUMBS DOWN (negative)"}
COMMENT: ${e.comment || "(no comment left)"}`;
}

export async function POST(req: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "not_configured", message: "ANTHROPIC_API_KEY is not set." },
      { status: 503 }
    );
  }

  let body: { id?: string; all?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "Invalid JSON." }, { status: 400 });
  }

  const stored = readFeedback();
  // Either one entry, or every untriaged entry — reviewers arrive in batches, so
  // triaging one at a time would be the wrong ergonomics for the admin.
  const targets = body.all
    ? stored.filter((e) => !e.analysis)
    : stored.filter((e) => e.id === body.id);

  if (targets.length === 0) {
    return NextResponse.json(
      { error: "not_found", message: body.all ? "Nothing left to analyse." : "Unknown feedback id." },
      { status: 404 }
    );
  }

  const anthropic = new Anthropic({ apiKey });
  const done: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const entry of targets.slice(0, 25)) {
    try {
      const res = await anthropic.messages.create({
        model: MODELS.primary,
        max_tokens: 4000,
        system: ANALYSIS_SYSTEM,
        messages: [{ role: "user", content: buildPrompt(entry) }],
      });

      if (res.stop_reason === "max_tokens") {
        failed.push({ id: entry.id, reason: "analysis truncated" });
        continue;
      }

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      const parsed = JSON.parse(extractJson(text)) as Omit<FeedbackAnalysis, "analysedAt">;

      // Repair rather than reject. A golden case arrived once with mustAppear and
      // mustNotAppear but no question, which would have written a regression test that
      // could never be replayed. The question is always recoverable from the entry, so
      // fill it rather than discarding an otherwise good analysis.
      const gsc = parsed.goldenSetCase
        ? {
            ...parsed.goldenSetCase,
            question: parsed.goldenSetCase.question || entry.question,
            mustAppear: parsed.goldenSetCase.mustAppear ?? [],
            mustNotAppear: parsed.goldenSetCase.mustNotAppear ?? [],
            rationale: parsed.goldenSetCase.rationale || "(no rationale returned)",
          }
        : undefined;

      const analysis: FeedbackAnalysis = {
        ...parsed,
        agrees: Boolean(parsed.agrees),
        severity: normaliseSeverity(parsed.severity),
        category: normaliseCategory(parsed.category),
        remediation: parsed.remediation ?? [],
        // Normalise the "no value" cases the model may express as null.
        goldenSetCase: gsc,
        disagreementNote: parsed.disagreementNote ?? undefined,
        analysedAt: new Date().toISOString(),
      };

      updateFeedback(entry.id, { analysis });
      done.push(entry.id);
    } catch (err) {
      failed.push({ id: entry.id, reason: err instanceof Error ? err.message : "unknown" });
    }
  }

  return NextResponse.json({ analysed: done.length, failed, ids: done });
}
