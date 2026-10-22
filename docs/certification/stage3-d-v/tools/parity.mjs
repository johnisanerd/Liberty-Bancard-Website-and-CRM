import { launch, login } from "./cdp.mjs";
const b = await launch({ port: 9407 }); await login(b);
await b.goto("http://127.0.0.1:5000/dashboard", 4000);
const get = async (u)=> b.evalJs(`fetch(${JSON.stringify(u)},{credentials:'include'}).then(async r=>({s:r.status,j:await r.json().catch(()=>null)}))`);
const out = {};
for (const u of ["/api/analytics/pipeline","/api/dashboard/stats","/api/analytics/lifecycle-distribution","/api/analytics/conversion-funnel","/api/admin/data-health","/api/leaderboard"]) {
  const r = await get(u); out[u] = {status:r.s, keys: r.j && typeof r.j==='object' ? Object.keys(r.j).slice(0,14):null, sample: JSON.stringify(r.j).slice(0,700)};
}
for (const [k,v] of Object.entries(out)) console.log(k, v.status, v.sample);
b.close();
