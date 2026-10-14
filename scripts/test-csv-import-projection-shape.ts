import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {getTableColumns} from "drizzle-orm";
import {csvImports} from "../shared/schema";
import {transform} from "esbuild";

// Execute the actual raw-upsert return boundary, not a mock native certificate.
const storage=readFileSync("server/storage/misc.ts","utf8");
const begin=storage.indexOf("const physical = r.rows[0]");
const end=storage.indexOf("\n    }",begin);
assert(begin>=0 && end>begin);
const {code}=await transform(`function normalize(r,getTableColumns,csvImports){
 ${storage.slice(begin,end)}
}`,{loader:"ts",target:"node22"});
const normalize=new Function(`${code};return normalize;`)();
const raw=Object.fromEntries(Object.values(getTableColumns(csvImports)).map(column=>[column.name,null]));
Object.assign(raw,{id:8,execution_id:"native-execution",file_name:"original.xlsx",
  source_format:"google_maps_outscraper",total_rows:513,status:"processing",
  processed_rows:0,created_at:new Date("2026-10-14T00:00:00Z"),
  vertical_breakdown:{retained:1},opt_out_preserved:0});
const dto=normalize({rows:[raw]},getTableColumns,csvImports);
assert.equal(dto.executionId,raw.execution_id);assert.equal(dto.fileName,raw.file_name);
assert.equal(dto.sourceFormat,raw.source_format);assert.equal(dto.totalRows,513);
assert.equal(dto.processedRows,0);assert.equal(dto.optOutPreserved,0);
assert.equal(dto.createdAt,raw.created_at);assert.equal(dto.verticalBreakdown,raw.vertical_breakdown);
assert(!Object.hasOwn(dto,"execution_id"));assert(!Object.hasOwn(dto,"file_name"));
assert.deepEqual(Object.keys(dto).sort(),Object.keys(getTableColumns(csvImports)).sort());
assert.equal(raw.execution_id,"native-execution","No physical-row mutation");
console.log(JSON.stringify({event:"CSV_IMPORT_PROJECTION_SHAPE_PASS",
  checkedColumns:Object.keys(dto).length,populatedNamesAndIdentity:true,
  zeroAndNullPreserved:true,dateAndJsonPreserved:true,databaseWrites:0}));
