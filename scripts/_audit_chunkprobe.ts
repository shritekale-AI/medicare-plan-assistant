import { searchPlanDocuments } from "../lib/retrieval";
async function probe(plan: string, q: string, k = 6) {
  const r = await searchPlanDocuments(plan, q, k);
  console.log(`\nQ: "${q}"  plan=${plan}`);
  if (r.note) console.log("  note:", r.note);
  r.hits.forEach((h, i) => {
    const t = h.text.replace(/<\/?retrieved_document>/g, "").trim();
    console.log(`  ${i + 1}. score=${h.score} p${h.citation.page} ${h.citation.document} | ${t.slice(0, 150).replace(/\n/g, " ")}`);
  });
}
(async () => {
  await probe("H1036-137", "hearing aid cost");
  await probe("H1036-137", "how much do hearing aids cost");
  await probe("H1036-137", "TruHearing Advanced Premium hearing aid copay price");
})();
