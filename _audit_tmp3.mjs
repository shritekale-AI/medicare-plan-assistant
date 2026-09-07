// Reimplement the exact scoring from lib/retrieval.ts to test what the model receives.
import fs from 'fs';
const j=JSON.parse(fs.readFileSync('./data/document-corpus.json','utf8'));
const CORPUS=j.chunks;
const STOP=new Set(["the","a","an","and","or","of","to","in","for","on","is","are","be","with","as","at","by","from","that","this","it","you","your","will","may","can","if","not","we","our","have","has","do","does"]);
const tok=t=>t.toLowerCase().replace(/[^a-z0-9\s-]/g," ").split(/\s+/).filter(x=>x.length>1&&!STOP.has(x));
const df=new Map(); let tl=0;
for(const c of CORPUS){const t=tok(c.text);tl+=t.length;for(const x of new Set(t))df.set(x,(df.get(x)||0)+1);}
const N=CORPUS.length; const IDF=new Map(); for(const[t,d]of df)IDF.set(t,Math.log(1+(N-d+0.5)/(d+0.5)));
const AVG=tl/N; const K1=1.5,B=0.75,PB=2.5;
const bg=t=>{const o=[];for(let i=0;i<t.length-1;i++)o.push(t[i]+' '+t[i+1]);return o;};
function score(qt,qb,c){const t=tok(c.text);const len=t.length||1;const tf=new Map();for(const x of t)tf.set(x,(tf.get(x)||0)+1);
let s=0;for(const q of qt){const f=tf.get(q);if(!f)continue;s+=((IDF.get(q)||0)*(f*(K1+1)))/(f+K1*(1-B+B*len/AVG));}
const cb=new Set(bg(t));for(const b of qb)if(cb.has(b))s+=PB;return s;}
function search(planId,q,topK=4){const sc=CORPUS.filter(c=>c.planId.toLowerCase()===planId.toLowerCase());
const qt=tok(q),qb=bg(qt);
return sc.map(c=>({c,s:score(qt,qb,c)})).filter(x=>x.s>0).sort((a,b)=>b.s-a.s).slice(0,topK);}
for(const q of ["urgent care center copay","cost of an MRI advanced imaging","inpatient hospital copay per day"]){
  console.log('\n\n########## QUERY: '+q+'   plan H5216-017');
  for(const {c,s} of search('H5216-017',q)){
    console.log(`\n--- score=${s.toFixed(2)} ${c.docType} p${c.page} id=${c.id} section=${c.section}`);
    console.log(c.text.slice(0,700));
  }
}
