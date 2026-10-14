import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,unlinkSync} from "node:fs";
import express from "express";
import {createServer} from "node:http";
import {uploadTabularLarge} from "../server/lib/tabular-upload";
import {readTabularImportWithCoordinates} from "../server/services/tabular-import-reader";
import {classifyCsvSourceFormat} from "../server/services/import-normalizer";

// Transport/parser regression only. No DB imports, credentials or CRM writes.
const app=express();
let parserEntries=0,checks=0;
app.post("/api/leads/import-csv",uploadTabularLarge.single("file"),async(req,res,next)=>{
  parserEntries++;
  if(!req.file)return res.status(400).json({code:"FILE_REQUIRED"});
  try{
    const bytes=readFileSync(req.file.path);
    const parsed=await readTabularImportWithCoordinates(bytes,req.file.originalname);
    res.json({hash:createHash("sha256").update(bytes).digest("hex"),rows:parsed.rows.length,
      sourceFormat:classifyCsvSourceFormat(Object.keys(parsed.rows[0] ?? {})),
      coordinates:parsed.coordinates.length});
  }catch(error){next(Object.assign(new Error("INVALID_TABULAR_CONTENT"),{status:400}));}
  finally{unlinkSync(req.file.path);}
});
app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status ?? 500).json({code:error.code ?? error.message}));
const server=createServer(app);
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const address=server.address();
assert(address && typeof address==="object");
async function upload(bytes:Uint8Array,name:string,type:string){
  const form=new FormData();
  form.append("file",new Blob([bytes as BlobPart],{type}),name);
  const result=await fetch(`http://127.0.0.1:${address.port}/api/leads/import-csv`,{
    method:"POST",body:form,redirect:"error",signal:AbortSignal.timeout(20_000),
  });
  return {status:result.status,body:await result.json()};
}
try{
  const fixtures=[
    ["Outscraper-20261002160911s8d6b_1791037870877.xlsx",537],
    ["Outscraper-20261002160955s00ed_1791037870876.xlsx",578],
    ["Outscraper-20261002161052s68e5_1791037870877.xlsx",513],
    ["Outscraper-20261002161147s2b94_1791037870876.xlsx",653],
    ["Outscraper-20261002161239s8aab_1791037870874.xlsx",633],
  ] as const;
  let sourceRows=0;
  for(const [file,rows] of fixtures){
    const bytes=readFileSync(`attached_assets/${file}`);
    const response=await upload(bytes,file,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(response.status,200);
    assert.equal(response.body.hash,createHash("sha256").update(bytes).digest("hex"));
    assert.equal(response.body.rows,rows);
    assert.equal(response.body.coordinates,rows);
    assert.equal(response.body.sourceFormat,"google_maps_outscraper");
    sourceRows+=rows;checks++;
  }
  const first=readFileSync(`attached_assets/${fixtures[0][0]}`);
  for(const mime of ["application/octet-stream","application/vnd.ms-excel"]){
    const response=await upload(first,"workbook.xlsx",mime);
    assert.equal(response.status,200);assert.equal(response.body.rows,537);checks++;
  }
  const csv=Buffer.from("name,site,phone,full_address\nExample,https://example.test,+15555550123,Example Street\n");
  for(const mime of ["text/csv","text/plain","application/csv","application/vnd.ms-excel"]){
    const response=await upload(csv,"example.csv",mime);
    assert.equal(response.status,200);assert.equal(response.body.rows,1);checks++;
  }
  const beforeRejected=parserEntries;
  for(const [name,mime] of [["archive.zip","application/zip"],["image.png","image/png"],
    ["legacy.xls","application/vnd.ms-excel"],["workbook.xlsx","text/csv"],
    ["renamed.csv","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]]){
    const response=await upload(csv,name,mime);
    assert.equal(response.status,400);assert.equal(response.body.code,"UNSUPPORTED_INTAKE_FILE_TYPE");checks++;
  }
  assert.equal(parserEntries,beforeRejected,"Invalid upload types never reach the parser");
  const corrupt=await upload(csv,"corrupt.xlsx","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(corrupt.status,400);assert.equal(corrupt.body.code,"INVALID_TABULAR_CONTENT");checks++;
  // Ensure the correction is scoped to intake, not the shared CSV/ZIP policy.
  const routes=readFileSync("server/routes/imports.ts","utf8");
  assert.match(routes,/app\.post\("\/api\/leads\/import-csv", isDashboardUser, requireRole\("admin", "manager"\), uploadTabularLarge\.single\("file"\)/);
  assert.match(routes,/app\.post\("\/api\/master-leads\/import-csv", isAuthenticated, uploadLarge\.single\("file"\)/);
  checks++;
  console.log(JSON.stringify({event:"TABULAR_UPLOAD_HTTP_PASS",checks,workbooks:5,sourceRows,
    scope:"Actual multipart admission and original-byte parser boundary; native persistence is separately certified",
    databaseWrites:0,providerCalls:0,outboundEffects:0}));
}finally{
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));
}
