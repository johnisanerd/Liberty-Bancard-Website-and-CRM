import { pool } from "../db";
import type {
  UploadLedgerMailbox, UploadLedgerPage, UploadLedgerRow, UploadLedgerRun, UploadLedgerSummary, UploadReceiptStatus,
} from "@shared/canonical-upload-ledger";
import { CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION } from "./canonical-import-recovery-contract";
import { providerImportEmails } from "./canonical-provider-import";

export const UPLOAD_LEDGER_MAX_LIMIT = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIPT_ACTION = "canonical_import_row_fulfilled";

export class UploadLedgerInputError extends Error {}
function executionId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new UploadLedgerInputError("INVALID_EXECUTION_ID");
  return value.toLowerCase();
}

/** Recent uploads that have original-row accounting. Observational only. */
export async function listUploadLedgerRuns(): Promise<UploadLedgerRun[]> {
  const result = await pool.query(`
    SELECT e.id,e.import_type,e.status,e.started_at::text started_at,e.total_rows,
      coalesce(e.metadata->>'fileName',e.metadata->>'filename',e.metadata->>'originalFileName') file_name,
      accounted.n accounted_rows
    FROM import_executions e
    JOIN LATERAL (SELECT count(*)::int n FROM import_row_dispositions a WHERE a.execution_id=e.id) accounted ON accounted.n>0
    ORDER BY e.started_at DESC NULLS LAST,e.id LIMIT 50`);
  return result.rows.map(row => ({
    executionId: String(row.id), importType: String(row.import_type), fileName: row.file_name ?? null,
    status: String(row.status), startedAt: row.started_at ?? null,
    totalRows: row.total_rows == null ? null : Number(row.total_rows), accountedRows: Number(row.accounted_rows),
  }));
}

/** Whole-upload aggregates, each from an execution-scoped indexed read. */
export async function readUploadLedgerSummary(rawExecutionId: unknown): Promise<UploadLedgerSummary> {
  const id = executionId(rawExecutionId);
  const version = CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION;
  const [dispositions, contacts, receipts] = await Promise.all([
    pool.query(`SELECT disposition,count(*)::int n FROM import_row_dispositions WHERE execution_id=$1::uuid GROUP BY 1`, [id]),
    pool.query(`SELECT count(DISTINCT c.id)::int contacts,
        count(DISTINCT c.id) FILTER (WHERE d.id IS NOT NULL)::int verified
      FROM contact_source_events e JOIN contacts c ON c.id=e.contact_id
      LEFT JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.superseded_at IS NULL
        AND d.decision='verified' AND d.business_id=c.business_id
      WHERE e.import_execution_id=$1::uuid`, [id]),
    pool.query(`SELECT
        count(*) FILTER (WHERE r.current)::int current,
        count(*) FILTER (WHERE NOT r.current AND r.stale)::int stale,
        count(*) FILTER (WHERE NOT r.current AND NOT r.stale AND r.any_receipt)::int inconsistent
      FROM (
        SELECT
          bool_or(i.state='completed' AND i.terminal_code='CANONICAL_LOCAL_IMPORT_FULFILLED'
            AND l.matches AND l.details->>'qualificationVersion'=$2) current,
          bool_or(l.matches AND l.details->>'qualificationVersion' IS DISTINCT FROM $2) stale,
          bool_or(l.entity_key IS NOT NULL) any_receipt
        FROM import_row_dispositions a
        JOIN cro03_enrichment_batches b ON b.idempotency_key='csv-source:'||a.execution_id::text||':'||a.source_row_number::text
        JOIN cro03_enrichment_items i ON i.batch_id=b.id
        LEFT JOIN LATERAL (
          SELECT l.entity_key,l.details,
            (l.details->>'executionId'=a.execution_id::text AND l.details->>'sourceRowNumber'=a.source_row_number::text
              AND l.details->>'rowFingerprint'=a.row_fingerprint) matches
          FROM audit_logs l WHERE l.entity_key=i.id::text AND l.action='${RECEIPT_ACTION}') l ON TRUE
        WHERE a.execution_id=$1::uuid
        GROUP BY a.source_row_number
      ) r`, [id, version]),
  ]);
  const rows = dispositions.rows.reduce((total, row) => total + Number(row.n), 0);
  return {
    executionId: id, rows,
    byDisposition: Object.fromEntries(dispositions.rows.map(row => [String(row.disposition), Number(row.n)])),
    distinctContacts: Number(contacts.rows[0]?.contacts ?? 0), verifiedLinks: Number(contacts.rows[0]?.verified ?? 0),
    receiptsCurrent: Number(receipts.rows[0]?.current ?? 0), receiptsStale: Number(receipts.rows[0]?.stale ?? 0),
    receiptsInconsistent: Number(receipts.rows[0]?.inconsistent ?? 0),
    qualificationVersion: version, observedAt: new Date().toISOString(),
  };
}

