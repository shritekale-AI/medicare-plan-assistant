/**
 * Measure the retrieval stage nobody thinks to measure: query construction.
 *
 * scripts/test-paraphrase.ts shows that a member's own words reach the right page
 * only 1 time in 8. That number is alarming on its own and it is also NOT the
 * number that matters, because the member's words are never what reaches the
 * index. The model writes the `query` argument. So the honest question is whether
 * the model translates "my sugar test strips and the little needles" into terms
 * this corpus actually contains — and until this file existed, nothing checked.
 *
 * That is the whole point of treating RAG as a pipeline: the defect was two steps
 * upstream of the retriever, in a string the model composes, invisible in any
 * answer-quality metric.
 *
 * Run: node --env-file=.env.local --import tsx scripts/test-query-rewrite.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../lib/config";
import { SYSTEM_PROMPT } from "../lib/prompts";
import { TOOLS } from "../lib/tools";
import { searchPlanDocuments } from "../lib/retrieval";

type Case = {
  need: string;
  planId: string;
  /** What the member actually says. */
  lay: string;
  /** Terms the document uses — the page this SHOULD land on is found via these. */
  domain: string;
};

const CASES: Case[] = [
  { need: "Care while away from home", planId: "H1036-318",
    lay: "I got sick while visiting my daughter in Ohio, would that be covered",
    domain: "urgently needed services outside the service area" },
  { need: "Mobility equipment", planId: "H1036-318",
    lay: "does it pay for my walker and the shower chair",
    domain: "durable medical equipment coverage" },
  { need: "Seeing a specialist", planId: "H5525-050",
    lay: "do I have to ask permission before I see the heart doctor",
    domain: "referral required specialist prior authorization" },
  { need: "Rehab after hospital", planId: "H5525-050",
    lay: "if I break my hip and need somewhere to recover for a few weeks",
    domain: "skilled nursing facility benefit period days" },
  { need: "Diabetes supplies", planId: "H1036-308",
    lay: "my sugar test strips and the little needles",
    domain: "diabetic supplies blood glucose monitoring" },
  { need: "Getting to appointments", planId: "H5216-017",
    lay: "I do not drive anymore, is there help getting to the doctor",
    domain: "transportation benefit plan approved locations" },
  { need: "Eye and tooth care", planId: "H5216-017",
    lay: "will it pay for my glasses and getting my teeth cleaned",
    domain: "routine vision dental preventive comprehensive" },
  { need: "Paying for an expensive drug", planId: "H1036-331",
    lay: "my arthritis shot costs a fortune, what will I owe",
    domain: "specialty tier coinsurance prior authorization drug" },
];

const PACE_MS = 5500; // same pacing as the eval harness — do not trip our own rate limiter
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask the model, with the real prompt and real tools, what it would search for. */
async function modelQuery(client: Anthropic, c: Case): Promise<string | null> {
  const res = await client.messages.create({
    model: MODELS.primary,
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages: [
      {
        role: "user",
        content: `I'm looking at plan ${c.planId}. ${c.lay}?`,
      },
    ],
  });
  for (const block of res.content) {
    if (block.type === "tool_use" && block.name === "search_plan_documents") {
      return (block.input as { query?: string }).query ?? null;
    }
  }
  return null;
}

async function topPages(planId: string, q: string): Promise<number[]> {
  const { hits } = await searchPlanDocuments(planId, q, 3);
  return hits.map((h) => h.citation.page);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set. Run with: node --env-file=.env.local --import tsx scripts/test-query-rewrite.ts");
    process.exit(1);
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log(`Query-rewrite eval — ${MODELS.primary}\n`);
  console.log("Does the model translate a member's words into terms the corpus contains?\n");

  let hit = 0;
  let noSearch = 0;
  let missed = 0;

  for (const [i, c] of CASES.entries()) {
    if (i > 0) await sleep(PACE_MS);

    const target = await topPages(c.planId, c.domain);
    const written = await modelQuery(client, c);

    console.log(`${c.need} [${c.planId}]`);
    console.log(`   member said: "${c.lay}"`);

    if (!written) {
      noSearch++;
      console.log(`   ✗ model did not call search_plan_documents at all`);
      console.log(`     (target pages were ${target.join(", ")})\n`);
      continue;
    }

    const got = await topPages(c.planId, written);
    const overlap = got.filter((p) => target.includes(p));

    console.log(`   model searched: "${written}"`);
    console.log(`   target pages:   ${target.join(", ") || "none"}`);
    console.log(`   reached pages:  ${got.join(", ") || "none"}`);

    if (overlap.length > 0) {
      hit++;
      console.log(`   ✓ RECOVERED — overlaps on p.${overlap.join(", p.")}\n`);
    } else {
      missed++;
      console.log(`   ✗ STILL MISSING — no page in common\n`);
    }
  }

  const n = CASES.length;
  console.log("─".repeat(66));
  console.log(`Recovered by model-side rewrite: ${hit}/${n}`);
  console.log(`Missed even after rewrite:       ${missed}/${n}`);
  console.log(`No document search attempted:    ${noSearch}/${n}`);
  console.log(
    `\nBaseline without rewrite (scripts/test-paraphrase.ts): 1/8.` +
      `\nThe delta is what the model's query construction is worth — and what would` +
      `\nbe lost by treating the member's raw utterance as the retrieval query.`
  );
}

main();
