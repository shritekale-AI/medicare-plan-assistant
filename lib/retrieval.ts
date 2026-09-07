/**
 * Retrieval over official plan documents (Summary of Benefits / Evidence of Coverage).
 *
 * WHY BM25 RATHER THAN EMBEDDINGS
 * This corpus is dominated by rare, high-signal terms — drug names, "prior
 * authorization", "skilled nursing facility", "urgently needed services". Lexical
 * scoring handles those extremely well, needs no embedding service, adds no network
 * latency, and is fully inspectable — which matters in a regulated context where you
 * may have to explain why a particular passage was surfaced.
 *
 * Dense retrieval would add value for genuinely paraphrased questions ("can I see a
 * doctor when I'm away from home" → "urgently needed services"). That is a deliberate
 * deferral, not an oversight — see docs/architecture.md. The mitigation in the
 * meantime is model-side query expansion before the search is issued.
 *
 * THE NON-NEGOTIABLE: metadata filtering by planId happens BEFORE scoring. Returning
 * one plan's benefits in answer to a question about another is the single most
 * damaging failure this system could have, and it is structurally prevented here
 * rather than discouraged by a prompt.
 */

import fs from "fs";
import path from "path";

export type Chunk = {
  id: string;
  planId: string;
  docType: "SB" | "EOC";
  /** Short content hash of the source PDF — identifies the document revision. */
  docVersion?: string;
  /** Section heading, where one was detectable during ingestion. */
  section: string;
  /** Page number in the source PDF, for citation. */
  page: number;
  text: string;
};

export type RetrievalHit = {
  text: string;
  score: number;
  citation: {
    planId: string;
    document: string;
    section: string;
    page: number;
    url: string;
    docVersion: string;
    corpusVersion: string;
  };
};

export type CorpusMeta = {
  corpusVersion: string;
  ingestedAt: string;
  planYear: number;
  chunkCount: number;
  planCount: number;
  sourceCount: number;
};

let CORPUS: Chunk[] | null = null;
let META: CorpusMeta | null = null;
let IDF: Map<string, number> | null = null;
let AVG_LEN = 0;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "is", "are", "be",
  "with", "as", "at", "by", "from", "that", "this", "it", "you", "your", "will",
  "may", "can", "if", "not", "we", "our", "have", "has", "do", "does",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function loadCorpus(): Chunk[] {
  if (CORPUS) return CORPUS;
  const corpusPath = path.join(process.cwd(), "data", "document-corpus.json");
  if (!fs.existsSync(corpusPath)) {
    CORPUS = [];
    return CORPUS;
  }
  const parsed = JSON.parse(fs.readFileSync(corpusPath, "utf-8")) as
    | Chunk[]
    | { meta: CorpusMeta; chunks: Chunk[] };

  // Accept both the legacy flat array and the versioned {meta, chunks} shape, so an
  // older corpus doesn't break the app before it's been re-ingested.
  if (Array.isArray(parsed)) {
    CORPUS = parsed;
    META = null;
  } else {
    CORPUS = parsed.chunks;
    META = parsed.meta;
  }

  // Precompute IDF across the whole corpus.
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const chunk of CORPUS) {
    const tokens = tokenize(chunk.text);
    totalLen += tokens.length;
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = CORPUS.length || 1;
  IDF = new Map();
  for (const [term, count] of df) {
    IDF.set(term, Math.log(1 + (N - count + 0.5) / (count + 0.5)));
  }
  AVG_LEN = totalLen / N;
  return CORPUS;
}

const K1 = 1.5;
const B = 0.75;
/** Weight applied per matched adjacent term pair. Tuned by hand against scripts/test-retrieval.ts. */
const PHRASE_BOOST = 2.5;

function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

/**
 * BM25 plus a phrase-proximity boost.
 *
 * Pure bag-of-words scoring struggles here because domain phrases are built from
 * individually common words — "skilled nursing facility", "urgently needed services",
 * "durable medical equipment". Each token is unremarkable; the sequence is decisive.
 * Rewarding adjacent-pair matches recovers most of what a dense retriever would give
 * on this corpus, at a fraction of the complexity.
 */
