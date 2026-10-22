import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire("/home/runner/workspace/package.json");
const WebSocket = require("ws");
export async function launch({ port = 9333, width = 1280, height = 900 } = {}) {
  const proc = spawn("/repl/tools/bin/chromium", ["--headless=new","--no-sandbox","--disable-gpu",`--remote-debugging-port=${port}`,`--window-size=${width},${height}`,`--user-data-dir=/tmp/lb/prof-${port}`,"about:blank"],{stdio:"ignore"});
  let list; for (let i=0;i<60;i++){ try{ list=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if(list.length)break;}catch{} await new Promise(r=>setTimeout(r,250)); }
  const page=list.find(t=>t.type==="page"); const ws=new WebSocket(page.webSocketDebuggerUrl); await new Promise(r=>ws.on("open",r));
  let id=0; const pending=new Map(); const consoleErrors=[]; const failed=[];
  ws.on("message",m=>{const d=JSON.parse(m); if(d.id&&pending.has(d.id)){pending.get(d.id)(d);pending.delete(d.id);}
    if(d.method==="Runtime.exceptionThrown")consoleErrors.push(d.params.exceptionDetails.text+" "+(d.params.exceptionDetails.exception?.description||"").slice(0,200));
    if(d.method==="Network.responseReceived"&&d.params.response.status>=400&&/\/api\//.test(d.params.response.url))failed.push(d.params.response.status+" "+d.params.response.url.slice(0,120));});
  const send=(method,params={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});
  await send("Page.enable");await send("Runtime.enable");await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride",{width,height,deviceScaleFactor:1,mobile:false});
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const evalJs=async(expression)=>{const r=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:true});if(r.result?.exceptionDetails)throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0,300));return r.result?.result?.value;};
  const goto=async(url,wait=2500)=>{await send("Page.navigate",{url});await sleep(wait);};
  const setViewport=(w,h,mobile=false)=>send("Emulation.setDeviceMetricsOverride",{width:w,height:h,deviceScaleFactor:1,mobile});
  const shot=async(path)=>{const r=await send("Page.captureScreenshot",{format:"png"});(await import("node:fs")).writeFileSync(path,Buffer.from(r.result.data,"base64"));};
  const key=async(k,code,vk)=>{await send("Input.dispatchKeyEvent",{type:"keyDown",key:k,code,windowsVirtualKeyCode:vk});await send("Input.dispatchKeyEvent",{type:"keyUp",key:k,code,windowsVirtualKeyCode:vk});};
  const close=()=>{try{ws.close();}catch{} proc.kill("SIGKILL");};
  return {send,evalJs,goto,sleep,shot,key,setViewport,close,consoleErrors,failed};
}
export async function login(b, base="http://127.0.0.1:5000", email=process.env.ADMIN_SEED_EMAIL, password=process.env.ADMIN_SEED_PASSWORD){
  await b.goto(base+"/login",2000);
  return await b.evalJs(`(async()=>{const t=await (await fetch('/api/csrf-token')).json();const res=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':t.csrfToken||t.token},credentials:'include',body:JSON.stringify({email:${JSON.stringify(email)},password:${JSON.stringify(password)}})});return res.status})()`);
}
