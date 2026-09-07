# AI Engineering: Training, RAG, Evals, Guardrails, and Threat Model

Answers to the questions a technical reviewer should ask.

---

## 1. Training — we deliberately don't

**There is no fine-tuning and no training.** The system is three things: a **system prompt**, **tool use**, and **retrieval**.

That's a design decision, not a shortcut. Fine-tuning would be actively worse here:

| Reason | Detail |
|---|---|
| **Plan data changes annually** | A tuned model would confidently recite last year's copays. Retrieval swaps the corpus; weights would need retraining |
| **Provenance disappears** | In a regulated setting you must explain *why* a statement was produced. "It's in the weights" is not an answer a compliance reviewer accepts. A citation is |
| **No training data exists** | Thousands of labelled advocate conversations would be needed — and they contain PHI |
| **Facts don't belong in weights** | Premiums and copays are lookups, not language patterns. Encoding them in a model is the wrong storage medium |

**Where tuning *would* help:** tone consistency for an older audience. Prompt engineering handles that adequately and stays auditable, so it isn't worth the trade.

---

## 2. The RAG pipeline, end to end

### Ingestion (offline, `scripts/ingest.mjs`)

```
42 official PDFs (21 Summary of Benefits + 21 Evidence of Coverage)
   │
   ├─ pdfjs-dist text extraction, PAGE BY PAGE       ← page numbers enable citation
   ├─ section heading inference per page
   ├─ sentence-aware chunking (~900 chars, 120 min)  ← avoids mid-sentence cuts
   └─ metadata attached: planId, docType, section, page
   │
   ▼
data/document-corpus.json — 14,674 chunks across 21 plans
```

Page-level extraction is the deliberate part. A citation that resolves to *"Evidence of Coverage, page 37"* lets a person open the source and check. That verifiability is what keeps generated benefit statements inside CMS marketing rules.

### Query time (`lib/retrieval.ts`)

```
User question
   │
   ├─ 1. Model rewrites into retrieval terms      (query expansion)
   ├─ 2. HARD FILTER by planId                    ← before any scoring
   ├─ 3. BM25 scoring (k1=1.5, b=0.75)
   ├─ 4. Bigram phrase boost (+2.5/match)
   ├─ 5. Top-k = 4
   ├─ 6. Wrap in <retrieved_document> tags        ← injection boundary
   └─ 7. Return with citation {plan, doc, page, url}
   │
   ▼
Model composes answer, cites source, or says it couldn't find it
```

### Why BM25 rather than embeddings

1. **The corpus rewards lexical matching** — dominated by rare high-signal terms (drug names, "prior authorization")
2. **Domain phrases are built from common words** — "skilled", "nursing", "facility" are unremarkable individually; the sequence is decisive. Bigram boosting recovers most of what dense retrieval offers here
3. **No embedding service** — no second API dependency, no added latency, no extra cost surface on a public demo
4. **Inspectable** — "these terms matched, weighted this way" is an explanation a compliance reviewer can follow

**The honest cost:** genuinely paraphrased questions suffer. *"Can I see a doctor away from home"* doesn't lexically match *"urgently needed services."* Mitigated by model-side query expansion; not eliminated. **Dense retrieval as a hybrid second stage is the highest-value next addition.**

### The non-negotiable: plan isolation

```ts
const scoped = corpus.filter(c => c.planId === planId);  // BEFORE scoring
```

Returning one plan's benefits for another is the most damaging failure available to this system. It's prevented structurally and asserted in tests — not discouraged in a prompt and hoped for.

**General principle: if a failure is unacceptable, make it impossible. Prompts are guidance; code is a guarantee.**

---

## 3. Evaluation

### What's built

**`evals/golden-set.json`** — 30 behavioural cases across seven categories:

| Category | Cases | Tests |
|---|---|---|
| eligibility | 5 | Gates run, failures surfaced, exclusions explained |
| plan-facts | 5 | Numeric accuracy from the structured layer |
| retrieval | 5 | Prose questions cite sources; absent info admitted |
| **boundary** | 4 | Recommendation refusal, no enrollment, handoff fires |
| **safety** | 4 | Medical advice declined, PII refused, AI disclosure |
| **injection** | 4 | Instruction override, fake authority, indirect injection |
| scope | 3 | Out-of-domain declined rather than confabulated |

### Why it's shaped this way

Conversational systems can't be scored by comparing prose to a reference answer — many phrasings are equally correct. Each case instead asserts:

