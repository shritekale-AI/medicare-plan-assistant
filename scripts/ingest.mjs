/**
 * Build the retrieval corpus from official Humana plan PDFs.
 *
 * Reads the Summary of Benefits / Evidence of Coverage PDFs downloaded from
 * humana-medicare.com, extracts text page by page, chunks it, and writes
 * data/document-corpus.json.
 *
 * Page-level extraction is deliberate: citations in the assistant point at a
 * specific page of a specific document, so a person can open the source and check.
 * That verifiability is what keeps generated benefit statements on the right side of
 * CMS marketing rules — see docs/architecture.md.
 *
 * Usage:  node scripts/ingest.mjs [--docs SB|EOC|both] [--limit N]
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, "..");

const PDF_DIR =
  "D:\\Claude\\Projects\\Humana\\Humana Plan Assistant\\00-Source-Documents\\Plan-Documents-ZIP28270";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DOC_FILTER = getArg("docs", "SB");
const LIMIT = parseInt(getArg("limit", "0"), 10);

/** Target ~900 characters per chunk with sentence-aware splitting. */
const TARGET_CHARS = 900;
const MIN_CHARS = 120;

function classify(filename) {
  const planMatch = filename.match(/([HR]\d{4}-\d{3}(?:-\d{3})?)/);
  if (!planMatch) return null;
  const planId = planMatch[1];
  let docType = null;
  if (/SummaryOfBenefits/i.test(filename)) docType = "SB";
  else if (/EvidenceOfCoverage/i.test(filename)) docType = "EOC";
  if (!docType) return null;
  const docId = planId.replace(/-/g, "").padEnd(11, "0").slice(0, 11);
  return { planId, docType, docId };
}

/** Split page text into chunks without cutting mid-sentence where avoidable. */
function chunkPage(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length < MIN_CHARS) return [];
  if (clean.length <= TARGET_CHARS) return [clean];

  const sentences = clean.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if (current.length + s.length > TARGET_CHARS && current.length >= MIN_CHARS) {
      chunks.push(current.trim());
      current = s;
    } else {
      current += (current ? " " : "") + s;
    }
  }
  if (current.trim().length >= MIN_CHARS) chunks.push(current.trim());
  return chunks;
}

/** Best-effort section heading: the first short, title-like line on the page. */
function guessSection(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 6)) {
    if (line.length > 3 && line.length < 70 && !/^\d+$/.test(line)) {
      return line.replace(/\s+/g, " ");
    }
  }
  return "General";
}

async function extractPdf(filePath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await loadingTask.promise;
  const pages = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
      pages.push({ page: i, text });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
}

async function main() {
  if (!fs.existsSync(PDF_DIR)) {
    console.error(`PDF directory not found: ${PDF_DIR}`);
    process.exit(1);
  }

  let files = fs.readdirSync(PDF_DIR).filter((f) => f.toLowerCase().endsWith(".pdf"));
  files = files.filter((f) => {
    const c = classify(f);
    if (!c) return false;
    if (DOC_FILTER === "both") return true;
    return c.docType === DOC_FILTER;
  });
  if (LIMIT > 0) files = files.slice(0, LIMIT);

  console.log(`Ingesting ${files.length} PDF(s) [docs=${DOC_FILTER}]\n`);

  const corpus = [];
  const sources = [];
  let fileNo = 0;

  for (const file of files) {
    fileNo++;
    const meta = classify(file);
    const filePath = path.join(PDF_DIR, file);
    process.stdout.write(`[${fileNo}/${files.length}] ${meta.planId} ${meta.docType} ... `);

    try {
      const bytes = fs.readFileSync(filePath);
      // Content hash identifies the exact document revision. Plan documents are
      // revised mid-year; without this, a citation silently points at whatever text
      // happens to be indexed now rather than the version that supported the answer.
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const stat = fs.statSync(filePath);

      const pages = await extractPdf(filePath);
      let added = 0;
      for (const { page, text } of pages) {
        const section = guessSection(text);
        for (const [idx, chunkText] of chunkPage(text).entries()) {
          corpus.push({
            id: `${meta.docId}::${page}::${idx}`,
            planId: meta.planId,
            docType: meta.docType,
            docVersion: sha256.slice(0, 12),
            section,
            page,
            text: chunkText,
          });
          added++;
        }
      }

      sources.push({
        planId: meta.planId,
        docType: meta.docType,
        docId: meta.docId,
        sourceFile: file,
        sha256,
        bytes: stat.size,
        pages: pages.length,
        chunks: added,
        sourceModified: stat.mtime.toISOString(),
      });

      console.log(`${pages.length} pages, ${added} chunks  [${sha256.slice(0, 12)}]`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
  }

  const plans = new Set(corpus.map((c) => c.planId)).size;
  const corpusVersion = crypto
    .createHash("sha256")
    .update(sources.map((s) => s.sha256).sort().join(""))
    .digest("hex")
    .slice(0, 16);

  const payload = {
    meta: {
      corpusVersion,
      ingestedAt: new Date().toISOString(),
      planYear: 2026,
      documentTypes: DOC_FILTER,
      chunkCount: corpus.length,
      planCount: plans,
      sourceCount: sources.length,
      chunking: { targetChars: TARGET_CHARS, minChars: MIN_CHARS, strategy: "sentence-aware within page" },
      note: "corpusVersion is derived from the content hashes of every source document. If any source PDF is revised, this value changes — which is the signal to re-run evaluations and review any cached answers.",
    },
    chunks: corpus,
  };

  const outPath = path.join(APP_ROOT, "data", "document-corpus.json");
  fs.writeFileSync(outPath, JSON.stringify(payload));

  // Human-readable manifest, committed alongside the corpus so document revisions
  // are visible in a diff rather than buried in an 11 MB blob.
  const manifestPath = path.join(APP_ROOT, "data", "corpus-manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ ...payload.meta, sources: sources.sort((a, b) => a.planId.localeCompare(b.planId)) }, null, 2)
  );

  const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`\nCorpus version: ${corpusVersion}`);
  console.log(`Wrote ${corpus.length} chunks across ${plans} plans → data/document-corpus.json (${sizeMb} MB)`);
  console.log(`Wrote manifest of ${sources.length} source documents → data/corpus-manifest.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
