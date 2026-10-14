import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {applyCertificationProviderDenyBoundary,getBlockedCertificationNetworkAttemptCount} from "../certification-provider-deny";
await assertDisposableTestInfrastructure({operation:"full five-workbook canonical intake"});
process.env.VG_PROVIDER_DENY_MODE="1";
applyCertificationProviderDenyBoundary({fatal:true});
const {pool}=await import("../../server/db");
const {readTabularImportWithCoordinates}=await import("../../server/services/tabular-import-reader");
const {claimCsvExecution,heartbeatImportExecution,completeImportExecution}=await import("../../server/services/import-execution");
const {materializeCanonicalProviderImportRow}=await import("../../server/services/canonical-provider-import");
const fixtures=[
  ["Outscraper-20261002160911s8d6b_1791037870877.xlsx","5079ea20012d1ca5e8c0eae9c0aa8460a6ce4c91eb10784587f36026675cf833",537],
  ["Outscraper-20261002160955s00ed_1791037870876.xlsx","506fe8119590a0ab821167e50f15584aea29da441a2f393ff64f9b32837940a4",578],
  ["Outscraper-20261002161052s68e5_1791037870877.xlsx","4c02771046abc941d7475aa40a4cfc56dc95e2dbf5ff6bb3f43013577852a581",513],
  ["Outscraper-20261002161147s2b94_1791037870876.xlsx","bec23f5270048a3e1cbba641b6727e9d813b14106abe456a881ed9eb7a039230",653],
  ["Outscraper-20261002161239s8aab_1791037870874.xlsx","c3fd1dd8da6eb4bf504c91b3342d59ebd5fb5b12d46c767c178b5b4c5bd4baca",633],
] as const;
let total=0,fulfilled=0,held=0;
try {
  for (const [filename,expectedHash,expectedRows] of fixtures) {
    const data=fs.readFileSync(path.join("attached_assets",filename));
    assert.equal(createHash("sha256").update(data).digest("hex"),expectedHash);
    const parsed=await readTabularImportWithCoordinates(data,filename);
    assert.equal(parsed.rows.length,expectedRows);
    assert(parsed.rows.every(row=>Object.keys(row).length===93));
    const claim=await claimCsvExecution({fileHash:expectedHash,totalRows:parsed.rows.length,
      actorType:"import",actorId:"system:canonical-workbook-certificate",sourcePayload:parsed.rows,
      metadata:{fileName:filename,sourceFormat:"google_maps_outscraper",sourceCoordinates:parsed.coordinates}});
    assert(claim.claimed && claim.claimToken);
    for (const [index,rawRow] of parsed.rows.entries()) {
      if (index%25===0) assert(await heartbeatImportExecution(claim.execution.id,claim.claimToken!));
      const outcome=await materializeCanonicalProviderImportRow({
        executionId:claim.execution.id,claimToken:claim.claimToken!,sourceRowNumber:index+1,
        sourceFormat:"google_maps_outscraper",actorId:"system:canonical-workbook-certificate",
        rawRow,sourceCoordinate:parsed.coordinates[index],fileName:filename,
      });
      if (outcome.fulfillmentState==="completed") {
        fulfilled++;
        const mismatched=(await pool.query(`SELECT count(*)::int n FROM contacts
          WHERE id=ANY($1::int[]) AND business_id IS DISTINCT FROM $2`,
          [outcome.contactIds,outcome.businessId])).rows[0].n;
        assert.equal(mismatched,0,"Ordinary completion requires every mailbox's actual native business link");
      } else {
        assert.equal(outcome.fulfillmentState,"held");held++;
        const evidence=(await pool.query(`SELECT count(*)::int n FROM audit_logs receipt
          JOIN cro03_enrichment_items item ON item.id::text=receipt.entity_key
          JOIN cro03_enrichment_batches batch ON batch.id=item.batch_id
          WHERE batch.idempotency_key=$1 AND receipt.action='canonical_import_hold_evidence'
            AND item.state='blocked' AND item.terminal_code LIKE 'CANONICAL_IMPORT_%'`,
          [`csv-source:${claim.execution.id}:${index+1}`])).rows[0].n;
        assert(evidence>0,"Each ordinary held row has current native evidence, not only historical accounting");
      }
    }
    const completion=await completeImportExecution({executionId:claim.execution.id,
      claimToken:claim.claimToken!,expectedRows:expectedRows});
    assert(completion.completed && completion.total===expectedRows);
    const retained=(await pool.query(`SELECT count(*)::int n FROM cro03_enrichment_batches batch
      JOIN cro03_batch_memberships member ON member.batch_id=batch.id
      JOIN cro03_source_observations observation ON observation.id=member.source_observation_id
      WHERE batch.idempotency_key LIKE $1 AND observation.payload->'rawSourceRow' IS NOT NULL`,
      [`csv-source-raw-v2:${claim.execution.id}:%`])).rows[0];
    assert.equal(retained.n,expectedRows);
    const replay=await claimCsvExecution({fileHash:expectedHash,totalRows:expectedRows,
      actorType:"import",actorId:"system:canonical-workbook-certificate",sourcePayload:parsed.rows});
    assert(replay.replay && !replay.claimed);
    total+=expectedRows;
    console.log(`PASS: workbook ${total}/${2914}; committed immutable row accounting and retained 93-column originals`);
  }
  assert.equal(total,2914);
  assert.equal(fulfilled+held,total);
  for (const table of ["provider_operations","provider_observations","communication_events","sequence_enrollments","sfp_cohort_runs"]) {
    assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
  }
  assert.equal(getBlockedCertificationNetworkAttemptCount(),0);
  console.log(`PASS: all five actual workbooks through canonical native intake; 2914 rows; ${fulfilled} fulfilled and ${held} native evidenced holds; no external effects`);
} finally {await pool.end();}