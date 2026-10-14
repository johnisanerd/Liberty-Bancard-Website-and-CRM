import type { PersistedCsvProcessor } from "./csv-import-recovery";
import { storage } from "../storage";
import { writeContact } from "./contact-writer";
import {
  completeImportExecution,
  heartbeatImportExecution,
  recordImportRowDisposition,
} from "./import-execution";
import { computeFileHash } from "./import-normalizer";
import { importDispositionCompatibility } from "@shared/import-disposition-summary";
import { materializeCanonicalProviderImportRow } from "./canonical-provider-import";
import {sql} from "drizzle-orm";
import {resolveOrganization} from "./organization-resolver";
import {normalizeDomain,normalizePhoneE164} from "./sdr/dedupe";
import {db} from "../db";
import {importedSourceRestrictions,mapProviderCsvRow} from "./provider-import-columns";
import {isRecoverableImportRowFailure} from "./canonical-import-recovery-outcomes";

let registeredProcessor: PersistedCsvProcessor | null = null;

/**
 * Express registers the worker once while routes are built. Both uploads and
 * recovery subsequently call this request-free processor boundary.
 */
export function registerPersistedCsvProcessor(processor: PersistedCsvProcessor): void {
  registeredProcessor = processor;
}

export async function processPersistedCsvImport(args: Parameters<PersistedCsvProcessor>[0]) {
  if (registeredProcessor) return registeredProcessor(args);
  return recoverPersistedCsvImport(args);
}

/**
 * Provider formats use the same retained-evidence/canonical intake boundary in
 * interactive imports and recovery.
 */
const PROVIDER_CSV_SOURCE_FORMATS = new Set(["google_maps_outscraper", "apollo_lead_list"]);

/**
 * Startup recovery is intentionally independent of Express.  A process can
 * restart before any request has registered the richer interactive importer;
 * this path consumes the same retained rows through the canonical local-first
 * writer and immutable ledger rather than requiring the customer to upload
 * the file a second time.
 *
 * Provider rows retain raw source observations and use canonical materialization
 * with selective downstream admission, rather than manufacturing hygiene.
 */
