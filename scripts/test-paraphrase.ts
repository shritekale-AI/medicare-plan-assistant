/**
 * Probe the known weak spot in lexical retrieval: vocabulary mismatch.
 *
 * BM25 matches words. A 72-year-old does not say "urgently needed services" or
 * "durable medical equipment" — they say "I got sick visiting my daughter" and
 * "the walker". If the retriever only fires on the document's own vocabulary, the
 * system works for people who already speak insurance and fails for everyone else.
 * That is an equity problem, not a relevance metric, so it is measured directly.
 *
 * Each case pairs the SAME information need in two registers. A pass means the lay
 * phrasing lands on the same page as the domain phrasing. A miss means the answer
 * was in the corpus and the member's own words could not reach it.
 *
 * Run: npx tsx scripts/test-paraphrase.ts
 */

import { searchPlanDocuments, corpusStats } from "../lib/retrieval";

type Case = { planId: string; lay: string; domain: string; need: string };

const CASES: Case[] = [
  {
    need: "Care while away from home",
    planId: "H1036-318",
    lay: "I got sick while visiting my daughter in Ohio, would that be covered",
    domain: "urgently needed services outside the service area",
  },
  {
    need: "Mobility equipment",
    planId: "H1036-318",
    lay: "does it pay for my walker and the shower chair",
    domain: "durable medical equipment coverage",
  },
  {
    need: "Seeing a specialist",
    planId: "H5525-050",
    lay: "do I have to ask permission before I see the heart doctor",
    domain: "referral required specialist prior authorization",
  },
  {
    need: "Rehab after hospital",
    planId: "H5525-050",
    lay: "if I break my hip and need somewhere to recover for a few weeks",
    domain: "skilled nursing facility benefit period days",
  },
  {
    need: "Diabetes supplies",
    planId: "H1036-308",
    lay: "my sugar test strips and the little needles",
    domain: "diabetic supplies blood glucose monitoring",
  },
  {
    need: "Getting to appointments",
    planId: "H5216-017",
    lay: "I do not drive anymore, is there help getting to the doctor",
    domain: "transportation benefit plan approved locations",
  },
  {
    need: "Eye and tooth care",
    planId: "H5216-017",
    lay: "will it pay for my glasses and getting my teeth cleaned",
    domain: "routine vision dental preventive comprehensive",
  },
  {
    need: "Paying for an expensive drug",
    planId: "H1036-331",
    lay: "my arthritis shot costs a fortune, what will I owe",
    domain: "specialty tier coinsurance prior authorization drug",
  },
];

async function top(planId: string, q: string) {
  const { hits } = await searchPlanDocuments(planId, q, 3);
  return hits.map((h) => ({
    page: h.citation.page,
    doc: h.citation.document,
    score: h.score,
  }));
}

async function main() {
  const stats = corpusStats();
  if (!stats.indexed) {
    console.error("No corpus. Run: npm run ingest");
    process.exit(1);
  }
  console.log(`Corpus ${stats.corpusVersion} — ${stats.chunks} chunks / ${stats.plans} plans\n`);
  console.log("Does a member's own wording reach the same page as the document's wording?\n");

  let agree = 0;
  let overlap = 0;
  let miss = 0;

  for (const c of CASES) {
    const layHits = await top(c.planId, c.lay);
    const domHits = await top(c.planId, c.domain);

    const layTop = layHits[0];
    const domTop = domHits[0];
    const layPages = new Set(layHits.map((h) => h.page));
    const domPages = new Set(domHits.map((h) => h.page));
    const shared = [...layPages].filter((p) => domPages.has(p));

    let verdict: string;
    if (!layTop) {
      verdict = "MISS  — lay phrasing returned nothing";
      miss++;
    } else if (layTop.page === domTop?.page) {
      verdict = "AGREE — same top page";
      agree++;
    } else if (shared.length > 0) {
      verdict = `OVERLAP — same page in top 3 (p.${shared[0]}), different rank`;
      overlap++;
    } else {
      verdict = "DIVERGE — lay phrasing landed somewhere else entirely";
      miss++;
    }

    console.log(`${c.need} [${c.planId}]`);
    console.log(`   lay:    "${c.lay}"`);
    console.log(`           → ${layTop ? `p.${layTop.page} ${layTop.doc} (${layTop.score})` : "no hits"}`);
    console.log(`   domain: "${c.domain}"`);
    console.log(`           → ${domTop ? `p.${domTop.page} ${domTop.doc} (${domTop.score})` : "no hits"}`);
    console.log(`   ${verdict}\n`);
  }

  const n = CASES.length;
  console.log("─".repeat(64));
  console.log(`Top-page agreement:  ${agree}/${n}`);
  console.log(`Recoverable in top3: ${overlap}/${n}`);
  console.log(`Missed or diverged:  ${miss}/${n}`);
  console.log(
    "\nMisses are the case for either dense retrieval or an explicit query-rewrite\n" +
      "step. They are not hypothetical — each one is a real question a member would ask."
  );
}

main();
