import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {transform} from "esbuild";

const route=readFileSync("server/routes/imports.ts","utf8");
const begin=route.indexOf('const isProviderExport = sourceFormat ===');
const end=route.indexOf('const { getImportColumnMap }',begin);
assert(begin>=0 && end>begin);
const {code}=await transform(`async function run(sourceFormat,db,contacts,sql,and,ne,normalizePhoneForImport){
 ${route.slice(begin,end)}
 return {emailSet,phoneSet,companySet};
}`,{loader:"ts",target:"node22"});
const run=new Function(`${code};return run;`)();
let scans=0;
const forbidden={select:()=>{scans++;throw new Error("PROVIDER_GLOBAL_SCAN");}};
const contacts={email:"email",phone:"phone",companyName:"company_name"};
const sql=()=>"",and=(...args:unknown[])=>args,ne=(...args:unknown[])=>args;
for(const source of ["google_maps_outscraper","apollo_lead_list"]){
  const caches=await run(source,forbidden,contacts,sql,and,ne,(phone:string)=>phone);
  assert.equal(caches.emailSet.size,0);assert.equal(caches.phoneSet.size,0);
  assert.equal(caches.companySet.size,0);
}
assert.equal(scans,0);
const selected=[
  [{email:"preserved@example.test"}],
  [{phone:"12345678901"}],
  [{name:"preserved company"}],
];
const generic={select:()=>{const rows=selected[scans++];return {from:()=>({where:async()=>rows})};}};
const caches=await run("custom",generic,contacts,sql,and,ne,(phone:string)=>phone);
assert.equal(scans,3);assert(caches.emailSet.has("preserved@example.test"));
assert(caches.phoneSet.has("12345678901"));assert(caches.companySet.has("preserved company"));
console.log(JSON.stringify({event:"PROVIDER_IMPORT_CACHE_SCOPE_PASS",
  providerGlobalScans:0,genericScans:3,checks:3,databaseWrites:0,
  scope:"Actual route prelude, dependency-isolated; not native idle-timeout acceptance"}));
