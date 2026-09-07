import { searchPlanDocuments } from "./lib/retrieval";

const CASES: [string,string][] = [
  ["H1036-335-002","urgent emergency care while travelling outside the service area"],
  ["H1036-318","urgently needed services travel out of area coverage"],
  ["H5525-050","skilled nursing facility days covered"],
  ["H1036-308","diabetes supplies and services covered"],
  ["H5216-017","dental and vision benefits"],
  ["H1036-331","services requiring prior authorization"],
];
const IMPER = /\byou must\b|\byou should\b|\bcall us\b|\bplease call\b|\bbe sure to\b|\bdo not\b|\byou need to\b/i;

async function main() {
  let withImper = 0, total = 0;
  for (const [planId, q] of CASES) {
    const r = await searchPlanDocuments(planId, q);
    const pages = r.hits.map(h => h.citation.page);
    const flags = r.hits.map(h => IMPER.test(h.text) ? "IMP" : "-");
    total += r.hits.length;
    withImper += flags.filter(f => f === "IMP").length;
    console.log(`${planId.padEnd(15)} pages=[${pages.join(",")}] imperative=[${flags.join(",")}]  "${q.slice(0,40)}"`);
  }
  console.log(`\n${withImper}/${total} retrieved passages contain a second-person directive addressed to the reader`);

  // Is page 73 (the number few-shot into SYSTEM_PROMPT) ever a top hit for the travel question?
  console.log("\n--- does 'page 73' appear among travel-question hits for ANY plan? ---");
  const { ALL_PLANS } = await import("./lib/plans");
  let seen73 = 0, plans = 0;
  for (const p of (ALL_PLANS as {planId:string}[])) {
    const r = await searchPlanDocuments(p.planId, "covered if I get sick visiting my son urgent emergency care away from home");
    if (r.hits.length === 0) continue;
    plans++;
    const pages = r.hits.map(h => h.citation.page);
    if (pages.includes(73)) seen73++;
  }
  console.log(`page 73 in top-4 for ${seen73} of ${plans} plans`);
}
main();
