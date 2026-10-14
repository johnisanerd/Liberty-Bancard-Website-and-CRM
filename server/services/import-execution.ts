import crypto from "crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { importExecutions, importRowDispositions } from "@shared/schema";
import {safeDatabaseFailure} from "../lib/lock-trace";
import {
  IMPORT_DISPOSITIONS,
  summarizeImportDispositionCounts,
  type ImportDisposition,
} from "@shared/import-disposition-summary";

export type { ImportDisposition } from "@shared/import-disposition-summary";

export interface ImportExecutionClaim {
  execution: typeof importExecutions.$inferSelect;
  claimed: boolean;
  replay: boolean;
  claimToken: string | null;
}

const LEASE_MS = 5 * 60 * 1000;

export function csvExecutionKey(fileHash: string): string {
  return `csv_contact:${fileHash}`;
}

/**
 * Atomically create or claim an import execution. A replay never receives a
 * second processor lease; an expired lease can be reclaimed safely.
 */
export async function claimCsvExecution(args: {
  fileHash: string;
  totalRows: number;
  actorType: string;
  actorId: string;
  metadata?: Record<string, unknown>;
  sourcePayload?: Array<Record<string, string>>;
}): Promise<ImportExecutionClaim> {
  const executionKey = csvExecutionKey(args.fileHash);
  const claimToken = crypto.randomUUID();
  const expiry = new Date(Date.now() + LEASE_MS);

  return db.transaction(async (tx) => {
    const inserted = await tx.insert(importExecutions).values({
      importType: "csv_contact",
      fileHash: args.fileHash,
      executionKey,
      status: "running",
      totalRows: args.totalRows,
      actorType: args.actorType,
      actorId: args.actorId,
      metadata: args.metadata ?? null,
      sourcePayload: args.sourcePayload ?? null,
      claimToken,
      leaseExpiresAt: expiry,
      heartbeatAt: new Date(),
      attemptCount: 1,
    }).onConflictDoNothing().returning();
    if (inserted[0]) return { execution: inserted[0], claimed: true, replay: false, claimToken };

    const [existing] = await tx.select().from(importExecutions)
      .where(eq(importExecutions.executionKey, executionKey)).limit(1);
    if (!existing) throw new Error("IMPORT_EXECUTION_CLAIM_RACE");
    if (existing.status === "completed") {
      return { execution: existing, claimed: false, replay: true, claimToken: null };
    }

    if (existing.status === "running" && existing.leaseExpiresAt && existing.leaseExpiresAt > new Date()) {
      return { execution: existing, claimed: false, replay: false, claimToken: null };
    }
    const reclaimed = await tx.update(importExecutions)
      .set({
        claimToken,
        leaseExpiresAt: expiry,
        heartbeatAt: new Date(),
        attemptCount: sql`${importExecutions.attemptCount} + 1`,
        status: "running",
      })
      .where(and(
        eq(importExecutions.id, existing.id),
        sql`(${importExecutions.leaseExpiresAt} IS NULL OR ${importExecutions.leaseExpiresAt} < now())`,
      ))
      .returning();
    if (reclaimed[0]) return { execution: reclaimed[0], claimed: true, replay: false, claimToken };
    return { execution: existing, claimed: false, replay: true, claimToken: null };
  });
}

export async function heartbeatImportExecution(executionId: string, claimToken: string): Promise<boolean> {
  return db.transaction(async tx=>{
    const changed=await tx.execute(sql`WITH pinned AS MATERIALIZED (
      SELECT id,lease_expires_at FROM import_executions WHERE id=${executionId}::uuid
        AND claim_token=${claimToken}::uuid AND status='running' FOR UPDATE
    ) UPDATE import_executions current SET heartbeat_at=clock_timestamp(),
      lease_expires_at=clock_timestamp()+${LEASE_MS}::integer*INTERVAL '1 millisecond'
      FROM pinned WHERE current.id=pinned.id AND current.claim_token=${claimToken}::uuid
        AND current.status='running' AND pinned.lease_expires_at>clock_timestamp()
      RETURNING current.id`);
    return ((changed as any).rows ?? []).length===1;
  });
}

