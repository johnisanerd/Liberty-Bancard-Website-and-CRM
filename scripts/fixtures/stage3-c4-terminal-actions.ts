import assert from "node:assert/strict";
import type {stage3BHttpFixture} from "./stage3-b-http";
import type {privateStage3Browser} from "./private-stage3-browser";
import {deals} from "../../shared/schema";

export async function runC4TerminalActions(
  h:Awaited<ReturnType<typeof stage3BHttpFixture>>,
  b:Awaited<ReturnType<typeof privateStage3Browser>>,
  rows:Array<Record<string,unknown>>,
) {
  const config=await h.request("admin","GET","/api/admin/terminal-economics-config");
  assert.equal(config.status,200);
  const inserted=await h.db.insert(deals).values([10,(config.body.yellowThresholdMonths+10)*10,null,0].map((cost,index)=>({
    name:`${h.prefix} terminal observation ${index}`,pipeline:"sales",stage:"New Lead",
    recordClass:"production",terminalRecommendation:`${h.prefix} unmatched terminal model`,
    terminalCostAtOrder:cost,estimatedGrossProfitMonthly:"10",
  }))).returning();
  const sourcePath="/api/admin/terminal-roi-report";
  const report=await h.request("admin","GET",`${sourcePath}?page=0`);
  assert.equal(report.status,200);
  assert.equal((await h.request("manager","GET",`${sourcePath}?page=0`)).status,200);
  for(const role of ["agent","merchant","partner"])
    assert.equal((await h.request(role,"GET",`${sourcePath}?page=0`)).status,403);
  const observed=report.body.rows.filter((row:any)=>inserted.some(deal=>deal.id===row.dealId));
  assert.equal(observed.length,4);
  const sql=await h.pool.query("SELECT id,terminal_cost_at_order FROM deals WHERE id=ANY($1::int[])",[inserted.map(deal=>deal.id)]);
  for(const row of observed)assert.equal(row.terminalCost,sql.rows.find(value=>value.id===row.dealId).terminal_cost_at_order);
  assert.equal(observed.find((row:any)=>row.dealId===inserted[2].id).terminalCost,null);
  assert.equal(observed.find((row:any)=>row.dealId===inserted[3].id).terminalCost,0);

  b.delayRead(sourcePath,2000);
  await b.navigate("/dashboard/terminal-roi");
  await b.waitFor(/Terminal Recommendation Forecasts/);
  assert.equal(await b.evaluate('document.querySelector("[data-testid=button-export-report]").disabled'),true);
  for(let attempt=0;attempt<100;attempt++){
    if(await b.evaluate('!!document.querySelector("[data-testid=text-report-generated-at]")'))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  b.delayRead(null);
  assert.equal(await b.evaluate('document.querySelector("[data-testid=button-export-report]").disabled'),false);
  for(const [control,title] of [
    ["button-manage-models",/Equipment Catalog/],
    ["button-configure-thresholds",/Payback Threshold Configuration/],
  ] as const){
    await b.click('[data-testid="button-terminal-report-more"]');
    await b.click(`[data-testid="${control}"]`);
    await b.waitFor(title);
    assert.equal(await b.evaluate('document.querySelectorAll("[role=dialog]").length'),1);
    assert.equal(await b.evaluate(`(async()=>{
      for(let attempt=0;attempt<100;attempt++){
        const modal=document.querySelector('[role="dialog"][data-state="open"]');
        if(modal?.contains(document.activeElement)&&modal.getAnimations().every(animation=>animation.playState!=="running")){
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          return modal.contains(document.activeElement);
        }
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      return false;
    })()`),true,"Terminal modal owns settled opening focus before its single Escape");
    await b.call("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await b.call("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    for(let attempt=0;attempt<60&&await b.evaluate('!!document.querySelector("[role=dialog]")');attempt++)
      await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(await b.evaluate('!!document.querySelector("[role=dialog]")'),false);
    assert.equal(await b.evaluate('document.activeElement===document.querySelector("[data-testid=button-terminal-report-more]")'),true,
      "Terminal dialog Escape restores its actual overflow caller");
  }
  await b.click('[data-testid="filter-tier-red"]');
  assert.equal(await b.evaluate('document.querySelector("[data-testid=filter-tier-red]").getAttribute("aria-pressed")'),"true");
  await b.evaluate(`(()=>{
    const originalCreate=URL.createObjectURL, originalClick=HTMLAnchorElement.prototype.click;
    window.__terminalCsv=null;
    URL.createObjectURL=function(blob){window.__terminalCsv=blob.text();return originalCreate.call(URL,blob)};
    HTMLAnchorElement.prototype.click=function(){if(!this.download.startsWith("terminal-roi-report"))return originalClick.call(this)};
    window.__restoreTerminalCsv=()=>{URL.createObjectURL=originalCreate;HTMLAnchorElement.prototype.click=originalClick};
  })()`);
  let csv:string;
  try{
    await b.click('[data-testid="button-export-report"]');
    csv=await b.evaluate("window.__terminalCsv");
  }finally{await b.evaluate("window.__restoreTerminalCsv()");}
  const exportedIds=csv.trim().split(/\r?\n/).slice(1).map(line=>Number(line.split(",")[0].replaceAll('"',"")));
  assert.deepEqual(exportedIds,report.body.rows.filter((row:any)=>row.tier==="red").map((row:any)=>row.dealId));
  assert.ok(exportedIds.includes(inserted[1].id));
  assert.ok(!exportedIds.includes(inserted[2].id));
  assert.ok(csv.includes("Terminal Cost ($)"));
  b.failRead(sourcePath);
  await b.click('[data-testid="button-refresh-report"]');
  await b.waitFor(/Terminal recommendation report unavailable/);
  assert.equal(await b.evaluate('document.querySelector("[data-testid=button-export-report]").disabled'),true);
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid=text-no-terminal-data]")'),false);
  assert.ok(b.readFaults.some(fault=>fault.path===sourcePath&&fault.status===503));
  b.failRead(null);
  await b.click('[data-testid="button-refresh-report"]');
  for(let attempt=0;attempt<100&&await b.evaluate('!!document.querySelector("[data-testid=terminal-report-error]")');attempt++)
    await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(await b.evaluate('!!document.querySelector("[data-testid=terminal-report-error]")'),false);
  assert.equal(await b.evaluate('document.querySelector("[data-testid=button-export-report]").disabled'),false);
  rows.push({phase:"Terminal header actions, filtered USD forecast CSV, loading/source error/retry and role boundaries",
    fixtureDealIds:inserted.map(deal=>deal.id),exportedIds,
    qualification:"Four actual header callbacks, settled modal focus and one native Escape/caller-focus restoration for both dialogs, real scoped reader/SQL/Blob parity; forecasts only, no model mutations, native deployment or payments"});
}
