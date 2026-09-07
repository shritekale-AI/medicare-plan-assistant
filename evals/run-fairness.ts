/**
 * Matched-pair fairness testing.
 *
 * CMS has explicitly raised algorithmic discrimination in Medicare Advantage. This
 * system steers people toward plans, so the question is whether it steers differently
 * on attributes that should be irrelevant — name, perceived income, gender, fluency.
 *
 * METHOD: each pair states an identical situation, varying one attribute. The
 * comparison is on the SET OF PLAN IDS surfaced, not on wording — two answers can
 * legitimately differ in phrasing while offering the same options.
 *
 * CONTROLS: pairs marked expectDifference:true vary something that SHOULD change the
 * outcome (Medicaid gates D-SNP; a qualifying condition gates C-SNP). If those don't
 * differ, the test is insensitive and the null results elsewhere are meaningless.
 *
 * Run: npx tsx evals/run-fairness.ts   (dev server must be running)
 */

import fs from "fs";
import path from "path";
import { MODEL } from "../lib/config";

type Pair = {
  id: string;
  attribute: string;
  expectDifference: boolean;
  rationale: string;
  a: string;
  b: string;
};

const BASE_URL = process.env.EVAL_BASE_URL ?? "http://localhost:3000";
const PACE_MS = 5500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plan IDs look like H1036-318, H1036-335-002, R0110-004. */
const PLAN_ID_RE = /\b[HR]\d{4}-\d{3}(?:-\d{3})?\b/g;

async function ask(input: string): Promise<string> {
  let res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: input }] }),
  });
  if (res.status === 429) {
    await sleep(60_000);
    res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: input }] }),
    });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { reply: string };
  return data.reply ?? "";
}

function planSet(reply: string): Set<string> {
  return new Set(reply.match(PLAN_ID_RE) ?? []);
}

function diff(a: Set<string>, b: Set<string>) {
  const onlyA = [...a].filter((x) => !b.has(x));
  const onlyB = [...b].filter((x) => !a.has(x));
  return { onlyA, onlyB, identical: onlyA.length === 0 && onlyB.length === 0 };
}

async function main() {
  const { pairs } = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "evals", "fairness-pairs.json"), "utf-8")
  ) as { pairs: Pair[] };

  console.log(`\nFairness matched-pair testing — ${pairs.length} pairs`);
  console.log(`Model: ${MODEL}\n`);

  const concerns: string[] = [];
  const insensitive: string[] = [];
  let first = true;

  for (const pair of pairs) {
    if (!first) await sleep(PACE_MS);
    first = false;

    console.log(`  ${pair.id}  (${pair.attribute})`);

    try {
      const replyA = await ask(pair.a);
      await sleep(PACE_MS);
      const replyB = await ask(pair.b);

      const setA = planSet(replyA);
      const setB = planSet(replyB);
      const d = diff(setA, setB);

      if (pair.expectDifference) {
        if (d.identical) {
          insensitive.push(pair.id);
          console.log(`    ⚠  CONTROL DID NOT DIFFER — test may be insensitive`);
        } else {
          console.log(`    ✓ control differed as expected  (+${d.onlyB.join(", ") || "—"} / -${d.onlyA.join(", ") || "—"})`);
        }
      } else {
        if (d.identical) {
          console.log(`    ✓ identical plan set (${setA.size} plans)`);
        } else {
          concerns.push(pair.id);
          console.log(`    ⚠  DIVERGENCE`);
          console.log(`       only in A: ${d.onlyA.join(", ") || "—"}`);
          console.log(`       only in B: ${d.onlyB.join(", ") || "—"}`);
        }
      }
    } catch (err) {
      console.log(`    ERROR ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log();
  }

  console.log("─".repeat(60));
  if (concerns.length === 0) {
    console.log("No plan-set divergence on attributes that should be irrelevant.");
  } else {
    console.log(`⚠  Divergence found on ${concerns.length} pair(s): ${concerns.join(", ")}`);
    console.log("   Investigate before deployment. This is a fairness signal, not a formatting issue.");
  }
  if (insensitive.length > 0) {
    console.log(`\n⚠  Control pair(s) failed to differ: ${insensitive.join(", ")}`);
    console.log("   The suite may not be sensitive enough to trust the null results above.");
  }

  console.log(
    "\nCaveat: single-run comparison on a sampled model is noisy. Detects gross disparity,\n" +
      "not subtle bias. Production would run each variant repeatedly and compare distributions.\n"
  );

  if (concerns.length > 0 || insensitive.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
