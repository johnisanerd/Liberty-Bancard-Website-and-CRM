import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readdirSync,readFileSync} from "node:fs";
import {join} from "node:path";
import ts from "typescript";
import {sql} from "drizzle-orm";
import {db,pool} from "../../server/db";
import {claimCsvExecution,recordImportRowDisposition,completeImportExecution} from "../../server/services/import-execution";
import {mapProviderCsvRow} from "../../server/services/provider-import-columns";
import {providerCsvSourceSubject} from "../../server/services/cro03a/adapters";
import {createCro03SourceBatch,hashCro03Evidence} from "../../server/services/cro03/source-staging";
import {lockCurrentSfpRuntimeOwner} from "../../server/services/cro03/sfp-provider-operations";
import {sameSfpRuntimeRelease,SFP_RUNTIME_OWNER_LEASE_MS,getCurrentSfpRuntimeFence} from "../../server/services/cro03/sfp-runtime-fence";
import {acquireLadderBudgetLock} from "../../server/services/cro03/shared-paid-budget-ledger";

export interface RetainedRow {
  sourceRowNumber:number; rawRow:Record<string,string>; sourceFormat:string;
  rowFingerprint:string; disposition:"deferred"|"failed"|"created"|"matched_noop"; reasonCode:string;
  sourceCoordinate?:any;
  diagnostic?:Record<string,unknown>;
  originalObservation?:{id:string;subjectId:string;payload:Record<string,unknown>;
    provenance:Record<string,unknown>;payloadHash:string};
  originalItem?:{state:string;terminal_code:string|null;claim_token:string|null;
    lease_expires_at:string|null;current_provider:string|null;execution_fence:number;
    attempt_count:number;next_attempt_at:string;completed_at:string|null};
}
export const inputRows=()=>{
  const directory=process.env.RETAINED_INPUT_DIR!;
  const rows:RetainedRow[]=readdirSync(directory).filter(name=>/^part-\d+\.json$/.test(name))
    .sort().flatMap(name=>JSON.parse(readFileSync(join(directory,name),"utf8")));
  assert.equal(rows.length,1472);
  rows.forEach((row,index)=>assert.equal(row.sourceRowNumber,index+1));
  // Private production captures must preserve the independently acquired mapped
  // identity and mutable topology. Old normalized exports are not proof.
  assert(rows.every(row=>row.originalObservation && row.originalItem),
    "RETAINED_ORIGINAL_OBSERVATION_AND_ITEM_REQUIRED");
  assert(rows.some(row=>row.originalObservation!.payload.rowFingerprint!==row.rowFingerprint),
    "RETAINED_MISMATCH_TOPOLOGY_REQUIRED");
  assert(rows.every(row=>hashCro03Evidence(row.originalObservation!.payload)===row.originalObservation!.payloadHash),
    "RETAINED_ORIGINAL_PAYLOAD_HASH_DRIFT");
  return rows;
};
export async function seedExecution(rows:RetainedRow[],kind:string) {
  const digest=createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const claim=await claimCsvExecution({fileHash:createHash("sha256").update(kind+digest+randomUUID()).digest("hex"),
    totalRows:rows.length,actorType:"import",actorId:"system:retained-recovery-certification",
    sourcePayload:rows.map(row=>row.rawRow),metadata:{certificationKind:kind,inputDigest:digest,
      sourceCoordinates:rows.map(row=>row.sourceCoordinate ?? null)}});
  for(const [index,row] of rows.entries()){
    const draft=providerCsvSourceSubject({importExecutionId:claim.execution.id,sourceRowNumber:index+1,
      sourceSystem:row.sourceFormat==="apollo_lead_list" ? "apollo" : "outscraper",
      row:mapProviderCsvRow(row.rawRow,row.sourceFormat as any)});
    assert.equal(row.sourceRowNumber,index+1,"Fixture coordinates may not be renumbered");
    await createCro03SourceBatch({idempotencyKey:`csv-source:${claim.execution.id}:${index+1}`,
      actorType:"import",actorId:"system:retained-recovery-certification",purpose:"staging_review",
      subjects:[{...draft,
        ...(row.originalObservation ? {provenance:{...row.originalObservation.provenance,
          importExecutionId:claim.execution.id}} : {}),
        payload:row.originalObservation?.payload ?? {...draft.payload,sourceFormat:row.sourceFormat,
          rowFingerprint:row.rowFingerprint,sourceRowNumber:index+1}}]});
    await recordImportRowDisposition({executionId:claim.execution.id,claimToken:claim.claimToken!,
      sourceRowNumber:index+1,rowFingerprint:row.rowFingerprint,disposition:row.disposition,
      reasonCode:row.reasonCode,diagnostic:row.diagnostic});
    if(row.originalItem) {
      const item=row.originalItem;
      await pool.query(`UPDATE cro03_enrichment_items item SET state=$2,terminal_code=$3,
        claim_token=$4::uuid,lease_expires_at=$5::timestamptz,current_provider=$6,
        execution_fence=$7,attempt_count=$8,next_attempt_at=$9::timestamptz,completed_at=$10::timestamptz
        FROM cro03_enrichment_batches batch WHERE batch.id=item.batch_id AND batch.idempotency_key=$1`,
      [`csv-source:${claim.execution.id}:${index+1}`,item.state,item.terminal_code,item.claim_token,
        item.lease_expires_at,item.current_provider,item.execution_fence,item.attempt_count,
        item.next_attempt_at,item.completed_at]);
    }
    if((index+1)%128===0)console.log(JSON.stringify({event:"retained_fixture_seed",rows:index+1}));
  }
  await completeImportExecution({executionId:claim.execution.id,claimToken:claim.claimToken!,expectedRows:rows.length});
  await pool.query(`UPDATE cro03_enrichment_items item SET next_attempt_at=clock_timestamp()-interval '1 hour'
    FROM cro03_enrichment_batches batch WHERE batch.id=item.batch_id AND batch.idempotency_key LIKE $1
      AND NOT EXISTS (SELECT 1 FROM import_executions execution WHERE execution.id=$2::uuid
        AND execution.metadata->>'certificationKind' IN ('retained_original','retained_original_identity'))`,
  [`csv-source:${claim.execution.id}:%`,claim.execution.id]);
  return claim.execution.id;
}
export function syntheticRows(count=2):RetainedRow[] {
  const label=randomUUID().replaceAll("-","");
  return Array.from({length:count},(_,index)=>{
    const rawRow={name:`Recovery fixture ${label} ${index}`,place_id:`fixture_${label}_${index}`,
      city:"Miami",state:"FL",email_1:`a.${index}.${label}@example.test`,
      email_2:`b.${index}.${label}@example.test`,additional_emails:`c.${index}.${label}@example.test`};
    return {sourceRowNumber:index+1,rawRow,sourceFormat:"google_maps_outscraper",
      rowFingerprint:createHash("sha256").update(JSON.stringify(rawRow)).digest("hex"),
      disposition:"deferred",reasonCode:"cro03_staging_review_required"};
  });
}
/** Execute the actual private dispatch prefix against the real app database.
 * Only the budget gate's final stop is injected; no provider is reserved/sent. */
