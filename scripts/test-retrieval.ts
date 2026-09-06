/**
 * Smoke test for the retrieval layer.
 *
 * Checks two things that matter more than relevance scores:
 *   1. Results are actually returned for realistic member questions.
 *   2. Plan isolation holds — a search scoped to one plan NEVER returns another
 *      plan's text. That failure would be the most damaging one this system could
 *      have, so it is asserted rather than assumed.
 *
 * Run: npx tsx scripts/test-retrieval.ts
 */

import { searchPlanDocuments, corpusStats } from "../lib/retrieval";

const QUESTIONS = [
  { planId: "H1036-318", q: "emergency care when travelling outside the United States" },
  { planId: "H1036-318", q: "do I need a referral to see a specialist" },
  { planId: "H5525-050", q: "skilled nursing facility coverage days" },
  { planId: "H1036-308", q: "diabetes supplies and monitoring" },
  { planId: "H5216-017", q: "dental hearing and vision extra benefits" },
  { planId: "H1036-331", q: "prior authorization required for services" },
];

async function main() {
  const stats = corpusStats();
  console.log(`Corpus: ${stats.chunks} chunks across ${stats.plans} plans\n`);
  if (!stats.indexed) {
    console.error("No corpus. Run: npm run ingest");
    process.exit(1);
  }

  let passed = 0;
  let isolationFailures = 0;

  for (const { planId, q } of QUESTIONS) {
    const { hits, note } = await searchPlanDocuments(planId, q, 2);
    const top = hits[0];

    console.log(`[${planId}] "${q}"`);
    if (!top) {
      console.log(`   ✗ no hits — ${note ?? ""}\n`);
      continue;
    }

    // Plan isolation assertion.
    const leaked = hits.filter((h) => h.citation.planId !== planId);
    if (leaked.length > 0) {
      isolationFailures++;
      console.log(`   ✗✗ ISOLATION FAILURE — returned ${leaked[0].citation.planId}`);
    }

    passed++;
    console.log(`   ✓ score ${top.score} · ${top.citation.document} p.${top.citation.page}`);
    console.log(`   "${top.text.slice(0, 160).trim()}…"\n`);
  }

  console.log(`\n${passed}/${QUESTIONS.length} questions returned results`);
  console.log(
    isolationFailures === 0
      ? "Plan isolation: PASS — no cross-plan leakage"
      : `Plan isolation: FAIL — ${isolationFailures} leak(s)`
  );
  if (isolationFailures > 0) process.exit(1);
}

main();