/** One stable keyset page. Evidence is loaded only for this page's coordinates. */
export async function readUploadLedgerPage(input: {
  executionId: unknown; after?: unknown; limit?: unknown; filter?: unknown;
}): Promise<UploadLedgerPage> {
  const id = executionId(input.executionId);
  const after = input.after == null || input.after === "" ? 0 : Number(input.after);
  if (!Number.isInteger(after) || after < 0 || after > 2_147_483_647) throw new UploadLedgerInputError("INVALID_CURSOR");
  const limit = input.limit == null || input.limit === "" ? 25 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > UPLOAD_LEDGER_MAX_LIMIT) throw new UploadLedgerInputError("INVALID_LIMIT");
  const filter = input.filter === "unfulfilled" ? "unfulfilled" : "all";
  if (input.filter != null && input.filter !== "" && input.filter !== "all" && input.filter !== "unfulfilled")
    throw new UploadLedgerInputError("INVALID_FILTER");
  const version = CANONICAL_IMPORT_FULFILLMENT_QUALIFICATION_VERSION;

  const page = await pool.query(`
    SELECT a.source_row_number,a.disposition,a.reason_code,a.row_fingerprint,a.completed_at::text completed_at,
      i.id item_id,i.state item_state,i.terminal_code,i.next_attempt_at::text next_attempt_at
    FROM import_row_dispositions a
    LEFT JOIN LATERAL (
      SELECT item.id,item.state,item.terminal_code,item.next_attempt_at
      FROM cro03_enrichment_batches batch JOIN cro03_enrichment_items item ON item.batch_id=batch.id
      WHERE batch.idempotency_key='csv-source:'||a.execution_id::text||':'||a.source_row_number::text
      ORDER BY item.id LIMIT 1) i ON TRUE
    WHERE a.execution_id=$1::uuid AND a.source_row_number>$2
      ${filter === "unfulfilled" ? "AND i.terminal_code IS DISTINCT FROM 'CANONICAL_LOCAL_IMPORT_FULFILLED'" : ""}
    ORDER BY a.source_row_number LIMIT $3`, [id, after, limit + 1]);
  const hasMore = page.rows.length > limit;
  const base = page.rows.slice(0, limit);
  const numbers = base.map(row => Number(row.source_row_number));
  const itemIds = base.map(row => row.item_id).filter(Boolean).map(String);
  const generatedAt = new Date().toISOString();
  if (!base.length) return { executionId: id, rows: [], nextAfter: null, limit, filter, observedAt: generatedAt };

  const rawKeys = numbers.flatMap(n => [`csv-source-raw-v3:${id}:${n}`, `csv-source-raw-v2:${id}:${n}`]);
  const [raws, events, receipts] = await Promise.all([
    pool.query(`SELECT batch.idempotency_key,observation.payload->'rawSourceRow' raw_row,
        observation.payload->>'rowFingerprint' row_fingerprint,observation.payload->'sourceCoordinate' source_coordinate
      FROM cro03_enrichment_batches batch
      JOIN cro03_batch_memberships member ON member.batch_id=batch.id
      JOIN cro03_source_observations observation ON observation.id=member.source_observation_id
      WHERE batch.idempotency_key=ANY($1::text[])`, [rawKeys]),
    pool.query(`SELECT e.source_row_number,e.row_fingerprint,c.id contact_id,lower(trim(c.email)) email,c.business_id,
        (d.id IS NOT NULL) verified
      FROM contact_source_events e JOIN contacts c ON c.id=e.contact_id
      LEFT JOIN contact_business_link_decisions d ON d.contact_id=c.id AND d.superseded_at IS NULL
        AND d.decision='verified' AND d.business_id=c.business_id
      WHERE e.import_execution_id=$1::uuid AND e.source_row_number=ANY($2::int[])
      ORDER BY e.source_row_number,c.id`, [id, numbers]),
    itemIds.length ? pool.query(`SELECT entity_key,details FROM audit_logs
      WHERE action='${RECEIPT_ACTION}' AND entity_key=ANY($1::text[])`, [itemIds])
      : Promise.resolve({ rows: [] as any[] }),
  ]);

  const rawByRow = new Map<number, { format: "raw-v3" | "raw-v2"; raw: Record<string, string>; fingerprint: string | null; coordinate: unknown }>();
  for (const row of raws.rows) {
    const key = String(row.idempotency_key);
    const format = key.startsWith("csv-source-raw-v3:") ? "raw-v3" : "raw-v2";
    const number = Number(key.slice(key.lastIndexOf(":") + 1));
    const existing = rawByRow.get(number);
    if (row.raw_row && typeof row.raw_row === "object" && (!existing || format === "raw-v3"))
      rawByRow.set(number, { format, raw: row.raw_row, fingerprint: row.row_fingerprint ?? null, coordinate: row.source_coordinate ?? null });
  }
  // The execution payload is one large jsonb; extracting each element detoasts it
  // again, so read it only for coordinates that have no retained observation.
  const payloadByRow = new Map<number, Record<string, string>>();
  const withoutObservation = numbers.filter(number => !rawByRow.has(number));
  if (withoutObservation.length) {
    const fallback = await pool.query(`SELECT n source_row_number,e.source_payload->(n-1) raw_row
      FROM import_executions e, unnest($2::int[]) n WHERE e.id=$1::uuid`, [id, withoutObservation]);
    for (const row of fallback.rows)
      if (row.raw_row && typeof row.raw_row === "object") payloadByRow.set(Number(row.source_row_number), row.raw_row);
  }
  const receiptsByItem = new Map<string, any[]>();
  for (const row of receipts.rows) {
    const bucket = receiptsByItem.get(String(row.entity_key)) ?? [];
    bucket.push(row.details ?? {});
    receiptsByItem.set(String(row.entity_key), bucket);
  }

  const rows: UploadLedgerRow[] = base.map(row => {
    const number = Number(row.source_row_number);
    const retained = rawByRow.get(number);
    const raw = retained?.raw ?? payloadByRow.get(number) ?? null;
    const expected = raw ? providerImportEmails(raw) : [];
    const provenance = events.rows.filter(event => Number(event.source_row_number) === number &&
      event.row_fingerprint === row.row_fingerprint);
    const mailboxes: UploadLedgerMailbox[] = expected.map(email => {
      const hit = provenance.find(event => event.email === email);
      return { email, contactId: hit ? Number(hit.contact_id) : null, hasProvenance: !!hit,
        businessId: hit?.business_id == null ? null : Number(hit.business_id), verifiedLink: !!hit?.verified };
    });
    const unexpected = [...new Set(provenance.filter(event => !expected.includes(event.email)).map(event => Number(event.contact_id)))];
    const candidates = row.item_id ? receiptsByItem.get(String(row.item_id)) ?? [] : [];
    const matching = candidates.filter(details => String(details.executionId) === id &&
      Number(details.sourceRowNumber) === number && details.rowFingerprint === row.row_fingerprint);
    let status: UploadReceiptStatus = "none";
    let receiptVersion: string | null = null;
    const fulfilled = row.item_state === "completed" && row.terminal_code === "CANONICAL_LOCAL_IMPORT_FULFILLED";
    if (candidates.length) {
      const current = matching.find(details => details.qualificationVersion === version);
      if (current && fulfilled) { status = "current"; receiptVersion = version; }
      else if (matching.length && !current) { status = "stale"; receiptVersion = String(matching.at(-1).qualificationVersion ?? "") || null; }
      else { status = "inconsistent"; receiptVersion = String(candidates.at(-1).qualificationVersion ?? "") || null; }
    }
    return {
      sourceRowNumber: number, disposition: String(row.disposition), reasonCode: String(row.reason_code),
      rowFingerprint: String(row.row_fingerprint), fulfillmentState: row.terminal_code ?? null,
      nextAttemptAt: row.next_attempt_at ?? null, completedAt: String(row.completed_at),
      originalFormat: retained?.format ?? (payloadByRow.has(number) ? "execution_payload" : null),
      sourceCoordinate: retained?.coordinate ?? null,
      companyName: raw ? String((raw as any).name ?? (raw as any).company_name ?? (raw as any).company ?? "") || null : null,
      businessOnly: !!raw && expected.length === 0, mailboxes, unexpectedContactIds: unexpected,
      receipt: { status, qualificationVersion: receiptVersion },
    };
  });
  return {
    executionId: id, rows, nextAfter: hasMore ? numbers.at(-1)! : null, limit, filter, observedAt: generatedAt,
  };
}