async function recoverPersistedCsvImport(args: Parameters<PersistedCsvProcessor>[0]) {
  const { records, executionClaim, importRecord, sourceFormat, actor, filename } = args;
  const executionId = executionClaim.execution.id;
  const claimToken = executionClaim.claimToken;
  if (!claimToken) throw new Error("CSV_IMPORT_RECOVERY_MISSING_CLAIM");

  // Reuse the provider-specific canonical writer, not the generic CSV parser.
  if (PROVIDER_CSV_SOURCE_FORMATS.has(sourceFormat)) {
    await recoverProviderCsvImport(args);
    return;
  }

  for (const [index, row] of records.entries()) {
    if (!await heartbeatImportExecution(executionId, claimToken)) {
      throw new Error(`IMPORT_EXECUTION_LEASE_LOST:${executionId}`);
    }
    const sourceRowNumber = index + 1;
    const rowFingerprint = computeFileHash(Buffer.from(JSON.stringify(row)));
    const mapped=mapProviderCsvRow(row,sourceFormat);
    const companyName = String(mapped.companyName ?? row.companyName ?? row.company ?? row.name ?? row.business_name ?? "").trim();
    const firstName = String(mapped.firstName ?? row.firstName ?? row.first_name ?? row["first name"] ?? "").trim();
    const lastName = String(mapped.lastName ?? row.lastName ?? row.last_name ?? row["last name"] ?? "").trim();
    const email = String(mapped.email ?? row.email ?? row.email_address ?? "").trim().toLowerCase();
    const phone = String(mapped.phone ?? row.phone ?? row.telephone ?? row.mobile_phone ?? row["mobile phone"] ?? "").trim();
    const authorityCheck=async(tx:any)=>(await tx.execute(sql`SELECT id FROM import_executions
      WHERE id=${executionId}::uuid AND claim_token=${claimToken}::uuid AND status='running'
        AND lease_expires_at>=clock_timestamp() FOR UPDATE`) as any).rows.length===1;

    if (!companyName && !firstName && !email && !phone) {
      await recordImportRowDisposition({
        executionId, claimToken, sourceRowNumber, rowFingerprint,
        disposition: "rejected", reasonCode: "NO_USABLE_IDENTITY",
      });
      continue;
    }

    try {
      if (companyName && !email && !firstName && !lastName) {
        const resolution=await resolveOrganization({
          canonicalName:companyName,websiteDomain:normalizeDomain(String(mapped.website ?? row.website ?? "")),
          mainPhone:normalizePhoneE164(phone),city:String(mapped.city ?? row.city ?? ""),state:String(mapped.state ?? row.state ?? ""),
          create:{recordClass:"canonical",lastSourceType:sourceFormat},
          authorityCheck,
        });
        await recordImportRowDisposition({executionId,claimToken,sourceRowNumber,rowFingerprint,
          disposition:resolution.kind==="deferred" ? "deferred" : resolution.kind==="created" ? "created" : "matched_noop",
          reasonCode:resolution.kind==="deferred" ? resolution.reasonCode : "CANONICAL_MANUAL_BUSINESS_ONLY",
          diagnostic:resolution.kind==="deferred" ? {candidateIds:resolution.candidateIds}
            : {businessId:resolution.business.id,contactIds:[]},
        });
        continue;
      }
      if (!email && !normalizePhoneE164(phone)) {
        await recordImportRowDisposition({executionId,claimToken,sourceRowNumber,rowFingerprint,
          disposition:"deferred",reasonCode:"INSUFFICIENT_PERSON_IDENTIFIERS"});
        continue;
      }
      const {customer,consentFlags,restrictions}=importedSourceRestrictions(row);
      await db.transaction(async tx=>{
      const contact=await writeContact({
        mode: "local_only",transaction:tx,
        hookPolicy:{source:"cro03",deferValidation:true,deferReadiness:true,
          deferLeadScoring:true,suppressProviderProjection:true,authorityCheck},
        mutation: {
          firstName,
          lastName,
          email,
          phone,
          companyName,
          ...(customer ? {existingMerchantCustomer:true} : {}),
          leadSource: sourceFormat,
          sourceCategory: "csv_import",
          primarySourceCategory: "csv_import",
          primarySourceType: "csv_contact",
          importBatchId: executionId,
        },
        provenance: {
          sourceCategory: "csv_import",
          sourceType: "csv_contact",
          eventKey: `import:${executionId}:row:${sourceRowNumber}`,
          importExecutionId: executionId,
          importClaimToken: claimToken,
          sourceRowNumber,
          rowFingerprint,
          actorType: actor.actorType,
          actorId: actor.actorId,
        },
        actor,
        rowDisposition: {
          createdReasonCode: "LOCAL_CONTACT_CREATED",
          matchedReasonCode: "EXACT_ELIGIBLE_IDENTITY_MATCH",
        },
      });
      if (customer) await tx.execute(sql`UPDATE contacts SET existing_merchant_customer=TRUE,updated_at=clock_timestamp()
        WHERE id=${contact.id} AND existing_merchant_customer IS DISTINCT FROM TRUE`);
      const {applyConsentCommand}=await import("./consent-authority");
      for (const kind of restrictions) await applyConsentCommand({
        subject:{type:"contact",id:contact.id},kind,
        ...(kind==="global_dnc" ? {} : {channel:"email" as const}),
        eventNamespace:"canonical_csv_import_restriction",
        eventKey:`${executionId}:${sourceRowNumber}:${contact.id}:${rowFingerprint}:${kind}`,
        source:"canonical_csv_import",actorId:actor.actorId,
        evidence:{sourceEventId:contact._sourceEventId,sourceRowNumber,rowFingerprint,
          negativeFields:consentFlags.map(([key])=>key)},
      },{transaction:tx,beforeWrite:async transaction=>{
        if (!await authorityCheck(transaction)) throw new Error("CSV_IMPORT_RESTRICTION_AUTHORITY_LOST");
      }});
      });
    } catch (error: any) {
      if (!isRecoverableImportRowFailure(error)) throw error;
      try {
        await recordImportRowDisposition({
          executionId, claimToken, sourceRowNumber, rowFingerprint,
          disposition: "failed", reasonCode: "RECOVERY_CONTACT_WRITE_FAILED",
          diagnostic: { error: String(error?.code ?? "write_failed") },
        });
      } catch (cleanupError) {
        throw new Error("CSV_IMPORT_RECOVERY_ROW_FAILURE_WRITE_FAILED",
          {cause:{originalError:error,cleanupError}});
      }
    }
  }

  const completion = await completeImportExecution({
    executionId,
    claimToken,
    expectedRows: records.length,
  });
  if (!completion.completed) {
    throw new Error(`CSV_IMPORT_RECOVERY_LEDGER_MISMATCH:${completion.total}/${records.length}`);
  }
  const outcomes = importDispositionCompatibility(completion.counts);

  await storage.updateCsvImport(importRecord.id, {
    newRecords: outcomes.created,
    updatedRecords: outcomes.updated,
    duplicatesSkipped: outcomes.matched_noop,
    invalidRows: outcomes.rejected,
    skippedRows: outcomes.deferred,
    errorsCount: outcomes.failed,
    processedRows: outcomes.total,
    status: "completed",
    completedAt: new Date(),
    lastProgressAt: new Date(),
  });

  await storage.createAuditLog({
    action: "csv_import_recovered",
    entityType: "csv_import",
    entityId: importRecord.id,
    actorType: actor.actorType,
    actorId: actor.actorId,
    details: { executionId, filename, totalRows: records.length },
  } as any);

  return {
    import: await storage.getCsvImport(importRecord.id),
    ...outcomes,
    dealsCreated: 0,
    verticalBreakdown: {},
    sourceFormat,
    optOutPreserved: 0,
    optOutApplied: 0,
  };
}

