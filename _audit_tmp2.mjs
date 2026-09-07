const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
import fs from 'fs';
const DIR="D:/Claude/Projects/Humana/Humana Plan Assistant/00-Source-Documents/Plan-Documents-ZIP28270/";
const file="PPO-H5216-017-SummaryOfBenefits.pdf";
const data=new Uint8Array(fs.readFileSync(DIR+file));
const doc=await (pdfjs.getDocument({data,useSystemFonts:true}).promise);
for (const pn of [8]) {
  const p=await doc.getPage(pn);
  const tc=await p.getTextContent();
  console.log(`### page ${pn}: ${tc.items.length} items; hasEOL present on items? ` + ('hasEOL' in tc.items[0]));
  console.log('items with hasEOL=true: ' + tc.items.filter(i=>i.hasEOL).length);
  // reconstruct true 2D layout: group by rounded y, sort by x
  const rows=new Map();
  for (const it of tc.items){
    if(!('str' in it)||!it.str.trim()) continue;
    const x=Math.round(it.transform[4]), y=Math.round(it.transform[5]);
    const key=Math.round(y/4)*4;
    if(!rows.has(key)) rows.set(key,[]);
    rows.get(key).push({x,s:it.str});
  }
  const ys=[...rows.keys()].sort((a,b)=>b-a);
  console.log('\n--- TRUE 2D LAYOUT (y desc, x asc) — what the member sees:');
  for(const y of ys){
    const cells=rows.get(y).sort((a,b)=>a.x-b.x);
    console.log(String(y).padStart(5)+' | '+cells.map(c=>`[x=${c.x}] ${c.s}`).join('   '));
  }
}
