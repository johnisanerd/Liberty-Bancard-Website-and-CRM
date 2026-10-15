import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { readTabularImportWithCoordinates } from "../../server/services/tabular-import-reader";

async function main() {
  await assertDisposableTestInfrastructure({ operation: "provider-import-recovery-certification" });
  let forbiddenNetworkAttempts = 0;
  const deny = () => { forbiddenNetworkAttempts++; throw new Error("CERTIFICATION_EXTERNAL_NETWORK_DENIED"); };
  globalThis.fetch = deny as typeof fetch;
  http.request = deny as typeof http.request; http.get = deny as typeof http.get;
  https.request = deny as typeof https.request; https.get = deny as typeof https.get;
  syncBuiltinESMExports();
  const { pool } = await import("../../server/db");
  const { storage } = await import("../../server/storage");
  const { claimCsvExecution, getImportLedgerSummary } = await import("../../server/services/import-execution");
  const { processPersistedCsvImport } = await import("../../server/services/csv-import-processor");
  const { retainProviderImportRow } = await import("../../server/services/provider-import-evidence");
  const { createCro03SourceBatch } = await import("../../server/services/cro03/source-staging");
  const { providerCsvSourceSubject } = await import("../../server/services/cro03a/adapters");
  const { mapProviderCsvRow } = await import("../../server/services/provider-import-columns");
  const { providerImportEmails } = await import("../../server/services/canonical-provider-import");
  const { computeFileHash } = await import("../../server/services/import-normalizer");
  const fixtureDirectory = process.argv[2] ?? "/tmp/canonical-enrichment-workbooks";
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDirectory, "manifest.json"), "utf8"));
  const safetyTables = ["contacts", "businesses", "provider_operations", "provider_observations",
    "sequence_enrollments", "communication_events", "sfp_campaign_staging_intents"];
  const safetyCounts = async () => Object.fromEntries(await Promise.all(safetyTables.map(async table =>
    [table, Number((await pool.query(`SELECT count(*) n FROM "${table}"`)).rows[0].n)])));
  try {
    const before = await safetyCounts();
    let checkedRows = 0;
    for (const [index, fixture] of manifest.files.entries()) {
      const bytes = fs.readFileSync(path.join("attached_assets", fixture.name));
      const { rows: records, coordinates } = await readTabularImportWithCoordinates(bytes, fixture.name);
      assert.deepEqual(records, JSON.parse(fs.readFileSync(fixture.json, "utf8")));
      const executionClaim = await claimCsvExecution({
        fileHash: computeFileHash(bytes), totalRows: records.length,
        actorType: "user", actorId: "certification",
        metadata: { sourceFormat: "google_maps_outscraper", fileName: fixture.name, sourceCoordinates: coordinates },
        sourcePayload: records,
      });
      assert(executionClaim.claimed);
      const importRecord = await storage.createCsvImport({
        executionId: executionClaim.execution.id, fileName: fixture.name,
        sourceFormat: "google_maps_outscraper", importSource: "google_maps_outscraper",
        totalRows: records.length, status: "processing", importedBy: "certification",
      });
      if (index === 0) {
        // An old upload may have staged mapped evidence before crashing. Keep
        // its exact immutable payload even if today's projection has more fields.
        const row = records[0];
        const draft = providerCsvSourceSubject({
          importExecutionId: executionClaim.execution.id, sourceRowNumber: 1,
          sourceSystem: "outscraper", row: mapProviderCsvRow(row, "google_maps_outscraper"),
        });
        await createCro03SourceBatch({
          idempotencyKey: `csv-source:${executionClaim.execution.id}:1`,
          actorType: "import", actorId: "certification", purpose: "staging_review",
          subjects: [{ ...draft, payload: { ...draft.payload, legacyMarker: true,
            sourceRowNumber: 1, rowFingerprint: computeFileHash(Buffer.from(JSON.stringify(row))),
            sourceFormat: "google_maps_outscraper" } }],
        });
      }
      await processPersistedCsvImport({
        records, executionClaim, importRecord, sourceFormat: "google_maps_outscraper",
        actor: { actorType: "system", actorId: "startup-resumer" }, filename: fixture.name,
      });
      const ledger = await getImportLedgerSummary(executionClaim.execution.id);
      console.log(JSON.stringify({event:"provider_recovery_ledger",fileIndex:index,
        expectedRows:fixture.rows,counts:ledger.counts}));
      if(ledger.counts.failed>0) {
        const reasons=(await pool.query(`SELECT reason_code,count(*)::int rows,
          diagnostic->>'error' error FROM import_row_dispositions
          WHERE execution_id=$1 AND disposition='failed'
          GROUP BY reason_code,diagnostic->>'error'`,[executionClaim.execution.id])).rows;
        // Report stable error classes only; diagnostics can contain customer
        // text and must not be copied into certification output.
        console.log(JSON.stringify({event:"provider_recovery_failure_classes",
          reasons:reasons.map(row=>({reasonCode:row.reason_code,rows:row.rows,
            errorClass:String(row.error).match(/^[A-Z][A-Z0-9_]+/)?.[0] ?? "opaque"}))}));
      }
      // The persisted processor now runs canonical native intake, rather than
      // blanket source staging. Certify real row outcomes and source identity;
      // calling every committed native creation "deferred" is not truthful.
      assert.equal(Object.values(ledger.counts).reduce((sum,n)=>sum+Number(n),0),fixture.rows);
      assert.equal(ledger.counts.failed, 0);
      const receipts=(await pool.query(`SELECT source_row_number,row_fingerprint,disposition
        FROM import_row_dispositions WHERE execution_id=$1 ORDER BY source_row_number`,
      [executionClaim.execution.id])).rows;
      assert.equal(receipts.length,records.length);
      const provenance=(await pool.query(`SELECT ev.source_row_number,ev.row_fingerprint,
        lower(trim(c.email)) email FROM contact_source_events ev
        JOIN contacts c ON c.id=ev.contact_id WHERE ev.import_execution_id=$1`,
      [executionClaim.execution.id])).rows;
      for(const [i,receipt] of receipts.entries()){
        assert.equal(receipt.source_row_number,i+1);
        assert.equal(receipt.row_fingerprint,computeFileHash(Buffer.from(JSON.stringify(records[i]))));
        const events=provenance.filter(event=>event.source_row_number===i+1);
        assert(events.every(event=>event.row_fingerprint===receipt.row_fingerprint));
        if(["created","updated","matched_noop"].includes(receipt.disposition))
          assert.deepEqual([...new Set(events.map(event=>event.email))].sort(),providerImportEmails(records[i]));
        if(!providerImportEmails(records[i]).length)assert.equal(events.length,0);
      }
      const stored = (await pool.query(`
        SELECT (o.payload->>'sourceRowNumber')::int row_number,o.payload->'rawSourceRow' raw,
               o.payload->'sourceCoordinate' coordinate,o.payload->>'fileName' filename
          FROM cro03_enrichment_batches b JOIN cro03_batch_memberships m ON m.batch_id=b.id
          JOIN cro03_source_observations o ON o.id=m.source_observation_id
         WHERE b.idempotency_key LIKE $1 ORDER BY row_number`,
        [`csv-source-raw-v2:${executionClaim.execution.id}:%`])).rows;
      assert.equal(stored.length, fixture.rows);
      stored.forEach((row, i) => {
        assert.deepEqual(row.raw, records[i]);
        assert.deepEqual(row.coordinate, coordinates[i]);
        assert.equal(row.filename, fixture.name);
      });
      const replay = await claimCsvExecution({
        fileHash: computeFileHash(bytes), totalRows: records.length,
        actorType: "user", actorId: "certification", sourcePayload: records,
      });
      assert.equal(replay.claimed, false);
      const beforeRetentionReplay=await safetyCounts();
      await retainProviderImportRow({
        executionId: executionClaim.execution.id, sourceRowNumber: 1,
        sourceFormat: "google_maps_outscraper", actorId: "startup-resumer", rawRow: records[0],
        sourceCoordinate: coordinates[0], fileName: fixture.name,
      });
      await assert.rejects(retainProviderImportRow({
        executionId: executionClaim.execution.id, sourceRowNumber: 1,
        sourceFormat: "google_maps_outscraper", actorId: "startup-resumer",
        rawRow: { ...records[0], email: "different@example.invalid" },
        sourceCoordinate: coordinates[0], fileName: fixture.name,
      }), /ORIGINAL_EVIDENCE_MISMATCH/);
      assert.deepEqual(await safetyCounts(),beforeRetentionReplay);
      checkedRows += records.length;
    }
    assert.equal(checkedRows, 2914);
    assert.equal(forbiddenNetworkAttempts, 0);
    const after=await safetyCounts();
    for(const table of safetyTables.filter(table=>!["contacts","businesses"].includes(table)))
      assert.equal(after[table],before[table],`No provider, staging purchase, enrollment or message in ${table}`);
    // A shared mailbox is a delivery address, not proof of one identity. Certify
    // the actual contact identity contract: every same-mailbox pair must be
    // distinguishable under the writer's own predicate, and one source row must
    // never have created two contacts for the same mailbox.
    const { sameMailboxContactIdentity } = await import("../../server/services/contact-mailbox-identity");
    const mailboxContacts = (await pool.query(`SELECT c.id,lower(trim(c.email)) mailbox,c.first_name "firstName",
        c.last_name "lastName",c.company_name "companyName",c.phone,c.address,c.city,c.state,
        c.ghl_contact_id "ghlContactId"
      FROM contacts c WHERE c.email IS NOT NULL AND c.archived_at IS NULL AND lower(trim(c.email)) IN
        (SELECT lower(trim(email)) FROM contacts WHERE email IS NOT NULL AND archived_at IS NULL
         GROUP BY 1 HAVING count(*)>1) ORDER BY c.id`)).rows;
    const mailboxGroups = new Map<string, any[]>();
    for (const row of mailboxContacts) mailboxGroups.set(row.mailbox, [...(mailboxGroups.get(row.mailbox) ?? []), row]);
    const collapsiblePairs: Array<[number, number]> = [];
    const distinguishedBy = new Map<string, number>();
    for (const group of mailboxGroups.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      if (sameMailboxContactIdentity(group[i], group[j])) collapsiblePairs.push([group[i].id, group[j].id]);
      else {
        const text = (v: unknown) => String(v ?? "").trim().toLowerCase();
        const fields = ["companyName", "address", "city", "state", "phone", "firstName", "lastName"]
          .filter(key => text(group[i][key]) && text(group[j][key]) && text(group[i][key]) !== text(group[j][key]));
        const key = fields.join("+") || "no_conflicting_field";
        distinguishedBy.set(key, (distinguishedBy.get(key) ?? 0) + 1);
      }
    }
    // Aggregate classes only: diagnostics must not copy customer text.
    console.log(JSON.stringify({ event: "provider_recovery_shared_mailbox_classes", groups: mailboxGroups.size,
      contacts: mailboxContacts.length, collapsiblePairs: collapsiblePairs.length,
      distinguishedBy: Object.fromEntries(distinguishedBy) }));
    assert.deepEqual(collapsiblePairs, [], "No same-mailbox pair may represent one supported identity");
    assert.equal((await pool.query(`SELECT count(*)::int n FROM (
        SELECT ev.import_execution_id,ev.source_row_number,lower(trim(c.email)) mailbox
        FROM contact_source_events ev JOIN contacts c ON c.id=ev.contact_id
        WHERE ev.import_execution_id IS NOT NULL AND ev.source_row_number IS NOT NULL AND c.email IS NOT NULL
        GROUP BY 1,2,3 HAVING count(DISTINCT c.id)>1) repeated`)).rows[0].n, 0,
      "One source row must not create multiple contacts for one mailbox");
    const legacy = (await pool.query(`SELECT count(*)::int n FROM cro03_source_observations
      WHERE payload->>'legacyMarker'='true'`)).rows[0];
    assert.equal(legacy.n, 1);
    const { readCanonicalEnrichmentStatus } = await import("../../server/services/canonical-enrichment-status");
    const status = await readCanonicalEnrichmentStatus();
    assert.equal(status.contacts.total, Number(after.contacts));
    assert.equal(status.businesses.total, Number(after.businesses));
    assert.equal(status.imports.byState.completed, 5);
    assert.equal(status.providers.total, Number(before.provider_operations));
    assert.equal(status.scope, "production_records_with_historical_work");
    const result = { observedAt: new Date().toISOString(), rows: checkedRows, files: manifest.files.length,
      actualRecovery: "PASS", exactRawCells: "PASS", originalEvidencePreserved: "PASS",
      originalWorksheetRowCoordinates: "PASS",
      replay: "PASS", changedRowRejected: "PASS", truthfulNativeOutcomeLedger: "PASS",
      nativeMailboxesAndFingerprintProvenance: "PASS", businessOnlyCreatesNoContact: "PASS",
      providerPreparationEnrollmentCountsUnchanged: true, forbiddenNetworkAttempts,
      productionExecution: false, fullTaskCertification: false };
    fs.writeFileSync("/tmp/retained-provider-import-recovery-report.json", JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } finally { await pool.end(); }
}
main().catch(error => {
  console.error("Provider import certification failed:", String(error.message).split("\n")[0]);
  console.error(error.stack?.split("\n").filter((line: string) => line.trim().startsWith("at ")).join("\n"));
  process.exitCode = 1;
});