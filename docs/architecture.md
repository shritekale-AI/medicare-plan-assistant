# Architecture & AI Design Decisions

Why the system is shaped this way, what was deliberately left out, and what would come next.

---

## Principle: the model decides what to *ask*, never what is *true*

Every fact about a plan — cost, coverage, eligibility — comes from a deterministic function or a cited document. The model's job is conversational: work out what someone needs, choose which tools to call, and explain the results in language they'll understand.

This isn't stylistic caution. In a regulated payer context, "the model said so" is not a defensible provenance for a benefit statement.

---

## Decision 1 — Three retrieval paths, not one

| Question type | Path | Why |
|---|---|---|
| "What's the premium?" | **Structured query** over `plans-28270.json` | Numbers in tables. Deterministic, instant, never wrong |
| "Am I covered while travelling?" | **Document retrieval**, cited | Answer lives in prose |
| "Can I enrol right now?" | **Rules engine** in code | Legal consequence; must be testable and reproducible |

**The failure this prevents:** semantic search over 21 plans × ~200 pages will confidently return *the wrong plan's* deductible. Numeric questions look like the easy case and are actually where naive RAG fails hardest — the embeddings for "$450 deductible" and "$350 deductible" are nearly identical.

Splitting by question type is the single most consequential decision in the build.

---

## Decision 2 — BM25 with phrase boosting, not embeddings

**What was built:** lexical BM25 with an adjacent-pair (bigram) boost, hard-filtered by plan ID before scoring.

**Why not a vector database:**

1. **The corpus rewards lexical matching.** It's dominated by rare high-signal terms — drug names, "prior authorization", "skilled nursing facility". BM25 handles those very well.
2. **Domain phrases are built from common words.** "Skilled", "nursing", "facility" are each unremarkable; the sequence is decisive. Bigram boosting recovers most of what a dense retriever would give here, at a fraction of the complexity. Tuned against `scripts/test-retrieval.ts`.
3. **No embedding service** — no second API dependency, no added latency, no additional cost surface on a publicly shared demo.
4. **Inspectability.** In a regulated setting you may have to explain *why* a passage was surfaced. "It shares these terms, weighted this way" is an explanation. "It was nearby in a 1,536-dimensional space" is less satisfying to a compliance reviewer.

**What this costs, honestly:** genuinely paraphrased questions suffer. *"Can I see a doctor when I'm away from home"* doesn't lexically match *"urgently needed services."* Partly mitigated by having the model rephrase into retrieval-friendly terms before calling, but a real limitation. See "deferred" below.

---

## Decision 3 — Plan isolation is structural, not prompted

```ts
const scoped = corpus.filter(c => c.planId === planId);  // BEFORE scoring
```

Returning one plan's benefits in answer to a question about another is the most damaging failure this system could produce. It is prevented by filtering the corpus *before* anything is scored, and asserted in the test suite — rather than being discouraged in a system prompt and hoped for.

**General principle:** if a failure mode is unacceptable, make it structurally impossible. Prompts are guidance; code is a guarantee.

---

## Decision 4 — Guardrails with mechanisms

| Guardrail | Mechanism |
|---|---|
| AI disclosure | Persistent UI banner (CMS requirement for automated agents) |
| No plan recommendation | System prompt + `create_handoff_summary` tool routing to a human |
| No benefit claims from memory | All plan facts arrive via tools; retrieval returns citations |
| No enrollment submission | No such tool exists — the capability is absent, not just discouraged |
| No PHI collection | Prompt instruction + visible UI warning |
| Runaway tool loops | `MAX_TURNS = 8` |
| Cost exposure | Workspace-scoped API key with a hard spend cap |

The pattern: **prefer the guardrail you can point at.** "There is no enrollment tool" is stronger than "the model has been told not to enrol anyone."

---

## Decision 5 — The trace panel is a product feature

Every tool call is surfaced in the UI, tagged as *rules* (deterministic) or *retrieval* (cited).

Three jobs: it makes the grounding claim **visible rather than asserted**; it gives a technical audience a way to inspect the system without reading code; and it's the beginning of the **audit trail** a payer needs — every assertion traceable to what produced it.

---