function scoreChunk(queryTokens: string[], queryBigrams: string[], chunk: Chunk): number {
  const tokens = tokenize(chunk.text);
  const len = tokens.length || 1;
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const q of queryTokens) {
    const f = tf.get(q);
    if (!f) continue;
    const idf = IDF?.get(q) ?? 0;
    score += (idf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * len) / (AVG_LEN || 1)));
  }

  if (queryBigrams.length > 0) {
    const chunkBigrams = new Set(bigrams(tokens));
    for (const bg of queryBigrams) {
      if (chunkBigrams.has(bg)) score += PHRASE_BOOST;
    }
  }

  return score;
}

const DOC_BASE = "https://www.humana-medicare.com/BenefitSummary/2026PDFs";

/**
 * Neutralise delimiter-spoofing in retrieved text.
 *
 * A document containing a literal `</retrieved_document>` could close the wrapper
 * early and make whatever follows look like trusted instruction rather than quoted
 * source material. Humana's own PDFs won't contain this — but the defence belongs
 * at the boundary, not in an assumption about who authored the corpus. The moment
 * this pipeline ingests provider-submitted or third-party content, the assumption
 * fails and the boundary is all that's left.
 */
function sanitiseForContext(text: string): string {
  return text.replace(/<\/?retrieved_document>/gi, "[tag removed]");
}

/**
 * Search one plan's documents. planId is required and applied as a hard filter.
 */
export async function searchPlanDocuments(
  planId: string,
  query: string,
  topK = 4
): Promise<{ hits: RetrievalHit[]; note?: string }> {
  const corpus = loadCorpus();

  if (corpus.length === 0) {
    return {
      hits: [],
      note:
        "The document corpus has not been built for this deployment. Run `npm run ingest` to extract text from the plan PDFs. Answer only from structured plan data and say plainly that you could not check the full document.",
    };
  }

  // Hard metadata filter FIRST — never score across plans.
  const scoped = corpus.filter((c) => c.planId.toLowerCase() === planId.toLowerCase());
  if (scoped.length === 0) {
    return { hits: [], note: `No indexed documents for plan ${planId}.` };
  }

  const queryTokens = tokenize(query);
  const queryBigrams = bigrams(queryTokens);
  const scored = scoped
    .map((chunk) => ({ chunk, score: scoreChunk(queryTokens, queryBigrams, chunk) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (scored.length === 0) {
    return {
      hits: [],
      note: `Nothing in plan ${planId}'s documents matched that. Say you could not find it and offer to connect them with a licensed advocate — do not answer from general knowledge.`,
    };
  }

  return {
    hits: scored.map(({ chunk, score }) => ({
      // Delimited so the model can tell retrieved reference material apart from
      // its instructions. Indirect prompt injection — malicious text living inside
      // an indexed document — is the realistic attack on a RAG system, and it works
      // precisely because retrieved text and instructions otherwise look identical
      // once they are both just tokens in the context window.
      text: `<retrieved_document>\n${sanitiseForContext(chunk.text)}\n</retrieved_document>`,
      score: Number(score.toFixed(3)),
      citation: {
        planId: chunk.planId,
        document: chunk.docType === "SB" ? "Summary of Benefits" : "Evidence of Coverage",
        section: chunk.section,
        page: chunk.page,
        url: `${DOC_BASE}/${chunk.id.split("::")[0]}${chunk.docType}26.pdf#page=${chunk.page}`,
        // Identifies the exact document revision this text came from. Plan documents
        // are revised mid-year; without it, a citation points at "the current file"
        // rather than the version that actually supported the answer.
        docVersion: chunk.docVersion ?? "unversioned",
        corpusVersion: META?.corpusVersion ?? "unversioned",
      },
    })),
  };
}

/** Corpus stats, surfaced so viewers can see what is actually indexed and at which version. */
export function corpusStats() {
  const corpus = loadCorpus();
  const plans = new Set(corpus.map((c) => c.planId));
  return {
    chunks: corpus.length,
    plans: plans.size,
    indexed: corpus.length > 0,
    corpusVersion: META?.corpusVersion ?? "unversioned",
    ingestedAt: META?.ingestedAt ?? null,
  };
}