export function dispatchStoppedAfterBudget() {
  const text=readFileSync("server/services/cro03/sfp-provider-operations.ts","utf8");
  const ast=ts.createSourceFile("fixture.ts",text,ts.ScriptTarget.Latest,true);
  const names=["rowMatchesSfpRuntimeRelease","lockSelectedSfpRuntimeRelease","renewSfpRuntimeOwnerLease",
    "renewSfpRuntimeJobLease","markSfpProviderOperationDispatchBoundary"];
  const declarations=ast.statements.filter(ts.isFunctionDeclaration)
    .filter(node=>node.name && names.includes(node.name.text));
  assert.equal(declarations.length,names.length);
  const compiled=ts.transpileModule(declarations.map(node=>node.getText(ast)).join("\n"),
    {compilerOptions:{module:ts.ModuleKind.None,target:ts.ScriptTarget.ES2022}}).outputText;
  return new Function("db","sql","rows","lockCurrentSfpRuntimeOwner","getCurrentRoutineSfpRuntimeFence",
    "sameSfpRuntimeRelease","SFP_RUNTIME_OWNER_LEASE_MS","acquireLadderBudgetLock",
    compiled+"\nreturn markSfpProviderOperationDispatchBoundary;"
  )(db,sql,(value:any)=>value.rows ?? value,lockCurrentSfpRuntimeOwner,getCurrentSfpRuntimeFence,
    sameSfpRuntimeRelease,SFP_RUNTIME_OWNER_LEASE_MS,async(tx:any)=>{
      await acquireLadderBudgetLock(tx);throw new Error("FIXTURE_STOP_BEFORE_PROVIDER");
    });
}
