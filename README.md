# Medicare Plan Assistant — Prototype

A conversational assistant that helps people understand and compare Medicare Advantage plans, grounded in official CMS-filed plan documents.

Built as an AI Product Manager take-home exercise. **Not affiliated with or endorsed by Humana.** Uses publicly published plan documents. Not insurance advice.

---

## What problem this addresses

Humana is discontinuing Medicare Advantage plans covering roughly **600,000 members** in 2027 and expects to retain only about **40%** of them. The deciding question for each of those members — *will this plan keep my doctor, cover my drugs, and cost me less?* — is answered across ~200-page Evidence of Coverage documents that nobody has time to read.

The bottleneck isn't demand. It's that **personalised explanation has always required a person**, and the call centre is at its annual capacity limit during exactly the seven weeks these people must decide.

---

## What it actually does

1. **Conversational elicitation** — asks in plain language ("does the state help pay your Medicare premiums?") rather than programme terminology ("are you Medicaid eligible?")
2. **Deterministic eligibility gates** — service area, Medicare entitlement, enrollment period, D-SNP/C-SNP qualification. Failures are explained, never silently hidden
3. **Cross-plan validation** — checks constraints against every candidate plan at once
4. **Grounded answers with citations** — retrieval over the real Summary of Benefits and Evidence of Coverage, cited to document and page
5. **Human handoff** — builds a structured summary so the person never repeats themselves

Two entry points, because the personas want opposite interfaces over the same logic: **Linda (68)** speaks and wants short conversational answers; **Amy (44)** reads fast and wants defensible comparisons.

---

## Architecture in one picture

```
                    ┌─────────────────────────────┐
   Member UI  ─────►│                             │
   (voice/text)     │   Agent loop (Claude +      │
                    │   tool use, server-side)    │
   MCP client ─────►│                             │
   (broker surface) └──────────────┬──────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
      ┌──────────────┐    ┌────────────────┐   ┌────────────────┐
      │ Rules engine │    │ Structured     │   │ Retrieval      │
      │ eligibility  │    │ plan query     │   │ BM25 + phrase  │
      │ (pure code)  │    │ (21 plans)     │   │ over 14.6k     │
      └──────────────┘    └────────────────┘   │ doc chunks     │
                                               └────────────────┘
```

**The central design decision:** numbers come from structured queries, prose comes from retrieval, and eligibility comes from deterministic code. The model decides *what to ask* and *how to explain* — never *what is true*.

Why that split matters: premiums and copays are values in tables. Semantic search across 21 plans × ~200 pages will confidently return **the wrong plan's** figures — the single most likely way a plan-comparison demo fails in front of an audience.

Full reasoning in [docs/architecture.md](docs/architecture.md).

---

## Running it

```bash
npm install
cp .env.example .env.local     # then paste your key into .env.local
npm run ingest                 # builds the document corpus from plan PDFs
npm run dev
```

Get an API key at [platform.claude.com](https://platform.claude.com). Create a workspace with a spend limit and scope the key to it — this app is designed to be publicly shareable, so a hard cap matters.

**The key is server-side only.** All model calls go through `/api/chat`; the key never reaches the browser.

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Local dev server |
| `npm run ingest` | Extract text from plan PDFs → `data/document-corpus.json` |
| `npm run typecheck` | TypeScript, no emit |
| `npx tsx scripts/test-retrieval.ts` | Retrieval smoke test, including plan-isolation assertion |

**Note:** `npm run ingest` expects the source PDFs locally (see `scripts/ingest.mjs` for the path). The generated corpus is committed, so the app runs without re-ingesting.

---

## What's real and what's simulated

Stated explicitly, because blurring this line is how prototypes lose credibility.

**Real:**
- Live model calls with tool use
- 21 actual 2026 Humana plans for ZIP 28270, transcribed from Humana's public listing
- 14,674 text chunks extracted from 42 official Summary of Benefits and Evidence of Coverage PDFs
- Retrieval with page-level citations that resolve to the real documents
- Eligibility rules as executable, testable code
- Browser speech input and output

**Simulated / out of scope:**
- **No enrollment is ever submitted.** The application is assembled and presented for confirmation, then stops — deliberately
- Provider network and formulary lookups are not wired to live directories
- One ZIP code (28270). Humana's listing showed 24 plans; 21 were captured — its own filters excluded 3 without disclosing them
- No authentication, no PHI, no member data. Personas are fictional
- Cost estimates are rough and labelled as such

---

## Repository layout

```
app/
  api/chat/route.ts     agent loop, system prompt, guardrails
  page.tsx              chat UI, voice, persona entry points
components/
  TracePanel.tsx        shows which tools ran — makes grounding visible
lib/
  eligibility.ts        deterministic CMS rules
  plans.ts              structured plan query
  retrieval.ts          BM25 + phrase boosting, hard plan-ID filter
  tools.ts              tool definitions + executors
  useSpeech.ts          Web Speech API wrapper
scripts/
  ingest.mjs            PDF → chunked corpus
  test-retrieval.ts     smoke test + isolation assertion
data/
  plans-28270.json      structured plan attributes
  document-corpus.json  extracted document text
```

---

## Guardrails

- Persistent disclosure that the user is talking to an AI — a CMS requirement for automated agents, not decoration
- The assistant does **not** recommend a "best" plan — that's a licensed activity. It explains differences and routes to a human. This is the project's key tradeoff, discussed in [docs/architecture.md](docs/architecture.md)
- Declines medical advice
- Warns against entering Medicare numbers, SSNs, or bank details
- Retrieval is hard-filtered by plan ID before scoring, so one plan's benefits can never answer a question about another. Asserted in the test suite

---

*Shrinivas Tekale · September 2026*
