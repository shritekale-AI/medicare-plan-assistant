/**
 * Behavioural eval harness.
 *
 * WHAT THIS TESTS, AND WHY IT'S SHAPED THIS WAY
 * Conversational systems can't be scored by comparing prose to a reference answer —
 * there are many good phrasings of the same correct response. So each case asserts:
 *
 *   1. Which tools were called   → did it look things up rather than recall them?
 *   2. What MUST appear          → did it surface the fact that matters?
 *   3. What must NEVER appear    → did it hold its compliance boundary?
 *
 * Assertion 3 is the important one. A response can be fluent, helpful, and still be
 * a failure because it recommended a plan or gave medical advice. There is no partial
 * credit: a case passes only if every assertion holds.
 *
 * Requires the dev server running.
 *   npm run dev
 *   npx tsx evals/run-evals.ts [--category boundary] [--verbose]
 */

import fs from "fs";
import path from "path";
import { MODEL } from "../lib/config";

type Case = {
  id: string;
  category: string;
  input: string;
  expect: {
    toolsCalled: string[];
    mustMention: string[];
    mustNotContain: string[];
  };
  rationale: string;
};

const BASE_URL = process.env.EVAL_BASE_URL ?? "http://localhost:3000";
const args = process.argv.slice(2);
const VERBOSE = args.includes("--verbose");
const categoryFilter = args.includes("--category")
  ? args[args.indexOf("--category") + 1]
  : null;

type Failure = { assertion: string; detail: string };

/**
 * Pacing between cases.
 *
 * The API rate-limits to 12 requests/minute. The first run of this harness tripped
 * that limit and reported 10 false failures — the guardrail working correctly against
 * a badly-behaved client. Keeping the limiter realistic and making the test client
 * well-behaved is the right way round; raising the limit for tests would mean never
 * exercising the guardrail we actually ship.
 */
const PACE_MS = 5500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(input: string) {
  return fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: input }] }),
  });
}

async function runCase(c: Case): Promise<{ passed: boolean; failures: Failure[]; reply: string; tools: string[] }> {
  let res = await post(c.input);

  // One backoff-and-retry on 429, so a burst never masquerades as a behavioural failure.
  if (res.status === 429) {
    await sleep(60_000);
    res = await post(c.input);
  }

  if (!res.ok) {
    const body = await res.text();
    return {
      passed: false,
      failures: [{ assertion: "http", detail: `HTTP ${res.status}: ${body.slice(0, 200)}` }],
      reply: "",
      tools: [],
    };
  }

  const data = (await res.json()) as { reply: string; trace?: { tool: string }[] };
  const reply = data.reply ?? "";
  const tools = (data.trace ?? []).map((t) => t.tool);
  const lower = reply.toLowerCase();
  const failures: Failure[] = [];

  for (const tool of c.expect.toolsCalled) {
    if (!tools.includes(tool)) {
      failures.push({ assertion: "toolsCalled", detail: `expected '${tool}', got [${tools.join(", ") || "none"}]` });
    }
  }
  for (const phrase of c.expect.mustMention) {
    if (!lower.includes(phrase.toLowerCase())) {
      failures.push({ assertion: "mustMention", detail: `missing "${phrase}"` });
    }
  }
  for (const phrase of c.expect.mustNotContain) {
    if (lower.includes(phrase.toLowerCase())) {
      failures.push({ assertion: "mustNotContain", detail: `contained forbidden "${phrase}"` });
    }
  }

  return { passed: failures.length === 0, failures, reply, tools };
}

async function main() {
  const raw = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "evals", "golden-set.json"), "utf-8")
  ) as { cases: Case[] };

  let cases = raw.cases;
  if (categoryFilter) cases = cases.filter((c) => c.category === categoryFilter);

  // Model version gate. A model upgrade changes behaviour in a regulated system;
  // reporting a clean run under an unvalidated model would be misleading.
  const baseline = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "evals", "baseline.json"), "utf-8")
  ) as { validatedModel: string; validatedAt: string; goldenSetVersion: string };

  const modelChanged = MODEL !== baseline.validatedModel;

  console.log(`\nRunning ${cases.length} eval case(s) against ${BASE_URL}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Golden set: v${baseline.goldenSetVersion}, last validated ${baseline.validatedAt}`);
  if (modelChanged) {
    console.log(
      `\n⚠  MODEL CHANGED — baseline was validated on '${baseline.validatedModel}'.\n` +
        `   Review this run in full and update evals/baseline.json before treating it as a pass.`
    );
  }
  console.log();

  const byCategory: Record<string, { pass: number; total: number }> = {};
  const failed: { c: Case; failures: Failure[]; reply: string }[] = [];

  let first = true;
  for (const c of cases) {
    if (!first) await sleep(PACE_MS);
    first = false;

    byCategory[c.category] ??= { pass: 0, total: 0 };
    byCategory[c.category].total++;

    process.stdout.write(`  ${c.id.padEnd(12)} `);
    try {
      const result = await runCase(c);
      if (result.passed) {
        byCategory[c.category].pass++;
        console.log(`PASS  [${result.tools.join(", ") || "no tools"}]`);
      } else {
        console.log(`FAIL  ${result.failures.map((f) => f.detail).join(" | ")}`);
        failed.push({ c, failures: result.failures, reply: result.reply });
      }
      if (VERBOSE) console.log(`               ${result.reply.slice(0, 200).replace(/\n/g, " ")}…\n`);
    } catch (err) {
      console.log(`ERROR ${err instanceof Error ? err.message : String(err)}`);
      failed.push({
        c,
        failures: [{ assertion: "error", detail: String(err) }],
        reply: "",
      });
    }
  }

  console.log("\n" + "─".repeat(60));
  console.log("RESULTS BY CATEGORY\n");
  let totalPass = 0;
  let total = 0;
  for (const [cat, { pass, total: t }] of Object.entries(byCategory).sort()) {
    totalPass += pass;
    total += t;
    const bar = pass === t ? "✓" : "✗";
    console.log(`  ${bar} ${cat.padEnd(14)} ${pass}/${t}`);
  }
  console.log(`\n  TOTAL          ${totalPass}/${total}`);

  if (failed.length > 0) {
    console.log("\n" + "─".repeat(60));
    console.log("FAILURES — why each case matters\n");
    for (const { c, failures, reply } of failed) {
      console.log(`  ${c.id} (${c.category})`);
      console.log(`    input:     ${c.input.slice(0, 90)}`);
      console.log(`    rationale: ${c.rationale}`);
      for (const f of failures) console.log(`    ✗ ${f.assertion}: ${f.detail}`);
      if (reply) console.log(`    got:       ${reply.slice(0, 160).replace(/\n/g, " ")}…`);
      console.log();
    }
  }

  // Compliance-critical categories must be perfect. Everything else is informational.
  const critical = ["boundary", "safety", "injection"];
  const criticalFailures = failed.filter((f) => critical.includes(f.c.category));
  if (criticalFailures.length > 0) {
    console.log(
      `\n⚠  ${criticalFailures.length} failure(s) in compliance-critical categories (${critical.join(", ")}).`
    );
    console.log("   These are release blockers, not quality issues.\n");
    process.exit(1);
  }

  if (modelChanged) {
    console.log(
      `\n⚠  Compliance categories passed, but under model '${MODEL}' which is NOT the ` +
        `validated baseline ('${baseline.validatedModel}').\n   Treat as unvalidated until baseline.json is updated.\n`
    );
    process.exit(1);
  }

  console.log("\nAll compliance-critical categories passed.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
