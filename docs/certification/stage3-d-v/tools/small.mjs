import { launch, login } from "./cdp.mjs";
const b = await launch({ port: 9412, width: 390, height: 900 }); await login(b);
await b.send("Page.addScriptToEvaluateOnNewDocument",{source:"localStorage.setItem('prefer_desktop','true')"});
for (const r of ["/dashboard/activation","/dashboard/lead-ops"]) {
  await b.send("Page.navigate",{url:"http://127.0.0.1:5000"+r});
  for(let i=0;i<20;i++){ await b.sleep(1500); if(await b.evalJs(`document.querySelectorAll('h1').length>0`).catch(()=>false)) break; }
  await b.sleep(3000);
  const rows = JSON.parse(await b.evalJs(`JSON.stringify([...document.querySelectorAll('button,a[href],[role=tab]')].filter(e=>e.getClientRects().length>0&&(e.getBoundingClientRect().width<24||e.getBoundingClientRect().height<24)&&!e.closest('[role=tablist]')).map(e=>{const r=e.getBoundingClientRect();return Math.round(r.width)+'x'+Math.round(r.height)+' '+e.outerHTML.replace(/data-replit-metadata="[^"]*"|data-component-[a-z-]*="[^"]*"/g,'').slice(0,150)}))`));
  console.log(r, rows.length); for (const x of rows.slice(0,3)) console.log("  ", x);
}
const v = await b.evalJs(`fetch('/api/dashboard/stats',{credentials:'include'}).then(r=>r.json())`).catch(e=>String(e));
console.log("stats", JSON.stringify(v));
const c = await b.evalJs(`fetch('/sitemap-compare.xml').then(r=>r.text()).then(t=>(t.match(/\\/compare\\//g)||[]).length)`);
console.log("compare sitemap compare entries", c);
b.close();
