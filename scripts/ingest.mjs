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
  let fileNo = 0;

  for (const file of files) {
    fileNo++;
    const meta = classify(file);
    const filePath = path.join(PDF_DIR, file);
    process.stdout.write(`[${fileNo}/${files.length}] ${meta.planId} ${meta.docType} ... `);

    try {
      const pages = await extractPdf(filePath);
      let added = 0;
      for (const { page, text } of pages) {
        const section = guessSection(text);
        for (const [idx, chunkText] of chunkPage(text).entries()) {
          corpus.push({
            id: `${meta.docId}::${page}::${idx}`,
            planId: meta.planId,
            docType: meta.docType,
            section,
            page,
            text: chunkText,
          });
          added++;
        }
      }
      console.log(`${pages.length} pages, ${added} chunks`);
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
    }
  }

  const outPath = path.join(APP_ROOT, "data", "document-corpus.json");
  fs.writeFileSync(outPath, JSON.stringify(corpus));
  const sizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
  const plans = new Set(corpus.map((c) => c.planId)).size;

  console.log(`\nWrote ${corpus.length} chunks across ${plans} plans → data/document-corpus.json (${sizeMb} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
