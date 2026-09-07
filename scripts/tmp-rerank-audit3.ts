/** TEMPORARY audit 3 — score floor reachability + boilerplate slot-eater census. */
import fs from "fs";
import path from "path";
import { searchPlanDocuments } from "../lib/retrieval";

type Chunk = { id: string; planId: string; docType: string; page: number; text: string };
const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "document-corpus.json"), "utf-8"));
const chunks: Chunk[] = Array.isArray(raw) ? raw : raw.chunks;

async function main() {
  console.log("=== H. CAN THE 'NOTHING MATCHED' SAFETY PATH EVER FIRE? ===");
  const offTopic = [
    "does the plan cover my dog's vaccinations at the vet",
    "tattoo removal",
    "will it pay for my car insurance deductible",
    "wedding photography reimbursement",
    "does the plan cover a trip to Mars",
    "cryptocurrency",
    "zzzqqq wibblefrotz",
    "is my grandson's gym membership included",
  ];
  for (const q of offTopic) {
    const { hits, note } = await searchPlanDocuments("H1036-318", q);
    console.log(
      `   "${q.slice(0, 48).padEnd(48)}" -> ${hits.length} hits${hits.length ? `, top score ${hits[0].score}, cited as ${hits[0].citation.document} p${hits[0].citation.page}` : ` | note: ${note?.slice(0, 60)}`}`
    );
  }

  console.log("\n=== I. THE SLOT-EATER: how often is the SB referral/prior-auth boilerplate repeated inside ONE plan? ===");
  const needle = "you do not need a referral to receive covered services from plan providers";
  const perPlan = new Map<string, { docType: string; page: number }[]>();
  for (const c of chunks) {
    if (!c.text.toLowerCase().includes(needle)) continue;
    const arr = perPlan.get(c.planId) ?? [];
    arr.push({ docType: c.docType, page: c.page });
    perPlan.set(c.planId, arr);
  }
  let multi = 0;
  for (const [plan, locs] of [...perPlan].sort((a, b) => b[1].length - a[1].length)) {
    if (locs.length > 1) multi++;
    console.log(`   ${plan}: ${locs.length} copies -> ${locs.map((l) => `${l.docType}p${l.page}`).join(" ")}`);
  }
  console.log(`   plans holding >1 copy: ${multi} of ${perPlan.size}`);

  console.log("\n=== J. HOW OFTEN DOES THAT ONE CHUNK LAND IN A TOP-4? ===");
  const qs: [string, string][] = [
    ["H1036-331", "prior authorization required for services"],
    ["H5216-017", "transportation benefit plan approved locations"],
    ["H1036-318", "do I need a referral to see a specialist"],
    ["H1036-318", "do I need approval before surgery"],
    ["H5525-050", "do I need permission to see the heart doctor"],
    ["H1036-308", "diabetes supplies and monitoring"],
    ["H5216-017", "will it pay for my glasses and getting my teeth cleaned"],
    ["H1036-318", "durable medical equipment coverage"],
  ];
  let land = 0;
  for (const [p, q] of qs) {
    const { hits } = await searchPlanDocuments(p, q);
    const idx = hits.findIndex((h) => h.text.toLowerCase().includes(needle));
    if (idx >= 0) land++;
    console.log(`   "${q.slice(0, 46).padEnd(46)}" boilerplate at slot ${idx >= 0 ? idx + 1 : "-"} (score ${idx >= 0 ? hits[idx].score : "-"})`);
  }
  console.log(`   -> boilerplate consumed a slot in ${land}/${qs.length} queries`);

  console.log("\n=== K. DOES A WIDER POOL CONTAIN A BETTER ANSWER? (recall@4 vs recall@20 by keyword) ===");
  const gold: [string, string, string][] = [
    ["H5216-017", "transportation benefit plan approved locations", "transportation"],
    ["H1036-318", "emergency care when travelling outside the United States", "outside the united states"],
    ["H5525-050", "skilled nursing facility coverage days", "skilled nursing facility"],
    ["H1036-318", "do I need a referral to see a specialist", "referral"],
    ["H1036-308", "diabetes supplies and monitoring", "diabet"],
    ["H1036-331", "specialty tier coinsurance prior authorization drug", "specialty tier"],
    ["H5216-017", "dental hearing and vision extra benefits", "hearing aid"],
    ["H5525-050", "if I break my hip and need somewhere to recover for a few weeks", "skilled nursing facility"],
  ];
  for (const [p, q, key] of gold) {
    const wide = await searchPlanDocuments(p, q, 20);
    const at = (n: number) => wide.hits.slice(0, n).filter((h) => h.text.toLowerCase().includes(key)).length;
    const firstRank = wide.hits.findIndex((h) => h.text.toLowerCase().includes(key)) + 1;
    console.log(
      `   "${q.slice(0, 44).padEnd(44)}" key="${key}": in top4=${at(4)}, in top20=${at(20)}, first at rank ${firstRank || "none in 20"}`
    );
  }
}
main();
