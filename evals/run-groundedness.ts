/**
 * Groundedness scoring.
 *
 * The behavioural eval checks THAT the assistant cited a source. This checks whether
 * its claims actually follow from the passages it retrieved — the difference between
 * "it produced a citation" and "the citation supports what it said."
 *
 * That gap is where a grounded system quietly stops being grounded: retrieval returns
 * four passages, three are irrelevant, and the model fills the space from its own
 * prior knowledge while still attaching a page number. The citation looks fine. The
 * claim isn't supported. In a regulated context that is the failure that matters,
 * because a plausible, well-cited, wrong benefit statement is exactly what a member
 * would act on.
 *
 * METHOD: LLM-as-judge. A separate model call receives the retrieved passages and the
 * assistant's answer, and rates each factual claim as SUPPORTED, UNSUPPORTED, or
 * CONTRADICTED. The judge sees only the passages — not the plan database and not the
 * model's own knowledge — so anything it cannot verify from that text is flagged.
 *
 * KNOWN LIMITATION: the judge is the same model family as the system under test, so
 * shared blind spots are possible. Production would use a different model as judge,
 * plus periodic human grading on a sample. Stated rather than glossed over.
 *
 * Run: npx tsx evals/run-groundedness.ts   (dev server must be running)
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODEL } from "../lib/config";

const BASE_URL = process.env.EVAL_BASE_URL ?? "http://localhost:3000";
const PACE_MS = 5500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Prose questions that must be answered from documents rather than the plan table. */
const CASES = [
  { planId: "H1036-335-002", q: "If I'm visiting another state and need urgent care, am I covered?" },
  { planId: "H1036-318", q: "Do I need a referral before seeing a specialist?" },
  { planId: "H5525-050", q: "How many days of skilled nursing facility care are covered?" },
  { planId: "H1036-308", q: "What diabetes supplies and services are covered?" },
  { planId: "H5216-017", q: "What dental and vision benefits does this plan include?" },
  { planId: "H1036-331", q: "Which services need prior authorization?" },
];

const JUDGE_PROMPT = `You are auditing whether an assistant's answer is grounded in the source passages it retrieved.

You will receive RETRIEVED PASSAGES from an official Medicare plan document, and an ANSWER the assistant gave.

Judge ONLY against the passages. Do not use your own knowledge of Medicare — if a claim cannot be verified from the passages, it is UNSUPPORTED even if you believe it is true in the real world. That is the point of the exercise.

Identify each distinct factual claim in the answer about coverage, costs, rules, or benefits. Ignore conversational filler, offers to help, and questions back to the user.

Also ignore which plan is being discussed. The assistant is told the plan ID by the person asking and scopes its search to that plan's documents; the passages themselves rarely restate it. Treating "this is plan H1036-308" as an unsupported claim measures the harness, not the assistant. Judge what it says ABOUT the plan, not that it named it.

DO judge citation precision as a claim. If the answer attributes text to a specific chapter, section number, or heading, that locator must appear in the passages. A fabricated locator is a serious failure: it looks verifiable, so nobody checks it.

Classify each claim:
- SUPPORTED: directly stated or unambiguously implied by the passages
- UNSUPPORTED: not derivable from the passages
- CONTRADICTED: the passages say otherwise

Reply as JSON only:
{"claims":[{"claim":"...","verdict":"SUPPORTED|UNSUPPORTED|CONTRADICTED","note":"..."}],"groundedness":0.0}

where groundedness = supported claims / total claims, rounded to 2 decimals.`;

/**
 * Pull the JSON object out of a judge reply that may be fenced or prefaced.
 * Tolerant of ```json fences and of a sentence before the object; NOT tolerant of
 * truncation, which is detected separately from stop_reason so a dropped sample is
 * reported as dropped rather than silently narrowing the denominator.
 */
function extractJson(text: string): string {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return stripped;
  return stripped.slice(start, end + 1);
}