/** Failure is a projection of this exact live execution, never "first processing". */
export async function failCsvImportProjection(claim: ImportExecutionClaim, failure?: unknown): Promise<boolean> {
  if (!claim.claimed || !claim.claimToken) return false;
  return db.transaction(async tx=>{
    const changed=await tx.execute(sql`WITH pinned AS MATERIALIZED (
      SELECT id,lease_expires_at FROM import_executions
      WHERE id=${claim.execution.id}::uuid AND status='running'
        AND claim_token=${claim.claimToken}::uuid FOR UPDATE
    ) UPDATE csv_imports projection SET status='failed'
      FROM pinned WHERE projection.execution_id=pinned.id
        AND pinned.lease_expires_at>clock_timestamp() RETURNING projection.id`);
    if (((changed as any).rows ?? []).length && failure !== undefined) {
      // Failure evidence is mutable execution state, never a row disposition.
      // The same locked, live claim owns both its projection and this bounded
      // diagnostic; no source values, raw SQL or ownership tokens are stored.
      const evidence={version:1,observedAt:new Date().toISOString(),
        diagnostic:safeDatabaseFailure(failure)};
      await tx.execute(sql`UPDATE import_executions SET metadata=jsonb_set(
        COALESCE(metadata,'{}'::jsonb),'{canonicalRecoveryLastFailure}',
        ${JSON.stringify(evidence)}::jsonb,TRUE) WHERE id=${claim.execution.id}::uuid
        AND claim_token=${claim.claimToken}::uuid AND status='running'`);
    }
    return ((changed as any).rows ?? []).length>0;
  });
}

/**
 * Return only executions which are safe for a recovery worker to attempt.  The
 * caller must still use claimCsvExecution before doing any work; this query is
 * deliberately advisory so two application instances can run recovery at the
 * same time without creating two owners.
 */
export async function getExpiredRecoverableCsvExecutions() {
  return db.select().from(importExecutions).where(and(
    eq(importExecutions.importType, "csv_contact"),
    eq(importExecutions.status, "running"),
    sql`${importExecutions.sourcePayload} IS NOT NULL`,
    sql`(${importExecutions.leaseExpiresAt} IS NULL OR ${importExecutions.leaseExpiresAt} < now())`,
  )).orderBy(sql`${importExecutions.leaseExpiresAt} ASC NULLS FIRST`,
    asc(importExecutions.startedAt), asc(importExecutions.id));
}

/** A reclaimed execution must explicitly reopen its own projection. An old
 * failed projection plus an unexpired lease is not evidence of healthy work. */
export async function startCsvImportProjection(claim: ImportExecutionClaim): Promise<boolean> {
  if (!claim.claimed || !claim.claimToken) return false;
  return db.transaction(async tx => {
    const changed = await tx.execute(sql`WITH pinned AS MATERIALIZED (
      SELECT id,lease_expires_at FROM import_executions
      WHERE id=${claim.execution.id}::uuid AND status='running'
        AND claim_token=${claim.claimToken}::uuid FOR UPDATE
    ) UPDATE csv_imports projection SET status='processing',
        stale_reason=NULL,last_progress_at=clock_timestamp()
      FROM pinned WHERE projection.execution_id=pinned.id
        AND pinned.lease_expires_at>clock_timestamp() RETURNING projection.id`);
    return ((changed as any).rows ?? []).length === 1;
  });
}

export async function recordImportRowDisposition(args: {
  executionId: string;
  claimToken: string;
  sourceRowNumber: number;
  rowFingerprint: string;
  disposition: ImportDisposition;
  reasonCode: string;
  contactId?: number | null;
  diagnostic?: Record<string, unknown> | null;
}): Promise<boolean> {
  if (!(IMPORT_DISPOSITIONS as readonly string[]).includes(args.disposition)) {
    throw new Error(`IMPORT_LEDGER_INVALID_DISPOSITION:${args.disposition}`);
  }
  const { claimToken: _claimToken, ...ledgerRow } = args;
  // Ownership validation and the durable row insert share one transaction and
  // one locked execution row; a reclaimed worker cannot write after lease loss.
  const result = await db.transaction(async (tx) => {
    const owner = (await tx.execute(sql`
      SELECT id FROM import_executions WHERE id = ${args.executionId}::uuid
        AND claim_token = ${args.claimToken}::uuid AND status = 'running'
        AND lease_expires_at >= now() FOR UPDATE
    `) as any).rows?.[0];
    if (!owner) throw new Error(`IMPORT_EXECUTION_LEASE_LOST:${args.executionId}`);
    const inserted = await tx.insert(importRowDispositions).values({
      ...ledgerRow, contactId: ledgerRow.contactId ?? null, diagnostic: ledgerRow.diagnostic ?? null,
    }).onConflictDoNothing().returning({ id: importRowDispositions.id });
    if (inserted.length === 1) return true;
    const [existing] = await tx.select({
      rowFingerprint: importRowDispositions.rowFingerprint,
      disposition: importRowDispositions.disposition,
      reasonCode: importRowDispositions.reasonCode,
      contactId: importRowDispositions.contactId,
      diagnostic: importRowDispositions.diagnostic,
    }).from(importRowDispositions).where(and(
      eq(importRowDispositions.executionId, args.executionId),
      eq(importRowDispositions.sourceRowNumber, args.sourceRowNumber),
    )).limit(1);
    if (
      existing &&
      existing.rowFingerprint === args.rowFingerprint &&
      existing.disposition === args.disposition &&
      existing.reasonCode === args.reasonCode &&
      existing.contactId === (args.contactId ?? null) &&
      JSON.stringify((existing as any).diagnostic ?? null) === JSON.stringify(args.diagnostic ?? null)
    ) return true;
    throw new Error(`IMPORT_LEDGER_DISPOSITION_CONFLICT:${args.executionId}:${args.sourceRowNumber}`);
  });
  return result;
}

