/**
 * TEMPORARY audit script — re-ranking / context assembly.
 * Uses the REAL searchPlanDocuments so numbers reflect shipped behaviour.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { searchPlanDocuments } from "../lib/retrieval";

type Chunk = { id: string; planId: string; docType: string; section: string; page: number; text: string };

const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "document-corpus.json"), "utf-8"));
const chunks: Chunk[] = Array.isArray(raw) ? raw : raw.chunks;
console.log(`corpus: ${chunks.length} chunks; meta=${JSON.stringify(raw.meta ?? {}).slice(0, 200)}`);

// ---------- chunk size distribution ----------
const lens = chunks.map((c) => c.text.length).sort((a, b) => a - b);
const pct = (p: number) => lens[Math.floor((lens.length - 1) * p)];
console.log(
  `\nCHUNK CHARS: min=${lens[0]} p25=${pct(0.25)} median=${pct(0.5)} p75=${pct(0.75)} p95=${pct(0.95)} max=${lens[lens.length - 1]} mean=${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(0)}`
);

// ---------- exact duplicates (normalised) ----------
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const byHash = new Map<string, Chunk[]>();
for (const c of chunks) {
  const h = crypto.createHash("sha1").update(norm(c.text)).digest("hex");
  (byHash.get(h) ?? byHash.set(h, []).get(h)!).push(c);
}
let exactDupGroups = 0;
let exactDupChunks = 0;
let crossDocTypeGroups = 0;
let samePlanDupGroups = 0;
const biggest: { n: number; text: string; plans: number; docTypes: string }[] = [];
for (const [, group] of byHash) {
  if (group.length < 2) continue;
  exactDupGroups++;
  exactDupChunks += group.length - 1;
  const plans = new Set(group.map((g) => g.planId));
  const dts = new Set(group.map((g) => g.docType));
  if (dts.size > 1) crossDocTypeGroups++;
  // duplicated WITHIN a single plan == the case that wastes retrieval slots
  const perPlan = new Map<string, number>();
  for (const g of group) perPlan.set(g.planId, (perPlan.get(g.planId) ?? 0) + 1);
  if ([...perPlan.values()].some((n) => n > 1)) samePlanDupGroups++;
  biggest.push({ n: group.length, text: group[0].text.slice(0, 110).replace(/\s+/g, " "), plans: plans.size, docTypes: [...dts].join("+") });
}
biggest.sort((a, b) => b.n - a.n);
console.log(
  `\nEXACT-DUP (normalised text): ${exactDupGroups} groups, ${exactDupChunks} redundant chunks (${((exactDupChunks / chunks.length) * 100).toFixed(1)}% of corpus)`
);
console.log(`  groups repeated within a SINGLE plan: ${samePlanDupGroups}`);
console.log(`  groups spanning both SB and EOC: ${crossDocTypeGroups}`);
console.log("  top repeated texts:");
for (const b of biggest.slice(0, 10)) console.log(`   x${b.n} [${b.docTypes}] across ${b.plans} plan(s): "${b.text}…"`);

// ---------- near-duplicates within a plan (minhash candidates + jaccard) ----------
function shingles(t: string, k = 6): Set<string> {
  const w = norm(t).split(" ").filter(Boolean);
  const s = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) s.add(w.slice(i, i + k).join(" "));
  return s;
}
function jac(a: Set<string>, b: Set<string>) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
const h32 = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const byPlan = new Map<string, Chunk[]>();
for (const c of chunks) (byPlan.get(c.planId) ?? byPlan.set(c.planId, []).get(c.planId)!).push(c);

let totalNearPairs = 0;
let planRows: string[] = [];
const nearDupSample: string[] = [];
const shingleCache = new Map<string, Set<string>>();
const getSh = (c: Chunk) => {
  let s = shingleCache.get(c.id);
  if (!s) { s = shingles(c.text); shingleCache.set(c.id, s); }
  return s;
};

for (const [planId, list] of byPlan) {
  // minhash sketch of 6 bands for candidate generation
  const BANDS = 8;
  const buckets = new Map<string, Chunk[]>();
  for (const c of list) {
    const sh = [...getSh(c)];
    if (sh.length === 0) continue;
    for (let b = 0; b < BANDS; b++) {
      let min = 0xffffffff;
      for (const s of sh) {
        const v = h32(`${b}|${s}`);
        if (v < min) min = v;
      }
      const key = `${b}:${min}`;
      (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(c);
    }
  }
  const seen = new Set<string>();
  let nearPairs = 0;
  let crossDoc = 0;
  for (const [, group] of buckets) {
    if (group.length < 2 || group.length > 60) continue;
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++) {
        const key = group[i].id < group[j].id ? `${group[i].id}|${group[j].id}` : `${group[j].id}|${group[i].id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const s = jac(getSh(group[i]), getSh(group[j]));
        if (s >= 0.7) {
          nearPairs++;
          if (group[i].docType !== group[j].docType) crossDoc++;
          if (nearDupSample.length < 6 && s < 0.999)
            nearDupSample.push(
              `  j=${s.toFixed(2)} ${planId} ${group[i].docType} p${group[i].page} vs ${group[j].docType} p${group[j].page}\n    A: "${group[i].text.slice(0, 150).replace(/\s+/g, " ")}"\n    B: "${group[j].text.slice(0, 150).replace(/\s+/g, " ")}"`
            );
        }
      }
  }
  totalNearPairs += nearPairs;
  planRows.push(`  ${planId}: ${list.length} chunks, ${nearPairs} near-dup pairs (j>=0.7), ${crossDoc} of them SB<->EOC`);
}
console.log(`\nNEAR-DUP WITHIN PLAN (6-word shingle Jaccard >= 0.7): ${totalNearPairs} pairs total`);
planRows.slice(0, 21).forEach((r) => console.log(r));
console.log("\n  samples:");
nearDupSample.forEach((s) => console.log(s));

// ---------- what actually reaches the model ----------
const QUERIES: { planId: string; q: string; label: string }[] = [
  { planId: "H1036-318", q: "emergency care when travelling outside the United States", label: "travel/emergency" },
  { planId: "H1036-318", q: "do I need a referral to see a specialist", label: "referral" },
  { planId: "H5525-050", q: "skilled nursing facility coverage days", label: "SNF days" },
  { planId: "H1036-308", q: "diabetes supplies and monitoring", label: "diabetes supplies" },
  { planId: "H5216-017", q: "dental hearing and vision extra benefits", label: "extra benefits" },
  { planId: "H1036-331", q: "prior authorization required for services", label: "prior auth" },
  { planId: "H1036-331", q: "specialty tier coinsurance prior authorization drug", label: "specialty drug cost" },
  { planId: "H5216-017", q: "transportation benefit plan approved locations", label: "transportation" },
  { planId: "H1036-318", q: "durable medical equipment coverage", label: "DME" },
  { planId: "H5525-050", q: "out of pocket maximum", label: "MOOP (narrow)" },
];

async function main() {
console.log("\n\n=== WHAT REACHES THE MODEL AT topK=4 (and what rank 5-20 held) ===");
for (const { planId, q, label } of QUERIES) {
  const wide = await searchPlanDocuments(planId, q, 20);
  const h = wide.hits;
  if (h.length === 0) { console.log(`\n[${label}] NO HITS`); continue; }
  const top4 = h.slice(0, 4);
  const payload = JSON.stringify({ hits: top4 });
  const chars4 = payload.length;
  const pages4 = new Set(top4.map((x) => x.citation.page));
  const docs4 = new Set(top4.map((x) => x.citation.document));
  // near-dup among the 4 delivered slots
  const sh = top4.map((x) => shingles(x.text));
  let dupSlotPairs = 0;
  const dupDetail: string[] = [];
  for (let i = 0; i < sh.length; i++)
    for (let j = i + 1; j < sh.length; j++) {
      const s = jac(sh[i], sh[j]);
      if (s >= 0.5) { dupSlotPairs++; dupDetail.push(`slot${i + 1}~slot${j + 1} j=${s.toFixed(2)}`); }
    }
  const scores = h.map((x) => x.score);
  console.log(
    `\n[${label}] "${q}" plan=${planId}\n  hits>0: ${h.length} (of ${chunks.filter((c) => c.planId === planId).length} chunks in plan)` +
      `\n  top4 scores: ${scores.slice(0, 4).join(", ")}  | rank5-8: ${scores.slice(4, 8).join(", ")} | rank20: ${scores[19] ?? "-"}` +
      `\n  score cliff top1/top4 = ${(scores[0] / (scores[3] || 1)).toFixed(2)}x ; top4/top5 = ${(scores[3] / (scores[4] || 1)).toFixed(2)}x` +
      `\n  top4 distinct pages: ${pages4.size} (${[...pages4].join(",")}) docs: ${[...docs4].join("/")}` +
      `\n  near-dup among the 4 delivered slots (j>=0.5): ${dupSlotPairs} ${dupDetail.join(" ")}` +
      `\n  tool_result payload for 4 hits: ${chars4} chars ≈ ${Math.round(chars4 / 3.7)} tokens`
  );
  // pages present only at rank 5-20
  const extraPages = [...new Set(h.slice(4, 20).map((x) => x.citation.page))].filter((p) => !pages4.has(p));
  console.log(`  pages reachable only at rank 5-20: ${extraPages.slice(0, 12).join(",")}`);
}

// ---------- how spread out is a real answer? ----------
console.log("\n\n=== ANSWER SPREAD: chunks containing key phrases, per plan ===");
for (const [phrase, plan] of [
  ["skilled nursing facility", "H5525-050"],
  ["prior authorization", "H1036-331"],
  ["urgently needed", "H1036-318"],
  ["transportation", "H5216-017"],
] as const) {
  const hit = chunks.filter((c) => c.planId === plan && norm(c.text).includes(phrase));
  const pages = new Set(hit.map((c) => `${c.docType}p${c.page}`));
  console.log(`  "${phrase}" in ${plan}: ${hit.length} chunks across ${pages.size} doc-pages -> ${[...pages].slice(0, 14).join(" ")}`);
}
}
main();