/**
 * Provider recovery uses the same retained-evidence/canonical local writer as
 * interactive CSV/XLSX intake. Original row dispositions remain immutable;
 * genuine identity/negative-authority conflicts are explicitly held.
 */
async function recoverProviderCsvImport(args: Parameters<PersistedCsvProcessor>[0]): Promise<{
  import: any; created: number; updated: number; matched_noop: number; rejected: number;
  deferred: number; failed: number; total: number;
  dealsCreated: number; verticalBreakdown: Record<string, number>;
  sourceFormat: string; optOutPreserved: number; optOutApplied: number;
}> {
  const { records, executionClaim, importRecord, sourceFormat, actor, filename } = args;
  const executionId = executionClaim.execution.id;
  const claimToken = executionClaim.claimToken;
  if (!claimToken) throw new Error("CSV_IMPORT_RECOVERY_MISSING_CLAIM");

  for (const [index, rawRow] of records.entries()) {
    if (!await heartbeatImportExecution(executionId, claimToken)) {
      throw new Error(`IMPORT_EXECUTION_LEASE_LOST:${executionId}`);
    }
    const sourceRowNumber = index + 1;
    const rowFingerprint = computeFileHash(Buffer.from(JSON.stringify(rawRow)));
    try {
      await materializeCanonicalProviderImportRow({
        executionId, sourceRowNumber, sourceFormat,
        claimToken,
        actorId: actor.actorId ?? executionId, rawRow,
        sourceCoordinate: (executionClaim.execution.metadata as any)?.sourceCoordinates?.[index],
        fileName: (executionClaim.execution.metadata as any)?.fileName,
      });
    } catch (error: any) {
      // An idle-session termination, unknown commit/connection result or lost
      // authority is not a definitive row outcome. Retain the original for the
      // same claim-fenced resumer instead of poisoning its immutable ledger.
      if (!isRecoverableImportRowFailure(error)) throw error;
      try {
        await recordImportRowDisposition({
          executionId, claimToken, sourceRowNumber, rowFingerprint,
          disposition: "failed",
          reasonCode: "RECOVERY_PROVIDER_STAGING_FAILED",
          diagnostic: { error: String(error?.message ?? "staging_failed").slice(0, 200) },
        });
      } catch (cleanupError) {
        throw new Error("CSV_IMPORT_RECOVERY_ROW_FAILURE_WRITE_FAILED",
          {cause:{originalError:error,cleanupError}});
      }
    }
  }

  const completion = await completeImportExecution({
    executionId,
    claimToken,
    expectedRows: records.length,
  });
  if (!completion.completed) {
    throw new Error(`CSV_IMPORT_RECOVERY_LEDGER_MISMATCH:${completion.total}/${records.length}`);
  }
  const outcomes = importDispositionCompatibility(completion.counts);

  await storage.updateCsvImport(importRecord.id, {
    newRecords: outcomes.created,
    updatedRecords: outcomes.updated,
    duplicatesSkipped: outcomes.matched_noop,
    invalidRows: outcomes.rejected,
    skippedRows: outcomes.deferred,
    errorsCount: outcomes.failed,
    processedRows: outcomes.total,
    status: "completed",
    completedAt: new Date(),
    lastProgressAt: new Date(),
  });

  await storage.createAuditLog({
    action: "csv_import_recovered_provider",
    entityType: "csv_import",
    entityId: importRecord.id,
    actorType: actor.actorType,
    actorId: actor.actorId,
    details: {
      executionId, filename, totalRows: records.length,
      sourceFormat, csvSourceSystem: sourceFormat === "google_maps_outscraper" ? "outscraper" : "apollo",
      canonicalHeldRows: outcomes.deferred,
      failedRows: outcomes.failed,
    },
  } as any);

  return {
    import: await storage.getCsvImport(importRecord.id),
    ...outcomes,
    dealsCreated: 0,
    verticalBreakdown: {},
    sourceFormat,
    optOutPreserved: 0,
    optOutApplied: 0,
  };
}