export async function getImportLedgerSummary(executionId: string) {
  const rows = await db.execute(sql`
    SELECT disposition, count(*)::int AS count
    FROM import_row_dispositions
    WHERE execution_id = ${executionId}
    GROUP BY disposition
  `);
  const counts: Record<string, number> = {};
  for (const row of ((rows as any).rows ?? [])) counts[row.disposition] = Number(row.count);
  const execution=(await db.execute(sql`SELECT status,lease_expires_at,
    (jsonb_typeof(source_payload)='array' AND file_hash IS NOT NULL) IS TRUE can_recover,
    metadata->'canonicalRecoveryLastFailure' last_failure,
    (SELECT count(*)::int FROM jsonb_object_keys(
      COALESCE(metadata->'canonicalProviderPendingRows','{}'::jsonb))) pending_rows,
    clock_timestamp() observed_at FROM import_executions WHERE id=${executionId}::uuid`) as any).rows?.[0];
  return {...summarizeImportDispositionCounts(counts),recovery:execution ? {
    version:1,observedAt:execution.observed_at,executionStatus:execution.status,
    persistedSourceAvailable:execution.can_recover,
    pendingFulfillmentRows:Number(execution.pending_rows),
    lastFailure:execution.last_failure ?? null,
    nextEligibleAt:execution.status==='running' && execution.can_recover ? execution.lease_expires_at : null,
    nextAutomaticAction:execution.status==='running' && execution.can_recover
      ? 'claim_expired_persisted_execution' : null,
  } : null};
}

export async function completeImportExecution(args: {
  executionId: string;
  claimToken: string;
  expectedRows: number;
}): Promise<{ completed: boolean; counts: Record<ImportDisposition, number>; total: number }> {
  return db.transaction(async (tx) => {
   const execution = (await tx.execute(sql`WITH pinned AS MATERIALIZED (
    SELECT id,total_rows,metadata,lease_expires_at FROM import_executions WHERE id = ${args.executionId}::uuid
    AND claim_token = ${args.claimToken}::uuid AND status = 'running'
    FOR UPDATE) SELECT id,total_rows,metadata FROM pinned WHERE lease_expires_at>clock_timestamp()`) as any).rows?.[0];
  if (!execution) throw new Error(`IMPORT_EXECUTION_LEASE_LOST:${args.executionId}`);
  const result = await tx.execute(sql`SELECT disposition, count(*)::int AS count FROM import_row_dispositions WHERE execution_id = ${args.executionId}::uuid GROUP BY disposition`);
   const counts: Record<string, number> = {};
  for (const row of (result as any).rows ?? []) counts[row.disposition] = Number(row.count);
   const summary = summarizeImportDispositionCounts(counts);
   const expectedRows = Number(execution.total_rows);
   const rawTotal = Object.values(counts).reduce((total, value) => total + value, 0);
   const onlyTerminalDispositions = Object.keys(counts)
     .every((disposition) => (IMPORT_DISPOSITIONS as readonly string[]).includes(disposition));
    const pending=execution.metadata?.canonicalProviderPendingRows;
    const incompleteProviderFulfillment=pending!=null && (
      typeof pending!=="object" || Array.isArray(pending) || Object.keys(pending).length>0
    );
   if (
      incompleteProviderFulfillment ||
     expectedRows !== args.expectedRows ||
     !onlyTerminalDispositions ||
     rawTotal !== expectedRows ||
     summary.total !== expectedRows
   ) {
    return { completed: false, ...summary };
  }
  const completed = await tx.update(importExecutions).set({
    status: "completed",
    completedAt: new Date(),
    heartbeatAt: new Date(),
    leaseExpiresAt: null,
    claimToken: null,
     insertedRows: summary.counts.created,
     updatedRows: summary.counts.updated,
     skippedRows: summary.counts.matched_noop + summary.counts.deferred,
     errorRows: summary.counts.rejected + summary.counts.failed,
  }).where(and(eq(importExecutions.id, args.executionId), eq(importExecutions.claimToken, args.claimToken), eq(importExecutions.status, "running")))
    .returning({ id: importExecutions.id });
  return { completed: completed.length === 1, ...summary };
  });
}