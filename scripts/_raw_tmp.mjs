import fs from "fs";
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
const f = process.argv[2]; const pg = parseInt(process.argv[3],10);
const data = new Uint8Array(fs.readFileSync(f));
const doc = await pdfjs.getDocument({data, useSystemFonts:true}).promise;
const page = await doc.getPage(pg);
const content = await page.getTextContent();
for (const it of content.items) {
  if (!("str" in it)) continue;
  const t = it.transform;
  console.log(`x=${t[4].toFixed(0).padStart(4)} y=${t[5].toFixed(0).padStart(4)} h=${(it.height||0).toFixed(0)} eol=${it.hasEOL?1:0} | ${JSON.stringify(it.str)}`);
}
