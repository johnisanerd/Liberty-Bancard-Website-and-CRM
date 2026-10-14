import { storage } from "../storage";
import { db } from "../db";
import { csvImports } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  claimCsvExecution,
  getExpiredRecoverableCsvExecutions,
  failCsvImportProjection,
  startCsvImportProjection,
  type ImportExecutionClaim,
} from "./import-execution";
import { isRecoverableImportRowFailure } from "./canonical-import-recovery-outcomes";
import { safeDatabaseFailure } from "../lib/lock-trace";

export type CsvImportActor = {
  actorType: string;
  actorId: string;
  userId?: string;
};

export type PersistedCsvProcessor = (args: {
  records: Array<Record<string, string>>;
  executionClaim: ImportExecutionClaim;
  importRecord: Awaited<ReturnType<typeof storage.createCsvImport>>;
  sourceFormat: string;
  actor: CsvImportActor;
  filename: string;
}) => Promise<unknown>;

/**
 * Reclaims persisted CSV work after a process crash.  It intentionally has no
 * request dependency: both the upload controller and startup recovery supply
 * the same explicit actor/processor contract.
 */
export async function resumeExpiredCsvImports(process: PersistedCsvProcessor): Promise<number> {
  const candidates = await getExpiredRecoverableCsvExecutions();
  let resumed = 0;

  for (const execution of candidates) {
    let liveClaim: ImportExecutionClaim | undefined;
    try {
    const records = execution.sourcePayload;
    if (!Array.isArray(records) || !execution.fileHash) continue;
    const metadata = (execution.metadata ?? {}) as Record<string, unknown>;
    const sourceFormat = typeof metadata.sourceFormat === "string" ? metadata.sourceFormat : "custom";
    const claim = await claimCsvExecution({
      fileHash: execution.fileHash,
      totalRows: execution.totalRows ?? records.length,
      actorType: "system",
      actorId: "startup-resumer",
      metadata,
      sourcePayload: records as Array<Record<string, string>>,
    });
    liveClaim=claim;
    if (!claim.claimed || !claim.claimToken) continue;

    // The UI projection has an immutable relationship to the durable execution.
    // Never infer it from mutable status/source/row-count fields.
    const [existing] = await db.select().from(csvImports)
      .where(eq(csvImports.executionId, claim.execution.id))
      .limit(1);
    const importRecord = existing ?? await storage.createCsvImport({
      executionId: claim.execution.id,
      fileName: typeof metadata.fileName === "string" ? metadata.fileName : "recovered.csv",
      sourceFormat,
      totalRows: claim.execution.totalRows ?? records.length,
      importSource: sourceFormat,
      status: "processing",
      importedBy: "startup-resumer",
    });

    if (!await startCsvImportProjection(claim)) {
      throw new Error(`IMPORT_EXECUTION_LEASE_LOST:${claim.execution.id}`);
    }
    await process({
      records: records as Array<Record<string, string>>,
      executionClaim: claim,
      importRecord,
      sourceFormat,
      actor: { actorType: "system", actorId: "startup-resumer" },
      filename: importRecord.fileName,
    });
    resumed++;
    } catch (error) {
      // Only a confirmed local abort may yield to the next execution. Unknown
      // commit/connection results and authority denials retain the fatal boundary.
      try {
        if (liveClaim) await failCsvImportProjection(liveClaim,error);
      } catch (cleanupError) {
        throw new Error("CSV_IMPORT_RECOVERY_CLEANUP_FAILED",{cause:{originalError:error,cleanupError}});
      }
      if (!isRecoverableImportRowFailure(error)) throw error;
      console.warn(JSON.stringify({event:"csv_import_execution_deferred",executionId:execution.id,
        failure:safeDatabaseFailure(error)}));
    }
  }
  return resumed;
}