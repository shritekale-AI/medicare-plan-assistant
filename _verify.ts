import { searchPlanDocuments } from "./lib/retrieval";
async function main() {
  for (const q of ["skilled nursing facility", "dental coverage", "what is my copay"]) {
    const r = await searchPlanDocuments("H1036-137", q, 4);
    console.log("Q:", q);
    console.log(JSON.stringify(r.hits.map(h => ({ score: h.score, page: h.citation.page })), null));
  }
}
main();
