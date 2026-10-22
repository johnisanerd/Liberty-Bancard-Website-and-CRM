const base="http://127.0.0.1:5000";
const urls=[];
for (const f of ["core","blog","locations","compare","glossary"]) { const t=await (await fetch(`${base}/sitemap-${f}.xml`)).text(); urls.push(...[...t.matchAll(/<loc>https:\/\/libertybancard\.com([^<]*)<\/loc>/g)].map(m=>m[1]||"/")); }
console.log("urls",urls.length);
const bad=[]; let i=0;
await Promise.all(Array.from({length:8},async()=>{while(i<urls.length){const u=urls[i++];const r=await fetch(base+u,{redirect:"manual"});if(r.status!==200)bad.push(u+" "+r.status);await r.arrayBuffer();}}));
console.log("non-200:",bad.length,bad.slice(0,15).join(", "));