## Decision 6 — Same capabilities, multiple surfaces

The tool definitions in `lib/tools.ts` are written to be transport-agnostic so the same capability layer can serve a member-facing web UI and a broker-facing MCP client. One retrieval layer, one rules engine, one audit trail — different experiences on top.

That's the platform thesis expressed in code rather than on a slide: Linda, Amy, and Tony want very different interfaces over identical logic.

---

## Evaluation

`scripts/test-retrieval.ts` asserts two properties:

1. **Coverage** — realistic member questions return usable passages
2. **Isolation** — a plan-scoped search never returns another plan's text *(hard failure; exits non-zero)*

Deliberately modest. A production system would need a golden Q&A set with human-graded answers, groundedness scoring (does the answer follow from the retrieved passage?), retrieval hit-rate at k, and regression testing on every corpus rebuild. What exists here is the smallest suite that catches the failure that would actually matter.

---

## Deliberately deferred

Real techniques, genuinely applicable, consciously not built — with what each would buy.

| Technique | What it would fix here | Why deferred |
|---|---|---|
| **Dense / hybrid retrieval** | Paraphrased questions ("away from home" → "urgently needed services") | Needs an embedding service; BM25 + phrase boost covers most of this corpus. Highest-value next addition |
| **Cross-encoder reranking** | Precision at top-k; currently the model does the final filtering | Adds a model call per query; marginal at k=4 |
| **Contextual chunk enrichment** | Chunks currently lose their section context — prepending document/section headings before indexing measurably improves retrieval | Requires re-ingestion; ~an hour of work |
| **Query decomposition** | "Keeps my doctor AND covers my drugs AND costs less" is three retrievals; currently handled by multiple tool calls | Current agent loop handles it adequately |
| **Semantic caching** | AEP traffic is enormously repetitive — most questions are the same twenty questions | Only matters at real volume |
| **Multi-agent decomposition** | Separate eligibility / matching / explanation agents | Honestly assessed: **would make this worse.** A single agent with well-designed tools is more reliable than a fragile agent swarm at this scope. Would revisit when tool count exceeds ~15 |
| **Fine-tuning** | Tone consistency for the 65+ audience | Prompt engineering is sufficient and far more auditable. Fine-tuning obscures why the model said something — the wrong direction in a regulated setting |
| **Streaming responses** | Perceived latency | Tool-use loops complicate streaming; batch responses were fine at this scale |
| **Structured output / schema validation** | Guarantee response shapes for downstream systems | Only matters once handoff feeds a real advocate desktop |
| **Session persistence** | Amy resuming tomorrow, sharing with her brother — a genuine persona need | Storage layer out of scope for a prototype |

**The pattern in these choices:** depth in what's built, breadth documented rather than half-implemented. A fragile demo that name-drops twelve techniques is worse than a solid one that names five and explains the other seven.

---

## Known weaknesses

Stated plainly:

1. **Chunks lose section context.** Chunking within a page means a chunk about skilled nursing may open with unrelated text. Contextual enrichment would fix it.
2. **Provider and formulary lookups are not live.** The strongest claim in the pitch — *"keeps your cardiologist and covers your Eliquis"* — is architecturally supported but not wired to real directories.
3. **Cost estimates are crude.** Premium, visit copays, and giveback only. Labelled as estimates throughout, but a real cost model needs the full benefit grid and drug tier placement.
4. **One ZIP code.** Nothing prevents national scale; the data collection just wasn't done.
5. **Voice quality varies by browser.** Web Speech API is good in Chrome and Edge, inconsistent elsewhere. Text always works.
6. **No dense retrieval** — see above.

---

## If this were going to production

In priority order:

1. Live provider directory and formulary integration — the biggest gap between claim and capability
2. Real evaluation harness with human-graded goldens, run on every corpus rebuild
3. Contextual chunk enrichment plus dense retrieval as a hybrid second stage
4. Session persistence and caregiver-shared sessions
5. Full audit logging to a compliance-grade store, versioned against document revisions
6. CMS marketing review of every generated pattern, with the retrieval corpus pinned to filed document versions

Item 6 is the one that governs the timeline, and it's why the roadmap sequences a broker-facing surface before a member-facing one.