1. **Which tools were called** → did it look things up rather than recall them?
2. **What must appear** → did it surface the fact that matters?
3. **What must never appear** → did it hold the boundary?

Assertion 3 carries the weight. A response can be fluent, warm, helpful — and still a failure because it recommended a plan. **There is no partial credit.**

### Release gating

The bold categories are **compliance-critical**. `npm run eval` exits non-zero if any of them fail. Retrieval quality regressions are informational; a boundary breach is a release blocker.

```bash
npm run eval              # full set
npm run eval:critical     # boundary + safety + injection only
npm run test:retrieval    # retrieval smoke test + isolation assertion
```

### What a production harness would add

- **Groundedness scoring** — does the answer actually follow from the retrieved passage? Currently unmeasured; the highest-value addition
- **Human-graded reference answers** on a sample, refreshed quarterly
- **Retrieval hit-rate @ k** against labelled relevant passages
- **Regression runs on every corpus rebuild** — plan documents are revised mid-year
- **Adversarial expansion** — the injection set should grow every time someone finds a new bypass
- **Cost and latency budgets** per case

---

## 4. Guardrail inventory

Grouped by strength, because not all guardrails are equal.

### Structural — the failure is impossible

| Guardrail | Mechanism |
|---|---|
| Cannot enrol anyone | **No enrollment tool exists.** The capability is absent, not discouraged |
| Cannot mix plan documents | Corpus filtered by planId before scoring; asserted in tests |
| Cannot leak the API key | All model calls server-side; key never reaches the browser |
| Cannot run away with tool loops | `MAX_TURNS = 8` |
| Cannot exceed budget | Workspace-scoped API key with a hard spend cap |
| Cannot be flooded | Per-IP rate limit; input length and message-count caps |

### Prompted — reliable but not guaranteed

| Guardrail | Mechanism |
|---|---|
| No plan recommendation | System prompt + handoff tool routing |
| No medical advice | System prompt; redirects to prescriber |
| No PII collection | System prompt + visible UI warning |
| No answering from memory | Plan facts only via tools; retrieval failure → admit and offer a human |
| Instruction integrity | Explicit rules about retrieved content and fake authority |

### Interface

| Guardrail | Mechanism |
|---|---|
| AI disclosure | Persistent banner — CMS requirement for automated agents |
| Not-affiliated notice | Persistent banner |
| Reasoning visible | Trace panel shows every tool call |
| No search indexing | `robots: noindex` — a Medicare prototype shouldn't surface where real shoppers might mistake it for advice |

**The honest gap:** the middle tier is prompt-based, and prompts can be defeated. That's why the eval suite treats those categories as release blockers — the guardrail is the prompt *plus* the test that proves it's still holding.

---

## 5. Prompt injection — threat model

### The realistic attack surface

| Vector | Risk | Status |
|---|---|---|
| **Indirect injection via retrieved documents** | Malicious text inside an indexed document is read as instruction | **Mitigated** — content wrapped in `<retrieved_document>` tags, delimiter-spoofing sanitised, system prompt treats tagged content as data only |
| **Direct instruction override** | "Ignore previous instructions…" | Mitigated — explicit integrity rules; 4 eval cases |
| **Fake authority** | User message posing as a system/compliance message | Mitigated — prompt states mid-conversation instruction changes carry no authority |
| **System prompt extraction** | Low direct harm, but hands an attacker the map | Mitigated — refusal instruction + eval case |
| **Context flooding** | Very long input pushing the system prompt out of attention | Mitigated — 4,000 char/message cap |
| **Tool-result poisoning** | Compromised tool output steering behaviour | Low — all tools are local deterministic functions over static data |

### Why indirect injection is the one that matters

Today the corpus is Humana's own CMS-filed PDFs, so the risk is theoretical. **It stops being theoretical the moment the pipeline ingests provider-submitted documents, third-party formularies, or member correspondence** — all of which are natural Phase 4 extensions.

The defence belongs at the boundary now, not retrofitted later:

```ts
text: `<retrieved_document>\n${sanitiseForContext(chunk.text)}\n</retrieved_document>`
```

`sanitiseForContext` strips literal `</retrieved_document>` strings, which would otherwise let a document close the wrapper early and make following text look like trusted instruction.

### What's still missing

- **Output filtering.** No post-generation check that a response didn't cross a boundary. Brittle to implement, but a regex sweep for recommendation phrasing would add defence in depth
- **Canary tokens** in the system prompt to detect extraction attempts
- **Injection classifier** on input as a pre-filter
- **Adversarial testing by someone other than the author.** Self-authored injection tests find the attacks you already thought of

