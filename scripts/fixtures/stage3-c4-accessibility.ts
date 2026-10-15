import assert from "node:assert/strict";
import {privateStage3Browser} from "./private-stage3-browser";
import type {stage3BHttpFixture} from "./stage3-b-http";

export async function runC4Accessibility(h:Awaited<ReturnType<typeof stage3BHttpFixture>>,rows:any[]){
  const b=await privateStage3Browser(h.base,h.sessions.get("admin")!.cookie,h.originalFetch,
    "docs/certification/stage3-c4/browser",{realInput:true,startupTimeoutMs:30000});
  try{
    await b.navigate("/mobile");await b.waitFor(/Switch to desktop view/);
    await b.waitFor(/Native appointments are unavailable/);
    await b.click('[data-testid="button-switch-to-desktop"]');
    await b.call("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
    for(const theme of ["light","dark"])for(const width of [320,390,768,1280,1440]){
      await b.call("Emulation.setDeviceMetricsOverride",{width,height:1000,deviceScaleFactor:1,mobile:false});
      for(const [url,ready,target] of [
        ["/dashboard/portfolio",/C4 Useful Business/,'main input[placeholder^="Search by name"]'],
        ["/dashboard/onboarding?tab=board",/Onboarding Operations Board/,"main h1"],
        ["/dashboard/onboarding-kickoff",/Closed Won Sales → linked Onboarding preparation/,"main h1"],
        ["/dashboard/terminal-roi",/Terminal Recommendation Forecasts/,'[data-testid="button-terminal-report-more"]'],
      ] as const){
        console.log(`C4 accessibility: ${theme}/${width} ${url}`);
        // Let the real ThemeProvider read the persisted theme on navigation.
        // Toggling only the root class races provider hydration/transitions.
        await b.evaluate(`localStorage.setItem("liberty-theme",${JSON.stringify(theme)})`);
        await b.navigate(url);await b.waitFor(ready);
        const settled=await b.evaluate(`(async()=>{
          let phase="fonts";
          return Promise.race([
            (async()=>{
              await document.fonts.ready;
              phase="animation frames";
              await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
              phase="CSS transitions";
              await Promise.all(document.getAnimations({subtree:true})
                .filter(animation=>animation.constructor.name==="CSSTransition")
                .map(animation=>animation.finished.catch(()=>{})));
              return {settled:true,phase:"complete"};
            })(),
            new Promise(resolve=>setTimeout(()=>resolve({settled:false,phase}),10000))
          ]);
        })()`);
        assert.equal(settled.settled,true,`${url} ${theme}/${width} theme settling timed out: ${settled.phase}`);
        assert.equal(await b.evaluate(`document.documentElement.classList.contains(${JSON.stringify(theme)})`),true,
          `${url} actual persisted theme ${theme}/${width}`);
        const probe=await b.evaluate(`(()=>{
          const e=document.querySelector(${JSON.stringify(target)}),r=e.getBoundingClientRect();
          const canvas=document.createElement("canvas");canvas.width=canvas.height=1;
          const ctx=canvas.getContext("2d",{willReadFrequently:true});
          const pixel=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);
            return [...ctx.getImageData(0,0,1,1).data];};
          const fg=pixel(getComputedStyle(e).color);
          let background=[255,255,255,255],p=e;
          while(p){const c=pixel(getComputedStyle(p).backgroundColor);
            if(c[3]===255){background=c;break;}p=p.parentElement;}
          const luminance=c=>c.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4)
            .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
          const f=luminance(fg),g=luminance(background),s=getComputedStyle(e);
          return {h1:document.querySelectorAll("main h1").length,
            overflow:document.documentElement.scrollWidth>innerWidth+1,
            height:r.height,width:r.width,label:e.getAttribute("aria-label")||e.textContent.trim(),
            contrast:(Math.max(f,g)+.05)/(Math.min(f,g)+.05),
            large:parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18.66&&parseFloat(s.fontWeight)>=700),
            reducedMotion:matchMedia("(prefers-reduced-motion: reduce)").matches,
            foreground:fg,background,computedColor:s.color,theme:document.documentElement.className};
        })()`);
        assert.equal(probe.h1,1,`${url} persistent H1 ${theme}/${width}`);
        assert.equal(probe.overflow,false,`${url} document-wide overflow ${theme}/${width}`);
        assert.equal(probe.reducedMotion,true);
        assert.ok(probe.contrast>=(probe.large?3:4.5),
          `${url} actual rendered text contrast ${theme}/${width}: ${JSON.stringify(probe)}`);
        if(target!=="main h1"){
          assert.ok(probe.height>=44,`${url} control target height ${probe.height}`);
          assert.ok(probe.label.length>0);
        }
        if(url==="/dashboard/portfolio"){
          // Physical keyboard traversal, not element.focus() or fabricated key events.
          await b.click(target);
          // CDP modifier bits are Alt=1, Ctrl=2, Meta=4, Shift=8.
          await b.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9,modifiers:8});
          await b.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9,modifiers:8});
          await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          await b.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
          await b.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Tab",code:"Tab",windowsVirtualKeyCode:9});
          await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
          const focus=await b.evaluate(`(()=>{const e=document.activeElement,s=getComputedStyle(e);return {
            matched:e.matches(${JSON.stringify(target)}),visible:e.matches(":focus-visible"),
            tag:e.tagName,testId:e.getAttribute("data-testid"),label:e.getAttribute("aria-label"),
            outlineWidth:parseFloat(s.outlineWidth),outlineStyle:s.outlineStyle};})()`);
          assert.equal(focus.matched,true,`${theme}/${width} actual settled Tab return: ${JSON.stringify(focus)}`);
          assert.equal(focus.visible,true,`${theme}/${width} native keyboard focus-visible: ${JSON.stringify(focus)}`);
          assert.ok(focus.outlineWidth>=2&&focus.outlineStyle!=="none");
          probe.keyboard=focus;
        }
        rows.push({phase:"C4 changed surfaces responsive/contrast/reduced-motion/label/keyboard",url,theme,width,probe});
      }
    }
  }finally{await b.close();}
}
