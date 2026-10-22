const base="https://libertybancard.com";
const urls=[];
for (const f of ["core","blog","locations","compare","glossary"]) { const t=await (await fetch(`${base}/sitemap-${f}.xml`)).text(); const u=[...t.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1]); console.log(f,u.length); const step=Math.max(1,Math.floor(u.length/7)); urls.push(...u.filter((_,i)=>i%step===0).slice(0,7)); }
let bad=0;
for(const u of urls){const r=await fetch(u,{redirect:"manual"});const t=await r.text();
 const h1=(t.match(/<h1[\s>]/g)||[]).length;const canon=/rel="canonical"/.test(t);const title=/<title>([^<]*)/.exec(t)?.[1]||"";
 const crm=/class="[^"]*\bcrm-(theme|page)\b/.test(t);
 const ok=r.status===200&&!crm&&title.length>0; if(!ok)bad++;
 console.log(r.status,u.replace(base,"")||"/",`title=${title.length>0}`,`canon=${canon}`,`crm=${crm}`);}
console.log("checked",urls.length,"bad",bad);
for (const p of ["/dashboard","/api/admin/data-health","/api/dashboard/stats"]) {const r=await fetch(base+p,{redirect:"manual"});console.log(p,r.status);}
