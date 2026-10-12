import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {pool} from "../../server/db";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {hashCro03Evidence} from "../../server/services/cro03/source-staging";
import type {RetainedRow} from "./retained-recovery-fixtures";

const tables = [
  "import_executions", "prospect_lists", "sunbiz_entities", "businesses", "contacts",
  "business_locations", "canonical_source_links", "cro03_source_subjects",
  "cro03_enrichment_batches", "cro03_source_observations", "cro03_batch_memberships",
  "cro03_enrichment_items", "contact_source_events", "import_row_dispositions",
  "contact_business_system_link_evidence", "contact_business_link_decisions", "audit_logs",
] as const;
type Table = typeof tables[number];
type Manifest = {
  version: "retained_native_topology_v1";
  executionId: string;
  captureConsistency: "revision_verified";
  timezone: string;
  files: Array<{table: Table; file: string; rows: number; sha256: string}>;
  tableHashes: Record<Table, {rows: number; hash: string}>;
  sourceColumns: Record<Table,string[]>;
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function retainedNativeExecutionId(): string {
  const manifest: Manifest = JSON.parse(readFileSync(
    join(process.env.RETAINED_INPUT_DIR!, "native", "manifest.json"), "utf8"));
  assert.match(manifest.executionId, /^[0-9a-f-]{36}$/);
  return manifest.executionId;
}

/** Read-only postcondition: includes every original projected relationship,
 * not just relationships mentioned in newly fulfilled row receipts. */
export async function verifyRetainedBusinessRelationships(client:any) {
  const directory=join(process.env.RETAINED_INPUT_DIR!,"native");
  const manifest:Manifest=JSON.parse(readFileSync(join(directory,"manifest.json"),"utf8"));
  const original=(table:Table)=>manifest.files.filter(file=>file.table===table).flatMap(file=>{
    assert.match(file.file,/^[a-z][a-z0-9_]*-\d{4}\.json$/);
    const bytes=readFileSync(join(directory,file.file));
    assert.equal(sha256(bytes),file.sha256,"RETAINED_NATIVE_FILE_DRIFT");
    return JSON.parse(bytes.toString("utf8")) as any[];
  });
  const projections=original("contacts").filter(contact=>contact.business_id!=null)
    .map(contact=>({id:contact.id,business_id:contact.business_id}));
  const verified=(await client.query(`SELECT count(*)::int rows,
    count(*) FILTER(WHERE destination.business_id IS DISTINCT FROM source.business_id)::int changed
    FROM jsonb_to_recordset($1::jsonb) source(id integer,business_id integer)
    JOIN contacts destination ON destination.id=source.id`,[JSON.stringify(projections)])).rows[0];
  assert.equal(verified.rows,projections.length,"RETAINED_ORIGINAL_RELATIONSHIP_CONTACT_MISSING");
  assert.equal(verified.changed,0,"RETAINED_ORIGINAL_RELATIONSHIP_TRANSFERRED");
  for(const table of ["contact_business_link_decisions","contact_business_system_link_evidence"] as const){
    const ids=original(table).map(record=>String(record.id));
    const hash=(await client.query(`WITH captured AS (
      SELECT (SELECT jsonb_object_agg(key,value) FROM jsonb_each(to_jsonb(record))
        WHERE key IN(SELECT jsonb_array_elements_text($2::jsonb))) data
      FROM "${table}" record WHERE record.id::text IN(SELECT jsonb_array_elements_text($1::jsonb)))
      SELECT count(*)::int rows,encode(sha256(convert_to(string_agg(
        encode(sha256(convert_to(data::text,'UTF8')),'hex'),','
        ORDER BY data->>'id'),'UTF8')),'hex') hash FROM captured`,
      [JSON.stringify(ids),JSON.stringify(manifest.sourceColumns[table])])).rows[0];
    assert.deepEqual(hash,manifest.tableHashes[table],`RETAINED_ORIGINAL_RELATIONSHIP_HISTORY_DRIFT:${table}`);
  }
  return {preservedOriginalBusinessProjections:projections.length,
    preservedOriginalDecisions:manifest.tableHashes.contact_business_link_decisions.rows,
    preservedOriginalEvidence:manifest.tableHashes.contact_business_system_link_evidence.rows};
}

/** Restore a verified private graph, not a normalized empty-CRM substitute.
 * All real INSERT guards and FK constraints remain enabled. No production
 * runtime owner, provider control, credentials or transport is restored.
 */
export async function seedNativeRetainedTopology(rows: RetainedRow[],certificationEnvironment: NodeJS.ProcessEnv) {
  // The child switches NODE_ENV only after its pre-import sandbox assertion to
  // exercise the real published-owner fences. Recheck the original environment
  // and unchanged pool target, never invent a test environment at this boundary.
  assert.equal(process.env.DATABASE_URL,certificationEnvironment.DATABASE_URL);
  assert.equal(process.env.TEST_DATABASE_URL,certificationEnvironment.TEST_DATABASE_URL);
  await assertDisposableTestInfrastructure({operation: "retained-native-topology",
    env:certificationEnvironment,requireRedis:false});
  assert.equal(process.env.VG_PROVIDER_DENY_MODE, "1");
  const directory = join(process.env.RETAINED_INPUT_DIR!, "native");
  const manifest: Manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "retained_native_topology_v1");
  assert.equal(manifest.captureConsistency, "revision_verified",
    "A partial or mixed unverified capture is not native topology proof");
  assert.equal(manifest.timezone, "UTC");
  const graph = new Map<Table, any[]>(tables.map(table => [table, []]));
  for (const file of manifest.files) {
    assert(graph.has(file.table), "RETAINED_NATIVE_TABLE_NOT_ALLOWED");
    assert.match(file.file, /^[a-z][a-z0-9_]*-\d{4}\.json$/);
    assert(file.file.startsWith(`${file.table}-`),"RETAINED_NATIVE_FILE_TABLE_MISMATCH");
    const bytes = readFileSync(join(directory, file.file));
    assert.equal(sha256(bytes), file.sha256, "RETAINED_NATIVE_FILE_DRIFT");
    const records = JSON.parse(bytes.toString("utf8"));
    assert.equal(records.length, file.rows);
    graph.get(file.table)!.push(...records);
  }
  for (const table of tables) {
    const records = graph.get(table)!;
    assert.equal(records.length, manifest.tableHashes[table]?.rows);
    assert.equal(new Set(records.map(record => String(record.id))).size, records.length,
      `RETAINED_NATIVE_DUPLICATE_ID:${table}`);
  }
  const execution = graph.get("import_executions")!;
  assert.equal(execution.length, 1);
  assert.equal(execution[0].id, manifest.executionId);
  assert.equal(execution[0].total_rows, rows.length);
  execution[0].source_payload = rows.map(row => row.rawRow);
  const observations = graph.get("cro03_source_observations")!;
  const byId = new Map(observations.map(observation => [observation.id, observation]));
  for (const row of rows) {
    const original = byId.get(row.originalObservation!.id);
    assert(original, "RETAINED_NATIVE_ORIGINAL_OBSERVATION_MISSING");
    assert.deepEqual(original.payload, row.originalObservation!.payload);
    assert.equal(original.payload_hash, row.originalObservation!.payloadHash);
  }
  for (const observation of observations) {
    if (observation.retainedRawReference != null) {
      const index = Number(observation.retainedRawReference) - 1;
      assert(Number.isSafeInteger(index) && index >= 0 && index < rows.length);
      assert.equal(observation.provenance.importExecutionId, manifest.executionId);
      assert.equal(Number(observation.payload.sourceRowNumber), index + 1);
      observation.payload = {...observation.payload, rawSourceRow: rows[index].rawRow};
      delete observation.retainedRawReference;
    }
    assert.equal(hashCro03Evidence(observation.payload), observation.payload_hash,
      "RETAINED_NATIVE_OBSERVATION_PAYLOAD_DRIFT");
  }
  const client = await pool.connect();
  let restorePhase="begin";
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    for (const table of tables) {
      restorePhase=`insert:${table}`;
      const attributes = (await client.query(`SELECT attname,attnotnull,
          pg_get_expr(def.adbin,def.adrelid) default_expression FROM pg_attribute attr
        LEFT JOIN pg_attrdef def ON def.adrelid=attr.attrelid AND def.adnum=attr.attnum
        WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped
          AND attgenerated='' ORDER BY attnum`, [`public.${table}`])).rows;
      const sourceColumns=manifest.sourceColumns[table];
      assert(sourceColumns?.length,"RETAINED_NATIVE_SOURCE_SCHEMA_REQUIRED");
      const columns=attributes.filter(column=>sourceColumns.includes(column.attname)).map(column=>column.attname);
      // A source-absent additive column uses its actual migration default, not
      // an invented NULL or a fabricated source value. Explicit source NULLs
      // remain explicit, and every original field is checked after restoration.
      for(const column of attributes.filter(column=>!sourceColumns.includes(column.attname)))
        assert(!column.attnotnull || column.default_expression,
          `RETAINED_NATIVE_UNSUPPORTED_ADDITIVE_COLUMN:${table}:${column.attname}`);
      assert(columns.length);
      const quoted = columns.map(name => `"${String(name).replaceAll('"', '""')}"`).join(",");
      // The retained-source FK is immediately restrictive, not deferrable.
      // Restore the same A→B→C ordering used by the canonical contact writer:
      // insert contact with no primary/relationship projection, insert its exact
      // source events and decisions, then set the original pointers. Final parity checks every source
      // value; no constraint, trigger or historical field is weakened.
      const selected = columns.map(name=>table==="contacts"&&name==="primary_source_event_id"
        ? 'NULL::integer AS "primary_source_event_id"'
        : table==="contacts"&&name==="business_id" ? 'NULL::integer AS "business_id"'
        : `"${String(name).replaceAll('"', '""')}"`).join(",");
      const records = graph.get(table)!;
      assert(records.every(record=>sourceColumns.every(column=>Object.hasOwn(record,column))),
        `RETAINED_NATIVE_SOURCE_COLUMN_MISSING:${table}`);
      for (let offset = 0; offset < records.length; offset += 128) {
        await client.query(`INSERT INTO "${table}" (${quoted})
          SELECT ${selected} FROM jsonb_populate_recordset(NULL::"${table}",$1::jsonb)`,
        [JSON.stringify(records.slice(offset, offset + 128))]);
      }
      const sequence = (await client.query("SELECT pg_get_serial_sequence($1,'id') name", [table])).rows[0].name;
      if (sequence) {
        await client.query(`SELECT setval($1::regclass,
          greatest(coalesce((SELECT max(id) FROM "${table}"),1),
          pg_sequence_last_value($1::regclass)),true)`, [sequence]);
      }
    }
    const originalContacts=graph.get("contacts")!;
    restorePhase="restore:contact-pointers";
    for(let offset=0;offset<originalContacts.length;offset+=128){
      await client.query(`UPDATE contacts destination SET primary_source_event_id=original.primary_source_event_id,
          business_id=original.business_id
        FROM jsonb_populate_recordset(NULL::contacts,$1::jsonb) original
        WHERE destination.id=original.id`,
      [JSON.stringify(originalContacts.slice(offset,offset+128))]);
    }
    // Item INSERTs legitimately run the real native accounting projection.
    // Restore the capture's exact mutable projection after every original item
    // exists; do not normalize historical counters to newly computed values.
    // Native CHECKs and triggers remain enabled for these updates too.
    restorePhase="restore:batch-projections";
    const originalBatches=graph.get("cro03_enrichment_batches")!;
    for(let offset=0;offset<originalBatches.length;offset+=128){
      await client.query(`UPDATE cro03_enrichment_batches destination SET
          blocked_count=original.blocked_count,completed_count=original.completed_count,
          outstanding_count=original.outstanding_count,completed_at=original.completed_at,
          updated_at=original.updated_at
        FROM jsonb_populate_recordset(NULL::cro03_enrichment_batches,$1::jsonb) original
        WHERE destination.id=original.id`,
      [JSON.stringify(originalBatches.slice(offset,offset+128))]);
    }
    // Prove the restored graph equals the source-side revision inventory before
    // any certification worker is allowed to run. Timestamp precision and every
    // historical receipt are included. The compact raw reference is merely a
    // lossless export encoding, not a new observation or a substitute fixture.
    for (const table of tables) {
      restorePhase=`verify:${table}`;
      const ids = graph.get(table)!.map(record => String(record.id));
      let expression = `(SELECT jsonb_object_agg(key,value) FROM jsonb_each(to_jsonb(record))
        WHERE key IN(SELECT jsonb_array_elements_text($2::jsonb)))`;
      if (table === "import_executions") expression += "-'source_payload'";
      if (table === "cro03_source_observations") expression = `CASE
        WHEN record.payload ? 'rawSourceRow' THEN
           jsonb_set(${expression},'{payload}',record.payload-'rawSourceRow')
          ||jsonb_build_object('retainedRawReference',record.payload->>'sourceRowNumber')
        ELSE ${expression} END`;
      const verified = (await client.query(`WITH captured AS (
        SELECT ${expression} data FROM "${table}" record
        WHERE record.id::text IN(SELECT jsonb_array_elements_text($1::jsonb)))
        SELECT count(*)::int rows,encode(sha256(convert_to(string_agg(
          encode(sha256(convert_to(data::text,'UTF8')),'hex'),','
          ORDER BY data->>'id'),'UTF8')),'hex') hash FROM captured`,
      [JSON.stringify(ids),JSON.stringify(manifest.sourceColumns[table])])).rows[0];
      if(verified.rows!==manifest.tableHashes[table].rows||verified.hash!==manifest.tableHashes[table].hash){
        // Diagnose representation/schema drift without logging original values.
        const differences=(await client.query(`WITH originals AS (
          SELECT value original FROM jsonb_array_elements($1::jsonb)),
        compared AS (SELECT originals.original,to_jsonb(destination) actual FROM originals
          JOIN "${table}" destination ON destination.id::text=originals.original->>'id')
        SELECT field.key,count(*)::int rows FROM compared
          CROSS JOIN LATERAL jsonb_each(compared.original) field
        WHERE field.key IN(SELECT jsonb_array_elements_text($2::jsonb))
          AND field.value IS DISTINCT FROM compared.actual->field.key
        GROUP BY field.key ORDER BY field.key`,
        [JSON.stringify(graph.get(table)),JSON.stringify(manifest.sourceColumns[table])])).rows;
        console.error(JSON.stringify({event:"retained_native_field_drift",table,
          expectedRows:manifest.tableHashes[table].rows,actualRows:verified.rows,differences}));
      }
      assert.deepEqual(verified, manifest.tableHashes[table],
        `RETAINED_NATIVE_REVISION_DRIFT:${table}`);
    }
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
  } catch (error) {
    const fields=error as {code?:string;table?:string;column?:string;constraint?:string};
    console.error(JSON.stringify({event:"retained_native_restore_refused",
      phase:restorePhase,sqlState:fields.code,table:fields.table,column:fields.column,constraint:fields.constraint}));
    try { await client.query("ROLLBACK"); }
    catch(cleanupError) {
      Object.defineProperty(error,"cleanupError",{value:cleanupError,configurable:true});
    }
    throw error;
  } finally {
    client.release();
  }
  return manifest.executionId;
}
