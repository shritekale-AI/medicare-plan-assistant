/** TEMPORARY audit script 2 — slot waste, boilerplate collisions, payload budget. */
import fs from "fs";
import path from "path";
import { searchPlanDocuments } from "../lib/retrieval";
import { executeTool } from "../lib/tools";

type Chunk = { id: string; planId: string; docType: string; section: string; page: number; text: string };
const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "document-corpus.json"), "utf-8"));
const chunks: Chunk[] = Array.isArray(raw) ? raw : raw.chunks;
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function shingles(t: string, k = 6): Set<string> {
  const w = norm(t).split(" ").filter(Boolean);
  const s = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) s.add(w.slice(i, i + k).join(" "));
  return s;
}
function jac(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

async function slots(planId: string, q: string, label: string, showText = 0) {
  const { hits, note } = await searchPlanDocuments(planId, q);
  console.log(`\n--- [${label}] "${q}" (${planId})`);
  if (!hits.length) { console.log(`   NO HITS: ${note}`); return; }
  const sh = hits.map((h) => shingles(h.text));
  let wasted = 0;
  for (let i = 0; i < hits.length; i++)
    for (let j = i + 1; j < hits.length; j++) {
      const s = jac(sh[i], sh[j]);
      if (s >= 0.5) { wasted++; console.log(`   REDUNDANT SLOTS ${i + 1}&${j + 1} jaccard=${s.toFixed(2)} (p${hits[i].citation.page} vs p${hits[j].citation.page})`); }
    }
  const payload = JSON.stringify({ hits });
  console.log(`   slots: ${hits.map((h) => `${h.citation.document === "Summary of Benefits" ? "SB" : "EOC"}p${h.citation.page}:${h.score}`).join("  ")}`);
  console.log(`   redundant slot pairs: ${wasted}; payload ${payload.length} chars ≈ ${Math.round(payload.length / 3.7)} tokens; chunk chars: ${hits.map((h) => h.text.length).join("/")}`);
  for (let i = 0; i < Math.min(showText, hits.length); i++)
    console.log(`   slot${i + 1} (p${hits[i].citation.page}, score ${hits[i].score}): "${hits[i].text.replace(/<\/?retrieved_document>/g, "").replace(/\s+/g, " ").trim().slice(0, 260)}…"`);
}

async function main() {
  console.log("=== A. THE CONFIRMED DUPLICATE-SLOT CASE ===");
  await slots("H1036-331", "prior authorization required for services", "prior auth", 4);

  console.log("\n\n=== B. NARROW QUESTION, 4 SLOTS FORCED ===");
  const tChunks = chunks.filter((c) => c.planId === "H5216-017" && norm(c.text).includes("transportation"));
  console.log(`plan H5216-017 has ${tChunks.length} chunks containing "transportation":`);
  for (const c of tChunks) console.log(`   ${c.docType} p${c.page}: "${c.text.replace(/\s+/g, " ").slice(0, 180)}…"`);
  await slots("H5216-017", "transportation benefit plan approved locations", "transportation (domain wording)", 4);
  await slots("H5216-017", "I do not drive anymore, is there help getting to the doctor", "transportation (lay wording)", 2);

  console.log("\n\n=== C. BOILERPLATE-PRONE QUERIES (where SB/EOC duplication should bite) ===");
  await slots("H1036-307", "what counties are in the service area", "service area", 2);
  await slots("H1036-307", "how do I file a grievance or complaint", "grievance");
  await slots("H1036-307", "nondiscrimination language assistance interpreter", "nondiscrimination", 2);
  await slots("H1036-307", "notice of privacy practices protected health information", "privacy notice");

  console.log("\n\n=== D. LAY QUERIES FROM test-paraphrase ===");
  await slots("H1036-318", "I got sick while visiting my daughter in Ohio, would that be covered", "lay: away from home");
  await slots("H1036-318", "does it pay for my walker and the shower chair", "lay: DME");
  await slots("H5525-050", "if I break my hip and need somewhere to recover for a few weeks", "lay: rehab");
  await slots("H1036-331", "my arthritis shot costs a fortune, what will I owe", "lay: drug cost");

  console.log("\n\n=== E. OVERSIZED CHUNKS (single slot can swallow the budget) ===");
  const big = chunks.filter((c) => c.text.length > 1500).sort((a, b) => b.text.length - a.text.length);
  console.log(`chunks >1500 chars: ${big.length} (${((big.length / chunks.length) * 100).toFixed(2)}%); >2500: ${chunks.filter((c) => c.text.length > 2500).length}`);
  for (const c of big.slice(0, 4)) console.log(`   ${c.text.length} chars ${c.planId} ${c.docType} p${c.page}: "${c.text.replace(/\s+/g, " ").slice(0, 130)}…"`);

  console.log("\n\n=== F. TOOL PAYLOAD BUDGET (chars of JSON.stringify, as route.ts sends it) ===");
  const cases: [string, Record<string, unknown>][] = [
    ["search_plans", { needsDrugCoverage: true }],
    ["search_plans", {}],
    ["get_plan_details", { planId: "H1036-318" }],
    ["compare_plans", { planIds: ["H1036-318", "H5525-050", "H5216-017"] }],
    ["check_eligibility", { zip: "28270", age: 68, hasPartA: true, hasPartB: true }],
    ["search_plan_documents", { planId: "H1036-318", query: "emergency care travelling outside the United States" }],
  ];
  let running = 0;
  for (const [name, input] of cases) {
    const r = await executeTool(name, input);
    const n = JSON.stringify(r).length;
    running += n;
    console.log(`   ${name.padEnd(22)} ${String(n).padStart(7)} chars ≈ ${String(Math.round(n / 3.7)).padStart(6)} tokens`);
  }
  console.log(`   ONE conversation touching all of the above: ${running} chars ≈ ${Math.round(running / 3.7)} tokens of tool_result, all retained for the rest of that HTTP request`);

  console.log("\n\n=== G. IS THE SCORE COMPARABLE ACROSS QUERIES? ===");
  const probes: [string, string][] = [
    ["H1036-318", "emergency care when travelling outside the United States"],
    ["H5216-017", "transportation benefit plan approved locations"],
    ["H5525-050", "skilled nursing facility coverage days"],
    ["H5525-050", "out of pocket maximum"],
    ["H1036-318", "does the plan cover a trip to Mars"],
    ["H1036-318", "acupuncture"],
  ];
  for (const [p, q] of probes) {
    const wide = await searchPlanDocuments(p, q, 20);
    const s = wide.hits.map((h) => h.score);
    console.log(`   "${q.slice(0, 52)}" -> top1=${s[0] ?? "-"} top4=${s[3] ?? "-"} rank20=${s[19] ?? "-"} (hits ${s.length})`);
  }
}
main();