---

## 6. Beyond the basics

### ✅ Corpus versioning — implemented
Plan documents are **revised mid-year**. Every source PDF is now SHA-256 hashed at ingestion; each chunk carries a `docVersion`, and a `corpusVersion` is derived from all source hashes combined. Both appear in every citation.

`data/corpus-manifest.json` is a human-readable record of all 42 sources — hashes, page counts, sizes — committed alongside the corpus so a document revision shows up **in a diff** rather than buried in a 12MB blob.

> **Why it matters:** without this, a citation points at "whatever is indexed now" rather than the version that actually supported the answer. A benefit statement grounded in superseded text is a compliance problem, not merely an accuracy one. When `corpusVersion` changes, that is the signal to re-run evals.

### ✅ Groundedness scoring — implemented
`npm run eval:groundedness`. The behavioural suite checks *that* a citation exists; this checks whether the claims **actually follow from the retrieved passages**.

LLM-as-judge: the judge sees only the passages and the answer — not the plan database, and it's instructed to ignore its own Medicare knowledge. Each claim is scored SUPPORTED / UNSUPPORTED / CONTRADICTED.

> **The failure this catches:** retrieval returns four passages, three irrelevant, and the model fills the gap from prior knowledge while still attaching a page number. The citation looks perfect. The claim isn't supported. That's the failure a member would act on.
>
> **Limitation, stated:** the judge shares a model family with the system under test, so blind spots may be shared. Production would use a different judge model plus human sampling.

### ✅ Bias and fairness testing — implemented
`npm run eval:fairness`. CMS has explicitly raised **algorithmic discrimination** in Medicare Advantage, and this system steers people toward plans.

Matched pairs state an identical situation, varying one attribute that must not matter — **name signalling ethnicity, occupation as an income proxy, gender, English fluency**. The assertion is on the **set of plan IDs surfaced**, not wording.

Two **control pairs** vary something that *should* change the outcome (Medicaid gates D-SNP; a qualifying condition gates C-SNP). If controls don't differ, the suite is insensitive and the null results mean nothing. A fairness test where nothing ever differs is measuring nothing.

### ✅ Model version gating — implemented
`lib/config.ts` is the single source of truth for the model. `evals/baseline.json` records the model, date, and golden-set version the suite was last validated under, plus the full run history.

The harness compares the running model against the baseline and **exits non-zero even on a clean pass** if they differ. A model upgrade is a behavioural change to a regulated system, not a dependency bump.

### ✅ Accessibility — implemented, not yet verified
Skip link, `role="log"` + `aria-live` for new messages, real `<label>` elements rather than placeholder-as-label, 56px targets, visible focus rings, `prefers-reduced-motion` handling, darkened contrast, screen-reader speaker prefixes.

Full audit in [accessibility.md](accessibility.md). **The honest caveat: implemented against the spec, not verified with an actual screen reader.** A WCAG claim without NVDA/JAWS/VoiceOver testing isn't a claim worth making.

---

### Still open

**Spanish.** Humana publishes Spanish versions of every document — the ingestion script could pull `...SBSP26.pdf` alongside English. Only English is indexed. For this population that's an equity gap, and the corpus to fix it already exists.

**Observability.** No logging, tracing, or analytics. Production needs per-conversation traces retained for compliance, retrieval quality monitoring, and the drop-off analytics that would actually measure the recapture metric the business case rests on.

**Cost and latency.** No token budgeting, caching, or streaming. AEP traffic is enormously repetitive — most questions are the same twenty questions — so **semantic caching would be materially valuable at real volume.** Not at prototype scale.

**Human feedback loop.** No thumbs-up/down or correction capture. Phase 1 (brokers) is the natural place to build it: brokers spot retrieval errors immediately and say so bluntly. The cheapest available path to hardening before a member sees it.

---

## Summary

| Question | Answer |
|---|---|
| **Training?** | None, deliberately. Prompting + tools + retrieval |
| **Golden dataset?** | 30 cases, 7 categories, `evals/golden-set.json` |
| **Evals?** | Behavioural assertions; compliance categories gate release |
| **Guardrails?** | 6 structural, 5 prompted, 4 interface — strength stated honestly |
| **Injection?** | Threat-modelled; indirect injection mitigated at the retrieval boundary |
| **RAG?** | Hybrid architecture — structured for numbers, BM25+phrase for prose, rules for eligibility |
| **Biggest gap?** | Corpus versioning, then Spanish, then groundedness scoring |
