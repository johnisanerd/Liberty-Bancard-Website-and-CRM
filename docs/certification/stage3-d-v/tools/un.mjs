import { launch, login } from "./cdp.mjs";
const b = await launch({ port: 9411, width: 1280, height: 900 }); await login(b);
await b.send("Page.addScriptToEvaluateOnNewDocument",{source:"localStorage.setItem('prefer_desktop','true')"});
for (const r of ["/dashboard/onboarding-kickoff","/dashboard/pipeline"]) {
  await b.send("Page.navigate",{url:"http://127.0.0.1:5000"+r});
  for(let i=0;i<14;i++){ await b.sleep(1200); if(await b.evalJs(`document.querySelectorAll('h1').length>0`).catch(()=>false)) break; }
  await b.sleep(3000);
  const rows = JSON.parse(await b.evalJs(`JSON.stringify([...document.querySelectorAll('button,[role=tab],[role=combobox],input:not([type=hidden]),textarea,select,a[href]')].filter(x=>x.getClientRects().length>0&&!x.closest('[aria-hidden=true]')&&x.getAttribute('aria-hidden')!=='true'&&!(x.textContent.trim()||(x.labels&&x.labels.length)||x.getAttribute('aria-label')||x.getAttribute('aria-labelledby')||x.title||x.getAttribute('placeholder')||x.querySelector('img[alt]:not([alt=""])'))).map(e=>e.outerHTML.replace(/data-replit-metadata="[^"]*"|data-component-[a-z-]*="[^"]*"/g,'').slice(0,230)))`));
  console.log(r, rows.length); for (const x of rows.slice(0,4)) console.log("  ", x);
}
b.close();