type TraceEntry = { tool: string; evidence?: { text: string; page: number; document: string }[] };

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set. The judge needs its own model access.");
    process.exit(1);
  }
  const judge = new Anthropic({ apiKey });

  console.log(`\nGroundedness scoring — ${CASES.length} cases`);
  console.log(`System under test: ${MODEL}   Judge: ${MODEL} (same family — see limitation note)\n`);

  const scores: number[] = [];
  const problems: string[] = [];
  const unscored: string[] = [];
  let first = true;

  for (const { planId, q } of CASES) {
    if (!first) await sleep(PACE_MS);
    first = false;

    console.log(`  [${planId}] ${q}`);

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: `For plan ${planId}: ${q}` }],
      }),
    });

    if (!res.ok) {
      console.log(`    ERROR HTTP ${res.status}\n`);
      continue;
    }

    const data = (await res.json()) as { reply: string; trace?: TraceEntry[] };
    const evidence = (data.trace ?? []).flatMap((t) => t.evidence ?? []);

    if (evidence.length === 0) {
      console.log(`    ⚠  no passages retrieved — cannot score groundedness\n`);
      problems.push(`${planId}: no retrieval`);
      continue;
    }

    const passages = evidence
      .map((e, i) => `[Passage ${i + 1} — ${e.document}, page ${e.page}]\n${e.text}`)
      .join("\n\n");

    const verdict = await judge.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: JUDGE_PROMPT,
      messages: [
        {
          role: "user",
          content: `RETRIEVED PASSAGES:\n${passages}\n\n---\n\nANSWER:\n${data.reply}`,
        },
      ],
    });

    const text = verdict.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    // A truncated judge reply is unparseable for a reason worth naming. The first run
    // of this harness silently lost the case with the most claims — reported as
    // "could not parse", which reads like a formatting quirk and is actually a
    // dropped sample. An eval that quietly shrinks its own denominator is worse than
    // no eval, so truncation is now distinguished from malformed output.
    if (verdict.stop_reason === "max_tokens") {
      console.log(`    judge reply truncated at max_tokens — case NOT scored\n`);
      unscored.push(`${planId}: judge truncated`);
      continue;
    }

    try {
      const parsed = JSON.parse(extractJson(text)) as {
        claims: { claim: string; verdict: string; note: string }[];
        groundedness: number;
      };
      scores.push(parsed.groundedness);

      const bad = parsed.claims.filter((c) => c.verdict !== "SUPPORTED");
      console.log(
        `    groundedness ${parsed.groundedness.toFixed(2)}  (${parsed.claims.length} claims, ${bad.length} unsupported)`
      );
      for (const c of bad) {
        console.log(`      ✗ ${c.verdict}: "${c.claim.slice(0, 90)}"`);
        if (c.note) console.log(`        ${c.note.slice(0, 110)}`);
        problems.push(`${planId}: ${c.claim.slice(0, 60)}`);
      }
    } catch {
      console.log(`    could not parse judge output — case NOT scored`);
      unscored.push(`${planId}: unparseable judge output`);
    }
    console.log();
  }

  console.log("─".repeat(60));
  if (scores.length > 0) {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(`Mean groundedness: ${mean.toFixed(2)} across ${scores.length} of ${CASES.length} answers`);
    console.log(`Fully grounded answers: ${scores.filter((s) => s >= 0.999).length}/${scores.length}`);
  }
  if (unscored.length > 0) {
    // Stated on its own line because a mean over a subset is not a mean over the set.
    console.log(`
NOT SCORED (${unscored.length}/${CASES.length}) — the mean above excludes these:`);
    for (const u of unscored) console.log(`  · ${u}`);
  }
  if (problems.length > 0) {
    console.log(`\n${problems.length} claim(s) not fully supported by retrieved text.`);
    console.log("Not automatically a defect — some are conversational hedges the judge treated as");
    console.log("claims. Review each; recurring patterns indicate a retrieval or prompting gap.");
  }
  console.log(
    "\nLimitation: judge shares a model family with the system under test, so blind spots\n" +
      "may be shared. Production would use a different judge model plus human sampling.\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
