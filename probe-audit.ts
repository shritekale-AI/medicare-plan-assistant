import { searchPlanDocuments } from "./lib/retrieval";

async function main() {
  // 1. empty-retrieval path: nonsense query against a real plan
  const empty = await searchPlanDocuments("H1036-318", "zzqqxx frobnicate blorptastic");
  console.log("--- EMPTY RETRIEVAL, exactly what tool_result carries ---");
  console.log(JSON.stringify(empty));

  // 2. unknown plan
  const noPlan = await searchPlanDocuments("H9999-999", "referral");
  console.log("\n--- UNKNOWN PLAN ---");
  console.log(JSON.stringify(noPlan));

  // 3. a real hit, truncated, to show the wrapper as the model sees it
  const hit = await searchPlanDocuments("H1036-318", "referral specialist");
  console.log("\n--- REAL HIT (first hit only, text truncated 320 chars) ---");
  const h = hit.hits[0];
  console.log(JSON.stringify({ text: h.text.slice(0, 320) + "...", score: h.score, citation: h.citation }, null, 1));
  console.log("\nhits:", hit.hits.length, "pages:", hit.hits.map(x => x.citation.page).join(","));
}
main();
