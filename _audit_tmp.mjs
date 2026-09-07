const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
import fs from 'fs';
const DIR="D:/Claude/Projects/Humana/Humana Plan Assistant/00-Source-Documents/Plan-Documents-ZIP28270/";
async function pg(file, list){
  const data=new Uint8Array(fs.readFileSync(DIR+file));
  const doc=await (pdfjs.getDocument({data,useSystemFonts:true}).promise);
  console.log('\n##### '+file+'  numPages='+doc.numPages);
  for(const i of list){
    const p=await doc.getPage(i);
    const tc=await p.getTextContent();
    const t=tc.items.map(it=>('str' in it? it.str:'')).join(' ');
    const clean=t.replace(/\s+/g,' ').trim();
    const ops=await p.getOperatorList();
    const imgOps=ops.fnArray.filter(f=>f===pdfjs.OPS.paintImageXObject||f===pdfjs.OPS.paintInlineImageXObject||f===pdfjs.OPS.paintJpegXObject).length;
    console.log(`-- page ${i}: rawItems=${tc.items.length} cleanLen=${clean.length} imageOps=${imgOps}`);
    console.log('   TEXT: '+JSON.stringify(clean.slice(0,350)));
  }
}
await pg("HMO-H1036-318-SummaryOfBenefits.pdf",[18,19,20,21,22,23,24]);
await pg("HMO-H1036-318-EvidenceOfCoverage.pdf",[1,3,4,190,192,193,196]);
