import fs from "node:fs";
import {PgDialect} from "drizzle-orm/pg-core";
import {db,pool} from "../../server/db";
import {loadEvidenceRelationshipPage} from "../../server/services/contact-business-evidence-page";
// Read-only development measurement. Never derives a production connection.
if(process.env.REPLIT_DEPLOYMENT==="1")throw Error("DEVELOPMENT_PROFILE_ONLY");
const since="2026-10-03 13:06:25.56618+00";
const dialect=new PgDialect();
const samples:any[]=[];
try {
  for (const after of [0,153674,159881,160660]) {
    const stages:any[]=[];
    const executor={execute:async(q:any)=>{
      const compiled=dialect.sqlToQuery(q),start=performance.now();
      const result=await db.execute(q);
      stages.push({query:compiled,elapsedMs:performance.now()-start});
      return result;
    }};
    const start=performance.now();
    const result=await loadEvidenceRelationshipPage(executor,after,25,undefined,since);
    const elapsedMs=performance.now()-start;
    const plans=[];
    for(const stage of stages) {
      plans.push((await pool.query("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) "+stage.query.sql,stage.query.params)).rows);
    }
    samples.push({after,since,elapsedMs,changed:result.previews.length,
      inspectedThroughContactId:result.inspectedThroughContactId,passExhausted:result.passExhausted,stages,plans});
    console.log(JSON.stringify({after,elapsedMs,changed:result.previews.length,stageMs:stages.map(s=>s.elapsedMs)}));
  }
  const cardinalities=(await pool.query(`SELECT
    (SELECT count(*) FROM contacts) contacts,(SELECT count(*) FROM businesses) businesses,
    (SELECT count(*) FROM sunbiz_entities) registry,(SELECT count(*) FROM canonical_source_links) source_links`)).rows[0];
  fs.mkdirSync("generated-artifacts/intake-incremental",{recursive:true});
  fs.writeFileSync("generated-artifacts/intake-incremental/dev-profile.json",
    JSON.stringify({environment:"development",cardinalities,samples,productionAcceptance:false},null,2));
} finally {await pool.end();}
