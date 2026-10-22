import { launch, login } from "./cdp.mjs";
import fs from "node:fs";
const routes = JSON.parse(fs.readFileSync("/tmp/lb/routes.json","utf8"));
const b = await launch({ port: 9410, width: 1280, height: 900 }); await login(b);
await b.send("Page.addScriptToEvaluateOnNewDocument",{source:"localStorage.setItem('prefer_desktop','true')"});
const facts = `(()=>{const vis=x=>x.getClientRects().length>0;
 const unnamed=[...document.querySelectorAll('button,[role=tab],[role=combobox],input:not([type=hidden]),textarea,select,a[href]')].filter(x=>vis(x)&&!(x.textContent.trim()||(x.labels&&x.labels.length)||x.getAttribute('aria-label')||x.getAttribute('aria-labelledby')||x.title||x.getAttribute('placeholder')||x.getAttribute('alt')||x.querySelector('img[alt]:not([alt=""]),svg title')));
 const ids=[...document.querySelectorAll('[id]')].map(e=>e.id);const dup=[...new Set(ids.filter((v,i)=>ids.indexOf(v)!==i))];
 const noAlt=[...document.querySelectorAll('img:not([alt])')].filter(vis).length;
 const wide=[...document.querySelectorAll('main *')].filter(e=>vis(e)&&e.getBoundingClientRect().right>innerWidth+2&&!e.closest('[class*=overflow-x],table,[role=tablist],pre,.overflow-auto,.overflow-x-auto')).length;
 const small=[...document.querySelectorAll('button,a[href],[role=tab]')].filter(e=>vis(e)&&(e.getBoundingClientRect().width<24||e.getBoundingClientRect().height<24)&&!e.closest('[role=tablist]')).length;
 return {h1:document.querySelectorAll('h1').length,main:document.querySelectorAll('main').length,overflowPx:document.documentElement.scrollWidth-innerWidth,unnamed:unnamed.length,unnamedSample:unnamed.slice(0,2).map(e=>e.outerHTML.slice(0,90)),dupIds:dup.slice(0,3),noAlt,wideEls:wide,smallTargets:small,err:/Show error details|Something went wrong/i.test(document.body.innerText)}})()`;
const out=[];
for (const r of routes) {
  await b.setViewport(1280,900,false);
  await b.send("Page.navigate",{url:"http://127.0.0.1:5000"+r});
  for(let i=0;i<14;i++){ await b.sleep(1200); if(await b.evalJs(`document.querySelectorAll('h1').length>0`).catch(()=>false)) break; }
  await b.sleep(1800);
  const row={route:r};
  for (const w of [1280,768,390]) { await b.setViewport(w,900,false); await b.sleep(500); row[w]=JSON.parse(await b.evalJs(`JSON.stringify(${facts})`).catch(()=>'{"err":"eval"}')); }
  out.push(row);
  const bad=[1280,768,390].flatMap(w=>{const f=row[w];const p=[];if(f.h1!==1)p.push(`${w}:h1=${f.h1}`);if(f.overflowPx>1)p.push(`${w}:overflow=${f.overflowPx}`);if(f.unnamed)p.push(`${w}:unnamed=${f.unnamed}`);if(f.err)p.push(`${w}:ERR`);if(f.dupIds?.length)p.push(`${w}:dupIds`);if(f.noAlt)p.push(`${w}:noAlt=${f.noAlt}`);return p});
  console.log(r, bad.length?bad.join(' '):'ok');
}
fs.writeFileSync("/tmp/lb/resp.json",JSON.stringify(out,null,1));
console.log("CONSOLE", JSON.stringify(b.consoleErrors.slice(0,5)));
b.close();
