import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";

// C3 F06 acceptance on a guarded disposable database: a >500-row fixture reached through the real
// /api/prospects route (actual session), server total, server search past row 500, no duplicate or
// skipped rows across pages, and role denial.
const h=await stage3BHttpFixture(async app=>{
  (await import("../server/routes/prospects")).registerProspectsRoutes(app);
});
const tag=`c3p${randomUUID().replaceAll("-","").slice(0,10)}`;
try {
  const ROWS=620;
  await h.pool.query(`INSERT INTO prospects(company_name,vertical) SELECT $1||'-'||lpad(g::text,4,'0'), CASE WHEN g%2=0 THEN 'Automotive' ELSE 'Healthcare' END FROM generate_series(1,$2) g`,[tag,ROWS]);
  const get=async(query:string,role="manager")=>h.request(role,"GET",`/api/prospects?${query}`);
  const first=await get(`search=${tag}&limit=100&offset=0`);
  assert.equal(first.status,200,JSON.stringify(first.body));
  assert.equal(first.body.total,ROWS,"total is the server filtered total, not the loaded page size");
  assert.equal(first.body.data.length,100);
  const seen=new Set<number>();
  for(let offset=0;offset<ROWS;offset+=100) {
    const page=await get(`search=${tag}&limit=100&offset=${offset}`);
    assert.equal(page.body.total,ROWS);
    for(const row of page.body.data) { assert.ok(!seen.has(row.id),"no duplicate rows across pages"); seen.add(row.id); }
  }
  assert.equal(seen.size,ROWS,"no skipped rows across pages");
  const beyond=await get(`search=${tag}-0600&limit=25`);
  assert.equal(beyond.body.total,1,"server search finds a row beyond position 500");
  assert.equal(beyond.body.data[0].companyName,`${tag}-0600`);
  const vertical=await get(`search=${tag}&vertical=Automotive&limit=100`);
  assert.equal(vertical.body.total,ROWS/2,"filter total is authoritative");
  assert.equal((await get(`search=${tag}&limit=101`)).status,400,"the page cap is not raised");
  for(const role of ["agent","merchant","partner"]) assert.equal((await get(`search=${tag}`,role)).status,403,`${role} denied`);
  assert.equal(h.externalCalls(),0);
  console.log("STAGE3_C3_PROSPECTS_PASS");
} finally { await h.close(); }
