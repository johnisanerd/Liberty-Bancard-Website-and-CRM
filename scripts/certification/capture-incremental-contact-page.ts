import fs from "node:fs";
import {PgDialect} from "drizzle-orm/pg-core";
import {loadEvidenceRelationshipPage} from "../../server/services/contact-business-evidence-page";

// SQL capture only: no database import, writer, credentials or network.
const ids=JSON.parse(process.argv[2]) as number[];
const since=process.argv[3];
if (!ids.every(Number.isSafeInteger) || !since) throw Error("INVALID_CAPTURE_SCOPE");
const dialect=new PgDialect();
const queries:any[]=[];
await loadEvidenceRelationshipPage({execute:async (query:any)=>{
  queries.push(dialect.sqlToQuery(query));
  return {rows:queries.length===1 ? ids.map(id=>({id})) : []};
}},0,25,undefined,since);
fs.mkdirSync("generated-artifacts/intake-incremental",{recursive:true});
fs.writeFileSync("generated-artifacts/intake-incremental/selector.json",JSON.stringify(queries,null,2));
console.log("Captured",queries.length,"read-only queries");
