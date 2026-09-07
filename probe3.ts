import { searchPlanDocuments } from "./lib/retrieval";
import { ALL_PLANS } from "./lib/plans";

async function main() {
  const rows: string[] = [];
  let is73 = 0, n = 0;
  for (const p of (ALL_PLANS as {planId:string}[])) {
    const r = await searchPlanDocuments(p.planId, "urgently needed services outside the service area");
    if (r.hits.length === 0) continue;
    n++;
    const top = r.hits[0].citation.page;
    if (top === 73) is73++;
    rows.push(`${p.planId.padEnd(15)} top page ${String(top).padStart(4)}   all=[${r.hits.map(h=>h.citation.page).join(",")}]`);
  }
  console.log(rows.join("\n"));
  console.log(`\ntop hit is page 73 for ${is73} of ${n} plans`);

  // what is actually ON page 73 of H1036-318 EOC
  const r2 = await searchPlanDocuments("H1036-318", "urgently needed services outside the service area");
  const p73 = r2.hits.find(h => h.citation.page === 73);
  console.log("\n--- H1036-318 page 73 text (first 500 chars) ---");
  console.log(p73 ? p73.text.slice(0, 500) : "not in top-4");
}
main();
