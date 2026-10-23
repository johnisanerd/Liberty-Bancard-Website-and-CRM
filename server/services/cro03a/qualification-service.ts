import { and, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, pool } from "../../db";
import { prospects, sunbizEntities, sdrMerchants, leadDiscoveryResults, masterLeads } from "@shared/schema";
import { hashCro03Evidence } from "../cro03/source-staging";
import { createCro03SourceBatch } from "../cro03/source-staging";
import { stableCro03aSelectionHash } from "../cro03/contracts";
import { sanitizeAuditPayload } from "../audit-sanitizer";
import {
  CRO03A_FIT_V2_POLICY_IDENTITY,
  CRO03A_FIT_V2_POLICY_IDENTITY_HASH,
  evaluateCro03aCandidate,
  type Cro03aEvaluation,
} from "./fit";
import {
  CRO03A_SOURCE_CENSUS,
  leadDiscoverySourceSubject,
  linkedDiscoveryEvidence,
  masterLeadSourceSubject,
  prospectSourceSubject,
  sdrMerchantSourceSubject,
  sunbizSourceSubject,
  type Cro03aSourceDraft,
} from "./adapters";
import {
  evaluateSouthFloridaGeography,
  CRO03A_COUNTY_FIPS,
  _ZIP_COUNTY_V2_FOR_TEST,
  _CITY_COUNTY_V2_FOR_TEST,
} from "./geography";

const resultRows = (result: any): any[] => result?.rows ?? result ?? [];
const json = <T>(value: T | string): T => typeof value === "string" ? JSON.parse(value) as T : value;
const allowedSelectableTypes = new Set(["prospect", "sunbiz_entity", "sdr_merchant", "provider_csv_row", "lead_discovery_result", "master_lead"]);

/** Extract the first non-empty string value from a payload object by trying keys in order. */
const payloadStr = (payload: Record<string, unknown>, ...keys: string[]): string | undefined =>
  keys.map((k) => payload[k]).find((v) => typeof v === "string" && (v as string).trim()) as string | undefined;

/** The three active South Florida county FIPS codes (excluding disabled Monroe). */
const SOUTH_FLORIDA_FIPS_SET = new Set(Object.values(CRO03A_COUNTY_FIPS));
const ELIGIBLE_COUNTY_NAMES = new Set(Object.keys(CRO03A_COUNTY_FIPS)); // Broward, Miami-Dade, Palm Beach

/**
 * ZIP codes that map to exactly one South Florida target county (Broward, Miami-Dade,
 * Palm Beach) per the v2 reference.  Ambiguous or Monroe-only ZIPs are excluded.
 * Used as a SQL-side pre-filter to avoid scanning non-target FL records.
 */
const SOUTH_FLORIDA_ZIPS: readonly string[] = Object.freeze(
  Object.entries(_ZIP_COUNTY_V2_FOR_TEST)
    .filter(([, counties]) => counties.length === 1 && ELIGIBLE_COUNTY_NAMES.has(counties[0]))
    .map(([zip]) => zip),
);

/**
 * City names (lowercased) that map to exactly one South Florida target county.
 * Ambiguous or Monroe-only city entries are excluded.
 */
const SOUTH_FLORIDA_CITIES: readonly string[] = Object.freeze(
  Object.entries(_CITY_COUNTY_V2_FOR_TEST)
    .filter(([, counties]) => counties.length === 1 && ELIGIBLE_COUNTY_NAMES.has(counties[0]))
    .map(([city]) => city),
);

/**
 * Normalise a state string so the geography evaluator (which only recognises "FL"
 * after uppercasing) correctly handles records where the full name "Florida" was
 * stored instead of the abbreviation.
 */
const normalizeStateFl = (state: string | undefined): string | undefined => {
  if (!state) return state;
  const trimmed = state.trim();
  return trimmed.toUpperCase() === "FLORIDA" ? "FL" : trimmed;
};

export type FrozenOccurrence = {
  occurrenceId: string; subjectId: string; subjectType: string; sourceSystem: string;
  subjectKey: string; sourceObservedAt: string; payloadHash: string;
  payload: Record<string, unknown>; provenance: Record<string, unknown>;
};
export type ActivePolicy = { id: string; version: number; policyHash: string; policy: Record<string, any>; controlVersion: number };

const algorithmIdentityFor = (policy: Record<string, any>) => policy.fitVersion === "fit-v2"
  ? { ...CRO03A_FIT_V2_POLICY_IDENTITY, policy }
  : { fitVersion: "fit-v1", policy };
const algorithmIdentityHashFor = (policy: Record<string, any>) => hashCro03Evidence(algorithmIdentityFor(policy));
const algorithmColumns = new Map<string, Promise<Set<string>>>();

/** Optional during rolling upgrades: pre-migration installations lack these columns. */
async function persistAlgorithmIdentityIfSupported(
  executor: any, table: "cro03a_qualification_runs" | "cro03a_qualification_decisions" | "cro03a_handoffs",
  id: string, identity: Record<string, unknown>, identityHash: string,
) {
  let columns = algorithmColumns.get(table);
  if (!columns) {
    const discovered = executor.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name=${table}
         AND column_name IN ('algorithm_identity','algorithm_identity_hash')
    `).then((result: any) => new Set(resultRows(result).map((row) => String(row.column_name))));
    algorithmColumns.set(table, discovered);
    columns = discovered;
  }
  const available = await columns!;
  if (available.has("algorithm_identity") && available.has("algorithm_identity_hash")) {
    // table is a closed union, never request input.
    await executor.execute(sql`
      UPDATE ${sql.raw(table)}
         SET algorithm_identity=${JSON.stringify(identity)}::jsonb, algorithm_identity_hash=${identityHash}
       WHERE id=${id}::uuid
    `);
  }
}

export async function getActivePolicy(executor: any = db): Promise<ActivePolicy> {
  const row = resultRows(await executor.execute(sql`
    SELECT p.id,p.version,p.policy_hash,p.policy,c.expected_version
      FROM cro03a_policy_control c
      JOIN cro03a_policy_documents p ON p.id=c.active_policy_id
     WHERE c.id=1
  `))[0];
  if (!row) throw new Error("CRO03A_ACTIVE_POLICY_REQUIRED");
  return {
    id: String(row.id), version: Number(row.version), policyHash: String(row.policy_hash),
    policy: json(row.policy), controlVersion: Number(row.expected_version),
  };
}

export async function loadOccurrences(
  ids: readonly string[],
  executor: any = db,
  options: { enrichRelationships?: boolean } = {},
): Promise<FrozenOccurrence[]> {
  const unique = [...new Set(ids)].sort();
  if (!unique.length || unique.length > 500 || unique.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) {
    throw new Error("CRO03A_INVALID_OCCURRENCE_SCOPE");
  }
  const result = await executor.execute(sql`
    SELECT o.id AS occurrence_id,o.source_subject_id,s.subject_type,s.source_system,s.subject_key,
           o.source_observed_at,o.payload_hash,v.payload,v.provenance
      FROM cro03_source_occurrences o
      JOIN cro03_source_subjects s ON s.id=o.source_subject_id
      JOIN cro03_source_observations v ON v.id=o.source_observation_id
     WHERE o.id IN (${sql.join(unique.map((id) => sql`${id}::uuid`), sql`,`)})
     ORDER BY o.id
  `);
  const loaded = resultRows(result).map((row) => ({
    occurrenceId: String(row.occurrence_id), subjectId: String(row.source_subject_id),
    subjectType: String(row.subject_type), sourceSystem: String(row.source_system),
    subjectKey: String(row.subject_key), sourceObservedAt: new Date(row.source_observed_at).toISOString(),
    payloadHash: String(row.payload_hash), payload: json(row.payload), provenance: json(row.provenance),
  }));
  if (loaded.length !== unique.length) throw new Error("CRO03A_OCCURRENCE_NOT_FOUND");
  if (options.enrichRelationships === false) return loaded;

  // ── MI-03: Feature-detect canonical_source_links table before the loop ────
  // The enrichment queries below target canonical_source_links, which is added
  // in migration 0248. If that migration has not yet been applied (rolling
  // upgrade, test environment without MI-03 migrations), we skip the enrichment
  // rather than issuing a query inside a transaction that could cause a 25P02
  // "current transaction is aborted" error for every occurrence in the batch.
  // This detection runs ONCE outside the per-occurrence loop.
  let canonicalSourceLinksAvailable = false;
  try {
    const tableCheck = resultRows(await db.execute(sql`
      SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='canonical_source_links'
       LIMIT 1
    `));
    canonicalSourceLinksAvailable = tableCheck.length > 0;
  } catch {
    canonicalSourceLinksAvailable = false;
  }

  for (const occurrence of loaded) {
    const prior = resultRows(await executor.execute(sql`
      SELECT id FROM cro03a_handoffs
       WHERE source_type=${occurrence.subjectType} AND source_system=${occurrence.sourceSystem}
         AND source_key=${occurrence.subjectKey}
       LIMIT 1
    `))[0];
    if (prior) occurrence.provenance.priorSelectedHandoff = true;
    if (occurrence.subjectType === "prospect" && /^\d+$/.test(occurrence.subjectKey)) {
      const relation = resultRows(await executor.execute(sql`
        SELECT p.contact_id,p.conversion_contact_id,p.do_not_contact,p.record_class,
               c.do_not_contact AS contact_dnc,c.opted_out_email,c.business_id,
               EXISTS (
                 SELECT 1 FROM deals d
                  WHERE d.contact_id=COALESCE(p.contact_id,p.conversion_contact_id)
                    AND lower(COALESCE(d.stage,'')) NOT LIKE '%closed%'
                    AND lower(COALESCE(d.stage,'')) NOT LIKE '%lost%'
               ) AS open_opportunity
          FROM prospects p
          LEFT JOIN contacts c ON c.id=COALESCE(p.contact_id,p.conversion_contact_id)
         WHERE p.id=${Number(occurrence.subjectKey)}
      `))[0];
      if (relation) {
        occurrence.provenance.existingCustomerFlag =
          relation.record_class === "customer" || relation.business_id != null;
        occurrence.provenance.doNotContactFlag =
          relation.do_not_contact === true || relation.contact_dnc === true || relation.opted_out_email === true;
        occurrence.provenance.openOpportunity = relation.open_opportunity === true;
        if (relation.contact_id != null || relation.conversion_contact_id != null) {
          occurrence.provenance.exactStrongIdentityMatches = ["canonical_contact_fk"];
        }
      }
    }
    if (occurrence.subjectType === "sdr_merchant") {
      const match = occurrence.subjectKey.match(/(?:row:)?(\d+)$/);
      if (match) {
        const relation = resultRows(await executor.execute(sql`
          SELECT business_id,existing_customer_flag,do_not_contact_flag,
                 ghl_contact_id,ghl_opportunity_id
            FROM sdr_merchants WHERE id=${Number(match[1])}
        `))[0];
        if (relation) {
          occurrence.provenance.existingCustomerFlag =
            relation.existing_customer_flag === true || relation.business_id != null || relation.ghl_contact_id != null;
          occurrence.provenance.doNotContactFlag = relation.do_not_contact_flag === true;
          occurrence.provenance.openOpportunity = relation.ghl_opportunity_id != null;
          if (relation.business_id != null) occurrence.provenance.exactStrongIdentityMatches = ["canonical_business_fk"];
        }
      }
    }

    // ── MI-03: v2 fit dimension enrichment ──────────────────────────────────
    // Only runs when canonical_source_links table is confirmed available above.
    // Uses EXACT (source_system, source_type, stable_key) matching to enforce
    // namespace isolation — cross-registry comparisons are prohibited.
    // Sunbiz subject_key format is `filing:<filing_number>` or `row:<id>`;
    // the canonical stable_key strips the `filing:` prefix to match what
    // projectBusinessOnly() writes under ('sunbiz_entities','sunbiz_filing').
    // All queries use `db` (not `executor`) so they are always run outside any
    // caller-supplied transaction — avoiding 25P02 aborted-transaction errors.
    if (canonicalSourceLinksAvailable) {
      let stableKey = String(occurrence.subjectKey).trim();
      let cslSourceSystem: string;
      let cslSourceType: string;

      if (occurrence.subjectType === "sunbiz_entity") {
        cslSourceSystem = "sunbiz_entities";
        cslSourceType = "sunbiz_filing";
        if (stableKey.startsWith("filing:")) {
          stableKey = stableKey.slice("filing:".length).trim();
        } else {
          // row:<id> — filing_number not yet resolved; skip enrichment.
          occurrence.payload._sourceRegistryActiveWithin90Days = false;
          occurrence.payload._distinctCountyFipsCount = 0;
          continue; // eslint-disable-line no-continue
        }
      } else {
        cslSourceSystem = occurrence.sourceSystem;
        cslSourceType = occurrence.subjectType;
      }

      const linkRows = resultRows(await db.execute(sql`
        SELECT csl.business_id
          FROM canonical_source_links csl
         WHERE csl.source_system = ${cslSourceSystem}
           AND csl.source_type   = ${cslSourceType}
           AND csl.stable_key    = ${stableKey}
           AND csl.last_confirmed_at >= NOW() - INTERVAL '90 days'
         LIMIT 1
      `));
      if (linkRows.length > 0) {
        occurrence.payload._sourceRegistryActiveWithin90Days = true;
        const businessId = Number(linkRows[0].business_id);
        const countyRows = resultRows(await db.execute(sql`
          SELECT COUNT(DISTINCT county_fips)::int AS distinct_fips
            FROM business_locations
           WHERE business_id = ${businessId}
             AND county_fips IS NOT NULL
        `));
        occurrence.payload._distinctCountyFipsCount = Number(countyRows[0]?.distinct_fips ?? 0);
      } else {
        occurrence.payload._sourceRegistryActiveWithin90Days = false;
        occurrence.payload._distinctCountyFipsCount = 0;
      }
    } else {
      occurrence.payload._sourceRegistryActiveWithin90Days = false;
      occurrence.payload._distinctCountyFipsCount = 0;
    }
  }
  return loaded;
}

function evaluateOccurrence(occurrence: FrozenOccurrence, policy: ActivePolicy, asOf: string): Cro03aEvaluation {
  if (!allowedSelectableTypes.has(occurrence.subjectType)) {
    const evaluation = evaluateCro03aCandidate({
      payload: occurrence.payload, sourceSystem: occurrence.sourceSystem,
      observedAt: occurrence.sourceObservedAt, now: asOf, policy: policy.policy,
    });
    return { ...evaluation, disposition: "excluded", reasonCodes: [...evaluation.reasonCodes, "EVIDENCE_ONLY_SOURCE"] };
  }
  if (occurrence.subjectType === "lead_discovery_result" && occurrence.payload.merchantId != null) {
    const evaluation = evaluateCro03aCandidate({
      payload: occurrence.payload, sourceSystem: occurrence.sourceSystem,
      observedAt: occurrence.sourceObservedAt, now: asOf, policy: policy.policy,
    });
    return { ...evaluation, disposition: "duplicate", reasonCodes: [...evaluation.reasonCodes, "LINKED_DISCOVERY_COLLAPSED_TO_SDR_MERCHANT"] };
  }
  if (occurrence.provenance.evidenceOnlyLinkedDiscovery === true) {
    const evaluation = evaluateCro03aCandidate({
      payload: occurrence.payload, sourceSystem: occurrence.sourceSystem,
      observedAt: occurrence.sourceObservedAt, now: asOf, policy: policy.policy,
    });
    return { ...evaluation, disposition: "duplicate", reasonCodes: [...evaluation.reasonCodes, "LINKED_DISCOVERY_COLLAPSED_TO_SDR_MERCHANT"] };
  }
  if (occurrence.provenance.priorSelectedHandoff === true) {
    const evaluation = evaluateCro03aCandidate({
      payload: occurrence.payload, sourceSystem: occurrence.sourceSystem,
      observedAt: occurrence.sourceObservedAt, now: asOf, policy: policy.policy,
    });
    return { ...evaluation, disposition: "duplicate", reasonCodes: [...evaluation.reasonCodes, "PRIOR_SELECTED_SOURCE_SUBJECT"] };
  }
  return evaluateCro03aCandidate({
    payload: occurrence.payload, sourceSystem: occurrence.sourceSystem,
    observedAt: occurrence.sourceObservedAt, now: asOf,
    relationship: {
      existingCustomer: occurrence.payload.existingCustomerFlag === true || occurrence.provenance.existingCustomerFlag === true,
      openOpportunity: occurrence.payload.openOpportunity === true || occurrence.provenance.openOpportunity === true,
      dnc: occurrence.payload.doNotContactFlag === true || occurrence.provenance.doNotContactFlag === true,
      suppressed: occurrence.payload.suppressed === true || occurrence.provenance.suppressed === true,
    },
    identity: {
      exactMatches: Array.isArray(occurrence.provenance.exactStrongIdentityMatches) ? occurrence.provenance.exactStrongIdentityMatches.map(String) : [],
      conflictingExactMatches: Array.isArray(occurrence.provenance.conflictingStrongIdentityMatches) ? occurrence.provenance.conflictingStrongIdentityMatches.map(String) : [],
      weakMatches: Array.isArray(occurrence.provenance.weakIdentityMatches) ? occurrence.provenance.weakIdentityMatches.map(String) : [],
    },
    policy: policy.policy,
  });
}

export function evaluateOccurrenceSet(occurrences: FrozenOccurrence[], policy: ActivePolicy, asOf: string) {
  const selectedSubjects = new Set<string>();
  return occurrences.map((occurrence) => {
    let evaluation = evaluateOccurrence(occurrence, policy, asOf);
    if (evaluation.disposition === "selected" && selectedSubjects.has(occurrence.subjectId)) {
      evaluation = { ...evaluation, disposition: "duplicate", reasonCodes: [...evaluation.reasonCodes, "DUPLICATE_SUBJECT_IN_RUN"] };
    }
    if (evaluation.disposition === "selected") selectedSubjects.add(occurrence.subjectId);
    return { occurrence, evaluation };
  });
}

export async function previewCro03aQualification(occurrenceIds: readonly string[]) {
  const policy = await getActivePolicy();
  const occurrences = await loadOccurrences(occurrenceIds);
  const asOf = new Date().toISOString();
  const items = evaluateOccurrenceSet(occurrences, policy, asOf).map(({ occurrence, evaluation }) => ({
    occurrenceId: occurrence.occurrenceId,
    source: { type: occurrence.subjectType, system: occurrence.sourceSystem, keyHash: hashCro03Evidence(occurrence.subjectKey) },
    evaluation,
  }));
  return {
    policy: { id: policy.id, version: policy.version, hash: policy.policyHash },
    selectionHash: stableCro03aSelectionHash(occurrences.map((row) => row.occurrenceId)),
    total: items.length,
    evaluatedAsOf: asOf,
    dispositionCounts: items.reduce<Record<string, number>>((counts, item) => {
      counts[item.evaluation.disposition] = (counts[item.evaluation.disposition] ?? 0) + 1;
      return counts;
    }, {}),
    items,
    effectAuthorized: false,
  };
}

export async function createCro03aQualificationRun(input: {
  idempotencyKey: string; occurrenceIds: readonly string[]; actorId: string; actorRole: "admin" | "manager";
}) {
  if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) throw new Error("CRO03A_INVALID_IDEMPOTENCY_KEY");
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"cro03a:" + input.idempotencyKey},0))`);
    const requestedOccurrenceIds = [...new Set(input.occurrenceIds)].sort();
    const existing = resultRows(await tx.execute(sql`
      SELECT id,scope_hash,state,total_count,selected_count,review_count,terminal_count,
             frozen_occurrence_ids
        FROM cro03a_qualification_runs WHERE idempotency_key=${input.idempotencyKey}
    `))[0];
    if (existing) {
      const frozen = json<string[]>(existing.frozen_occurrence_ids).map(String).sort();
      if (stableCro03aSelectionHash(frozen) !== stableCro03aSelectionHash(requestedOccurrenceIds)) {
        throw new Error("CRO03A_IDEMPOTENCY_SCOPE_CONFLICT");
      }
      return {
        id: String(existing.id), replayed: true, state: String(existing.state),
        totalCount: Number(existing.total_count), selectedCount: Number(existing.selected_count),
        reviewCount: Number(existing.review_count), terminalCount: Number(existing.terminal_count),
      };
    }
    const policy = await getActivePolicy(tx);
    const occurrences = await loadOccurrences(requestedOccurrenceIds, tx);
    const authorityEvaluatedAt = new Date().toISOString();
    const frozenOccurrenceIds = occurrences.map((row) => row.occurrenceId).sort();
    const selectionHash = stableCro03aSelectionHash(frozenOccurrenceIds);
    const algorithmIdentityHash = algorithmIdentityHashFor(policy.policy);
    const scopeHash = hashCro03Evidence({ frozenOccurrenceIds, policyId: policy.id, policyHash: policy.policyHash, algorithmIdentityHash });
    const run = resultRows(await tx.execute(sql`
      INSERT INTO cro03a_qualification_runs
        (idempotency_key,actor_id,actor_role,policy_id,policy_hash,scope_hash,frozen_occurrence_ids,
          state,total_count)
      VALUES (${input.idempotencyKey},${input.actorId},${input.actorRole},${policy.id}::uuid,
              ${policy.policyHash},${scopeHash},${JSON.stringify(frozenOccurrenceIds)}::jsonb,
               'queued',${occurrences.length})
      RETURNING id
    `))[0];
    await persistAlgorithmIdentityIfSupported(tx, "cro03a_qualification_runs", String(run.id),
      algorithmIdentityFor(policy.policy), algorithmIdentityHash);
    for (const [ordinal, occurrence] of occurrences.entries()) {
      await tx.execute(sql`
        INSERT INTO cro03a_qualification_items
          (run_id,occurrence_id,ordinal,state,authority_evidence,authority_evaluated_at)
        VALUES (${run.id}::uuid,${occurrence.occurrenceId}::uuid,${ordinal},'queued',
                ${JSON.stringify(occurrence.provenance)}::jsonb,${authorityEvaluatedAt}::timestamptz)
      `);
    }
    await tx.execute(sql`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_key,details,actor_type,actor_id)
      VALUES (${input.actorId},'cro03a_qualification_run_queued','cro03a_qualification_run',
               ${String(run.id)},${JSON.stringify(sanitizeAuditPayload({ total: occurrences.length, selectionHash, algorithmIdentityHash }))}::jsonb,
              'user',${input.actorId})
    `);
    return { id: String(run.id), replayed: false, state: "queued", totalCount: occurrences.length, selectedCount: 0, reviewCount: 0, terminalCount: 0 };
  });
  if (!result.replayed) await enqueueCro03aQualificationRun(result.id);
  return result;
}

type ClaimedQualificationItem = {
  id: string; occurrenceId: string; claimToken: string; executionFence: number;
  runId: string; policyId: string; policyHash: string; actorId: string; evaluatedAsOf: string;
  authorityEvidence: Record<string, unknown>; authorityEvaluatedAt: string;
};

async function claimNextCro03aItem(runId: string): Promise<ClaimedQualificationItem | null> {
  return db.transaction(async (tx) => {
    const run = resultRows(await tx.execute(sql`
       SELECT id,policy_id,policy_hash,actor_id,state,created_at,cancel_requested_at
        FROM cro03a_qualification_runs WHERE id=${runId}::uuid FOR UPDATE
    `))[0];
    if (!run || !["queued", "running"].includes(String(run.state)) || run.cancel_requested_at != null) return null;
    const activeClaim = resultRows(await tx.execute(sql`
      SELECT 1 FROM cro03a_qualification_items
       WHERE run_id=${runId}::uuid AND state='claimed' AND lease_expires_at > NOW()
       LIMIT 1
    `))[0];
    if (activeClaim) return null;
    const item = resultRows(await tx.execute(sql`
      UPDATE cro03a_qualification_items
         SET state='claimed',claim_token=gen_random_uuid(),
             lease_expires_at=NOW()+INTERVAL '2 minutes',
             execution_fence=execution_fence+1,updated_at=NOW()
       WHERE id=(
         SELECT id FROM cro03a_qualification_items
          WHERE run_id=${runId}::uuid
            AND (state='queued' OR (state='claimed' AND lease_expires_at <= NOW()))
          ORDER BY ordinal
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING id,occurrence_id,claim_token,execution_fence,authority_evidence,authority_evaluated_at
    `))[0];
    if (!item) return null;
    await tx.execute(sql`
      UPDATE cro03a_qualification_runs
         SET state='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
       WHERE id=${runId}::uuid AND state IN ('queued','running')
    `);
    return {
      id: String(item.id), occurrenceId: String(item.occurrence_id),
      claimToken: String(item.claim_token), executionFence: Number(item.execution_fence),
      runId, policyId: String(run.policy_id), policyHash: String(run.policy_hash), actorId: String(run.actor_id),
      evaluatedAsOf: new Date(run.created_at).toISOString(),
      authorityEvidence: json(item.authority_evidence),
      authorityEvaluatedAt: new Date(item.authority_evaluated_at).toISOString(),
    };
  });
}

async function reconcileCro03aRun(executor: any, runId: string) {
  const totals = resultRows(await executor.execute(sql`
    SELECT COUNT(*) FILTER (WHERE i.state IN ('completed','cancelled'))::int AS terminal_count,
           COUNT(*) FILTER (WHERE i.state='completed')::int AS completed_count,
           COUNT(*) FILTER (WHERE d.disposition='selected')::int AS selected_count,
           COUNT(*) FILTER (WHERE d.disposition='review_required')::int AS review_count,
           COUNT(*)::int AS total_count
      FROM cro03a_qualification_items i
      LEFT JOIN cro03a_qualification_decisions d ON d.item_id=i.id
     WHERE i.run_id=${runId}::uuid
  `))[0];
  const completed = Number(totals.completed_count) === Number(totals.total_count);
  const terminal = Number(totals.terminal_count) === Number(totals.total_count);
  const updated = resultRows(await executor.execute(sql`
    UPDATE cro03a_qualification_runs
       SET total_count=${Number(totals.total_count)},
           selected_count=${Number(totals.selected_count)},
           review_count=${Number(totals.review_count)},
           terminal_count=${Number(totals.terminal_count)},
           cursor_position=${Number(totals.terminal_count)},
            state=CASE
              WHEN state IN ('queued','running') AND cancel_requested_at IS NOT NULL AND ${terminal} THEN 'cancelled'
              WHEN state IN ('queued','running') AND ${completed} THEN 'completed'
              ELSE state END,
            completed_at=CASE
              WHEN state IN ('queued','running') AND (${completed} OR (cancel_requested_at IS NOT NULL AND ${terminal}))
                THEN COALESCE(completed_at,NOW())
              ELSE completed_at END,
           updated_at=NOW()
     WHERE id=${runId}::uuid
     RETURNING state
  `))[0];
  return String(updated?.state ?? "");
}

async function completeClaimedCro03aItem(claim: ClaimedQualificationItem): Promise<boolean> {
  return db.transaction(async (tx) => {
    const locked = resultRows(await tx.execute(sql`
      SELECT i.id
        FROM cro03a_qualification_items i
        JOIN cro03a_qualification_runs r ON r.id=i.run_id
       WHERE i.id=${claim.id}::uuid AND i.state='claimed'
         AND i.claim_token=${claim.claimToken}::uuid AND i.execution_fence=${claim.executionFence}
         AND i.lease_expires_at > NOW() AND r.state='running'
       FOR UPDATE
    `))[0];
    if (!locked) return false;
    const runRow = resultRows(await tx.execute(sql`
      SELECT frozen_occurrence_ids FROM cro03a_qualification_runs WHERE id=${claim.runId}::uuid
    `))[0];
    const policyRow = resultRows(await tx.execute(sql`
      SELECT id,version,policy_hash,policy FROM cro03a_policy_documents WHERE id=${claim.policyId}::uuid
    `))[0];
    if (!runRow || !policyRow || String(policyRow.policy_hash) !== claim.policyHash) {
      throw new Error("CRO03A_FROZEN_POLICY_INVALID");
    }
    const frozenIds = json<string[]>(runRow.frozen_occurrence_ids);
    let occurrences = await loadOccurrences(frozenIds, tx, { enrichRelationships: false });
    const occurrence = occurrences.find((row) => row.occurrenceId === claim.occurrenceId);
    if (!occurrence) throw new Error("CRO03A_OCCURRENCE_NOT_FOUND");
    occurrence.provenance = { ...occurrence.provenance, ...claim.authorityEvidence, authorityEvaluatedAt: claim.authorityEvaluatedAt };
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"cro03a-subject:" + occurrence.subjectId},0))`);
    occurrences = await loadOccurrences(frozenIds, tx, { enrichRelationships: false });
    const authorityRows = resultRows(await tx.execute(sql`
      SELECT occurrence_id,authority_evidence,authority_evaluated_at
        FROM cro03a_qualification_items WHERE run_id=${claim.runId}::uuid
    `));
    const authorityByOccurrence = new Map(authorityRows.map((row) => [
      String(row.occurrence_id),
      { evidence: json<Record<string, unknown>>(row.authority_evidence), at: new Date(row.authority_evaluated_at).toISOString() },
    ]));
    for (const frozenOccurrence of occurrences) {
      const authority = authorityByOccurrence.get(frozenOccurrence.occurrenceId);
      if (authority) frozenOccurrence.provenance = {
        ...frozenOccurrence.provenance, ...authority.evidence, authorityEvaluatedAt: authority.at,
      };
    }
    const priorHandoff = resultRows(await tx.execute(sql`
      SELECT id FROM cro03a_handoffs
       WHERE source_type=${occurrence.subjectType} AND source_system=${occurrence.sourceSystem}
         AND source_key=${occurrence.subjectKey} LIMIT 1
    `))[0];
    if (priorHandoff) {
      const currentOccurrence = occurrences.find((row) => row.occurrenceId === claim.occurrenceId);
      if (currentOccurrence) currentOccurrence.provenance.priorSelectedHandoff = true;
    }
    const policy: ActivePolicy = {
      id: String(policyRow.id), version: Number(policyRow.version),
      policyHash: String(policyRow.policy_hash), policy: json(policyRow.policy), controlVersion: 0,
    };
    const frozen = evaluateOccurrenceSet(occurrences, policy, claim.evaluatedAsOf)
      .find((row) => row.occurrence.occurrenceId === claim.occurrenceId);
    if (!frozen) throw new Error("CRO03A_OCCURRENCE_NOT_FOUND");
    const { evaluation } = frozen;
    const decisionSelectionHash = hashCro03Evidence({
      occurrenceIds: [occurrence.occurrenceId], payloadHash: occurrence.payloadHash,
      policyId: policy.id, policyHash: policy.policyHash, disposition: evaluation.disposition,
      algorithmIdentityHash: algorithmIdentityHashFor(policy.policy),
      score: evaluation.score, components: evaluation.fitComponents,
    });
    const algorithmIdentity = algorithmIdentityFor(policy.policy);
    const algorithmIdentityHash = algorithmIdentityHashFor(policy.policy);
    const decision = resultRows(await tx.execute(sql`
      INSERT INTO cro03a_qualification_decisions
        (item_id,run_id,occurrence_id,disposition,score,geography_result,vertical_result,
         active_state_evidence,identity_relationship_evidence,fit_components,reason_codes,
         missing_field_classes,frozen_occurrence_ids,policy_id,policy_version,policy_hash,selection_hash,
         algorithm_identity,algorithm_identity_hash)
      VALUES (${claim.id}::uuid,${claim.runId}::uuid,${occurrence.occurrenceId}::uuid,
              ${evaluation.disposition},${evaluation.score},${JSON.stringify(evaluation.geography)}::jsonb,
              ${JSON.stringify(evaluation.vertical)}::jsonb,${JSON.stringify(evaluation.activeStateEvidence)}::jsonb,
              ${JSON.stringify(evaluation.identityRelationshipEvidence)}::jsonb,
              ${JSON.stringify(evaluation.fitComponents)}::jsonb,${JSON.stringify(evaluation.reasonCodes)}::jsonb,
              ${JSON.stringify(evaluation.missingFieldClasses)}::jsonb,
              ${JSON.stringify([occurrence.occurrenceId])}::jsonb,${policy.id}::uuid,${policy.version},
              ${policy.policyHash},${decisionSelectionHash},
              ${JSON.stringify(algorithmIdentity)}::jsonb,${algorithmIdentityHash})
      ON CONFLICT(item_id) DO NOTHING
      RETURNING id
    `))[0];
    if (!decision) return false;
    if (evaluation.disposition === "selected") {
      await tx.execute(sql`
        INSERT INTO cro03a_handoffs
          (run_id,decision_id,source_type,source_system,source_key,occurrence_ids,
           policy_id,policy_version,policy_hash,reason_codes,missing_field_classes,
           selection_hash,effect_authorized,algorithm_identity,algorithm_identity_hash)
        VALUES (${claim.runId}::uuid,${decision.id}::uuid,${occurrence.subjectType},${occurrence.sourceSystem},
                ${occurrence.subjectKey},${JSON.stringify([occurrence.occurrenceId])}::jsonb,
                ${policy.id}::uuid,${policy.version},${policy.policyHash},
                ${JSON.stringify(evaluation.reasonCodes)}::jsonb,${JSON.stringify(evaluation.missingFieldClasses)}::jsonb,
                ${decisionSelectionHash},FALSE,${JSON.stringify(algorithmIdentity)}::jsonb,${algorithmIdentityHash})
      `);
    }
    const completed = resultRows(await tx.execute(sql`
      UPDATE cro03a_qualification_items
         SET state='completed',claim_token=NULL,lease_expires_at=NULL,updated_at=NOW()
       WHERE id=${claim.id}::uuid AND state='claimed'
         AND claim_token=${claim.claimToken}::uuid AND execution_fence=${claim.executionFence}
       RETURNING id
    `))[0];
    if (!completed) throw new Error("CRO03A_ITEM_FENCE_LOST");
    const state = await reconcileCro03aRun(tx, claim.runId);
    if (state === "completed") {
      await tx.execute(sql`
        INSERT INTO audit_logs(user_id,action,entity_type,entity_key,details,actor_type,actor_id)
         SELECT ${claim.actorId},'cro03a_qualification_run_completed','cro03a_qualification_run',
               ${claim.runId},${JSON.stringify(sanitizeAuditPayload({ reconciled: true }))}::jsonb,'user',${claim.actorId}
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_logs
            WHERE action='cro03a_qualification_run_completed' AND entity_key=${claim.runId}
         )
      `);
    }
    return true;
  });
}

export async function processCro03aQualificationRun(runId: string): Promise<void> {
  for (;;) {
    const claim = await claimNextCro03aItem(runId);
    if (!claim) return;
    if (!await completeClaimedCro03aItem(claim)) return;
  }
}

// ---------------------------------------------------------------------------
// Single-pass batch processor (replaces processCro03aQualificationRun).
//
// Complexity: O(N) queries + O(N) data loaded regardless of population size.
//
// Safety guarantees preserved from the per-item implementation:
//   - Execution fences (claim_token + execution_fence verified before each write)
//   - Lease-based stale-worker denial (15-minute batch lease)
//   - Per-subject advisory locks within each write chunk
//   - Immutable decisions and handoffs (ON CONFLICT DO NOTHING)
//   - Crash recovery: re-run claims stale-claimed + queued remainders
//   - Cancellation: checked before every chunk; queued items cancelled in bulk
//   - Run counter reconciliation after every chunk and at completion
// ---------------------------------------------------------------------------

/**
 * Bulk-load prior-handoff flags for a set of occurrences.
 * Replaces N individual "SELECT id FROM cro03a_handoffs WHERE source_type=… LIMIT 1" queries.
 * Sets occurrence.provenance.priorSelectedHandoff = true for any occurrence whose subject
 * already has a handoff in cro03a_handoffs (from any run, including earlier runs).
 */
async function bulkMarkPriorHandoffs(occurrences: FrozenOccurrence[], executor: any = db): Promise<void> {
  if (!occurrences.length) return;
  const occurrenceIds = occurrences.map((o) => o.occurrenceId);
  // Join through source_subjects so we can filter by occurrence id without building
  // an N-element (type, system, key) tuple literal in the query.
  const priorRows = resultRows(await executor.execute(sql`
    SELECT DISTINCT s.subject_type, s.source_system, s.subject_key
      FROM cro03a_handoffs h
      JOIN cro03_source_subjects s
        ON s.subject_type = h.source_type
       AND s.source_system = h.source_system
       AND s.subject_key   = h.source_key
     WHERE s.id IN (
       SELECT o.source_subject_id
         FROM cro03_source_occurrences o
        WHERE o.id IN (${sql.join(occurrenceIds.map((id) => sql`${id}::uuid`), sql`,`)})
     )
  `));
  if (!priorRows.length) return;
  const priorSet = new Set(priorRows.map((r) => `${r.subject_type}|${r.source_system}|${r.subject_key}`));
  for (const occ of occurrences) {
    if (priorSet.has(`${occ.subjectType}|${occ.sourceSystem}|${occ.subjectKey}`)) {
      occ.provenance.priorSelectedHandoff = true;
    }
  }
}

const BATCH_CHUNK_SIZE = 20;
const BATCH_LEASE_INTERVAL = "15 minutes";

/**
 * Single-pass batch qualification processor.
 *
 * Query profile vs. the legacy per-item loop (N = population size):
 *   Legacy:  2N occurrence loads + N authority-evidence loads + N handoff probes
 *            + N full-set evaluations  →  O(N²) total work
 *   Batch:   1 occurrence load + 1 authority-evidence load + 1 handoff bulk probe
 *            + 1 full-set evaluation + ⌈N/chunk⌉ write transactions  →  O(N) total work
 *
 * Semantic equivalence:
 *   - Same frozen occurrence set, policy, algorithm identity, and evaluatedAsOf timestamp
 *   - Provenance assembled from stored authority_evidence (captured at run-creation time)
 *     plus a single up-to-date prior-handoff scan (mirrors the per-item handoff probe)
 *   - evaluateOccurrenceSet called once in deterministic ordinal order → same duplicate
 *     winner and same dispositions, scores, reason codes, and selection hashes
 */
export async function processCro03aQualificationRunBatch(runId: string): Promise<void> {
  // ── Step 1: Claim all queued (and stale-claimed) items in one shot ─────────
  type BatchMeta = {
    policyId: string; policyHash: string; actorId: string; evaluatedAsOf: string;
    frozenOccurrenceIds: string[];
    items: Array<{
      id: string; occurrenceId: string; claimToken: string; executionFence: number;
      authorityEvidence: Record<string, unknown>; authorityEvaluatedAt: string; ordinal: number;
    }>;
  };

  const meta = await db.transaction(async (tx): Promise<BatchMeta | null> => {
    const run = resultRows(await tx.execute(sql`
      SELECT id,policy_id,policy_hash,actor_id,state,created_at,cancel_requested_at,frozen_occurrence_ids
        FROM cro03a_qualification_runs WHERE id=${runId}::uuid FOR UPDATE
    `))[0];
    if (!run) throw new Error("CRO03A_RUN_NOT_FOUND");
    if (!["queued","running"].includes(String(run.state))) return null;
    // Cancellation requested before any items were claimed: drain all queued items
    // and terminate the run so the state machine reaches 'cancelled'.
    if (run.cancel_requested_at != null) {
      await tx.execute(sql`
        UPDATE cro03a_qualification_items
           SET state='cancelled',claim_token=NULL,lease_expires_at=NULL,updated_at=NOW()
         WHERE run_id=${runId}::uuid AND state='queued'
      `);
      await reconcileCro03aRun(tx, runId);
      return null;
    }

    // Claim queued items and expired-lease claimed items atomically.
    const claimedRows = resultRows(await tx.execute(sql`
      UPDATE cro03a_qualification_items
         SET state='claimed', claim_token=gen_random_uuid(),
             lease_expires_at=NOW()+INTERVAL ${sql.raw(`'${BATCH_LEASE_INTERVAL}'`)},
             execution_fence=execution_fence+1, updated_at=NOW()
       WHERE run_id=${runId}::uuid
         AND (state='queued' OR (state='claimed' AND lease_expires_at <= NOW()))
       RETURNING id,occurrence_id,claim_token,execution_fence,authority_evidence,authority_evaluated_at,ordinal
    `));

    // Transition run to 'running'.
    await tx.execute(sql`
      UPDATE cro03a_qualification_runs
         SET state='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
       WHERE id=${runId}::uuid AND state IN ('queued','running')
    `);

    return {
      policyId: String(run.policy_id), policyHash: String(run.policy_hash),
      actorId: String(run.actor_id),
      evaluatedAsOf: new Date(run.created_at).toISOString(),
      frozenOccurrenceIds: json<string[]>(run.frozen_occurrence_ids),
      items: claimedRows.map((row) => ({
        id: String(row.id), occurrenceId: String(row.occurrence_id),
        claimToken: String(row.claim_token), executionFence: Number(row.execution_fence),
        authorityEvidence: json<Record<string, unknown>>(row.authority_evidence),
        authorityEvaluatedAt: new Date(row.authority_evaluated_at).toISOString(),
        ordinal: Number(row.ordinal),
      })),
    };
  });

  // Nothing to do: run completed, cancelled, or all items already claimed by a live worker.
  if (!meta || !meta.items.length) return;

  const { policyId, policyHash, actorId, evaluatedAsOf, frozenOccurrenceIds } = meta;

  // ── Step 2: Load policy once ────────────────────────────────────────────────
  const policyRow = resultRows(await db.execute(sql`
    SELECT id,version,policy_hash,policy FROM cro03a_policy_documents WHERE id=${policyId}::uuid
  `))[0];
  if (!policyRow || String(policyRow.policy_hash) !== policyHash) throw new Error("CRO03A_FROZEN_POLICY_INVALID");
  const policy: ActivePolicy = {
    id: String(policyRow.id), version: Number(policyRow.version),
    policyHash: String(policyRow.policy_hash), policy: json(policyRow.policy), controlVersion: 0,
  };

  // ── Step 3: Load all frozen occurrences once (no per-item relationship queries) ──
  const allOccurrences = await loadOccurrences(frozenOccurrenceIds, db, { enrichRelationships: false });
  const occurrenceMap = new Map(allOccurrences.map((o) => [o.occurrenceId, o]));

  // ── Step 4: Apply stored authority evidence to every occurrence (one query) ──
  // authority_evidence was captured at run-creation time and contains relationship
  // flags (existingCustomerFlag, doNotContactFlag, openOpportunity, etc.) that were
  // loaded via loadOccurrences(…, { enrichRelationships: true }) at that moment.
  // We merge it into provenance exactly as the per-item path does.
  const allAuthorityRows = resultRows(await db.execute(sql`
    SELECT occurrence_id,authority_evidence,authority_evaluated_at
      FROM cro03a_qualification_items WHERE run_id=${runId}::uuid
  `));
  for (const row of allAuthorityRows) {
    const occ = occurrenceMap.get(String(row.occurrence_id));
    if (occ) {
      occ.provenance = {
        ...occ.provenance,
        ...json<Record<string, unknown>>(row.authority_evidence),
        authorityEvaluatedAt: new Date(row.authority_evaluated_at).toISOString(),
      };
    }
  }

  // ── Step 5: Bulk-load prior-handoff flags (one query, mirrors per-item probe) ──
  // Only check newly-claimed occurrences; completed items already have stable evidence.
  const claimedOccurrenceIds = new Set(meta.items.map((ci) => ci.occurrenceId));
  const claimedOccs = meta.items
    .map((ci) => occurrenceMap.get(ci.occurrenceId))
    .filter((o): o is FrozenOccurrence => !!o);
  await bulkMarkPriorHandoffs(claimedOccs);

  // ── Step 6: Evaluate full frozen occurrence set once in ordinal order ────────
  // frozenOccurrenceIds is sorted alphabetically (same sort used to assign ordinals
  // at run-creation time), so iterating it gives the correct ordinal sequence for
  // DUPLICATE_SUBJECT_IN_RUN deduplication.
  const orderedOccurrences = frozenOccurrenceIds
    .map((id) => occurrenceMap.get(id))
    .filter((o): o is FrozenOccurrence => !!o);
  const allEvaluations = evaluateOccurrenceSet(orderedOccurrences, policy, evaluatedAsOf);

  // Build a lookup from occurrenceId → item (for the write phase).
  const itemByOccurrence = new Map(meta.items.map((ci) => [ci.occurrenceId, ci]));

  // Only persist decisions for newly-claimed items; already-completed items have
  // immutable decisions in the DB.  Preserve ordinal order within the write batches.
  const toPersist = allEvaluations.filter(({ occurrence }) => claimedOccurrenceIds.has(occurrence.occurrenceId));

  // Pre-compute algorithm identity once (same for all items in the run).
  const algorithmIdentity = algorithmIdentityFor(policy.policy);
  const algorithmIdentityHash = algorithmIdentityHashFor(policy.policy);

  // ── Step 7: Persist decisions in bounded, crash-safe chunks ─────────────────
  for (let i = 0; i < toPersist.length; i += BATCH_CHUNK_SIZE) {
    const chunk = toPersist.slice(i, i + BATCH_CHUNK_SIZE);

    await db.transaction(async (tx) => {
      // Check cancellation before every chunk.
      const runCheck = resultRows(await tx.execute(sql`
        SELECT cancel_requested_at FROM cro03a_qualification_runs
         WHERE id=${runId}::uuid FOR UPDATE
      `))[0];
      if (runCheck?.cancel_requested_at != null) {
        await tx.execute(sql`
          UPDATE cro03a_qualification_items
             SET state='cancelled',claim_token=NULL,lease_expires_at=NULL,updated_at=NOW()
           WHERE run_id=${runId}::uuid AND state='claimed'
        `);
        await reconcileCro03aRun(tx, runId);
        return;
      }

      for (const { occurrence, evaluation } of chunk) {
        const item = itemByOccurrence.get(occurrence.occurrenceId);
        if (!item) continue;

        // Per-subject advisory lock prevents concurrent runs writing the same handoff.
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${"cro03a-subject:" + occurrence.subjectId},0))
        `);

        // Verify execution fence — denies stale workers that lost their lease.
        const locked = resultRows(await tx.execute(sql`
          SELECT i.id
            FROM cro03a_qualification_items i
            JOIN cro03a_qualification_runs r ON r.id=i.run_id
           WHERE i.id=${item.id}::uuid AND i.state='claimed'
             AND i.claim_token=${item.claimToken}::uuid
             AND i.execution_fence=${item.executionFence}
             AND i.lease_expires_at > NOW()
             AND r.state='running'
           FOR UPDATE
        `))[0];
        if (!locked) continue; // stale worker or concurrent modification — skip safely

        const decisionSelectionHash = hashCro03Evidence({
          occurrenceIds: [occurrence.occurrenceId], payloadHash: occurrence.payloadHash,
          policyId: policy.id, policyHash: policy.policyHash, disposition: evaluation.disposition,
          algorithmIdentityHash, score: evaluation.score, components: evaluation.fitComponents,
        });

        // Immutable decision — ON CONFLICT is the idempotency guard.
        const decision = resultRows(await tx.execute(sql`
          INSERT INTO cro03a_qualification_decisions
            (item_id,run_id,occurrence_id,disposition,score,geography_result,vertical_result,
             active_state_evidence,identity_relationship_evidence,fit_components,reason_codes,
             missing_field_classes,frozen_occurrence_ids,policy_id,policy_version,policy_hash,
             selection_hash,algorithm_identity,algorithm_identity_hash)
          VALUES (${item.id}::uuid,${runId}::uuid,${occurrence.occurrenceId}::uuid,
                  ${evaluation.disposition},${evaluation.score},
                  ${JSON.stringify(evaluation.geography)}::jsonb,
                  ${JSON.stringify(evaluation.vertical)}::jsonb,
                  ${JSON.stringify(evaluation.activeStateEvidence)}::jsonb,
                  ${JSON.stringify(evaluation.identityRelationshipEvidence)}::jsonb,
                  ${JSON.stringify(evaluation.fitComponents)}::jsonb,
                  ${JSON.stringify(evaluation.reasonCodes)}::jsonb,
                  ${JSON.stringify(evaluation.missingFieldClasses)}::jsonb,
                  ${JSON.stringify([occurrence.occurrenceId])}::jsonb,
                  ${policy.id}::uuid,${policy.version},${policy.policyHash},
                  ${decisionSelectionHash},
                  ${JSON.stringify(algorithmIdentity)}::jsonb,${algorithmIdentityHash})
          ON CONFLICT(item_id) DO NOTHING
          RETURNING id
        `))[0];

        // Immutable handoff — only for selected occurrences; advisory lock prevents duplicate.
        if (evaluation.disposition === "selected" && decision) {
          await tx.execute(sql`
            INSERT INTO cro03a_handoffs
              (run_id,decision_id,source_type,source_system,source_key,occurrence_ids,
               policy_id,policy_version,policy_hash,reason_codes,missing_field_classes,
               selection_hash,effect_authorized,algorithm_identity,algorithm_identity_hash)
            VALUES (${runId}::uuid,${decision.id}::uuid,
                    ${occurrence.subjectType},${occurrence.sourceSystem},${occurrence.subjectKey},
                    ${JSON.stringify([occurrence.occurrenceId])}::jsonb,
                    ${policy.id}::uuid,${policy.version},${policy.policyHash},
                    ${JSON.stringify(evaluation.reasonCodes)}::jsonb,
                    ${JSON.stringify(evaluation.missingFieldClasses)}::jsonb,
                    ${decisionSelectionHash},FALSE,
                    ${JSON.stringify(algorithmIdentity)}::jsonb,${algorithmIdentityHash})
            ON CONFLICT DO NOTHING
          `);
        }

        // Mark item completed — execution fence protects against double-write.
        await tx.execute(sql`
          UPDATE cro03a_qualification_items
             SET state='completed',claim_token=NULL,lease_expires_at=NULL,updated_at=NOW()
           WHERE id=${item.id}::uuid AND state='claimed'
             AND claim_token=${item.claimToken}::uuid
             AND execution_fence=${item.executionFence}
        `);
      }

      // Reconcile counters after every chunk so polling sees live progress.
      await reconcileCro03aRun(tx, runId);
    });
  }

  // ── Step 8: Final reconcile + completion audit log ───────────────────────────
  await db.transaction(async (tx) => {
    const state = await reconcileCro03aRun(tx, runId);
    if (state === "completed") {
      await tx.execute(sql`
        INSERT INTO audit_logs(user_id,action,entity_type,entity_key,details,actor_type,actor_id)
         SELECT ${actorId},'cro03a_qualification_run_completed','cro03a_qualification_run',
               ${runId},${JSON.stringify(sanitizeAuditPayload({ reconciled: true, batchMode: true }))}::jsonb,'user',${actorId}
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_logs
            WHERE action='cro03a_qualification_run_completed' AND entity_key=${runId}
         )
      `);
    }
  });
}

/** Queue-worker entrypoint.  It is safe to retry: item claims and fences own effects. */
export async function processCro03aQualificationRunQueueSafe(runId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("CRO03A_INVALID_RUN_ID");
  await processCro03aQualificationRunBatch(runId);
}

/** Recovery entrypoint for the queue's periodic sweep; it never steals live leases. */
export async function recoverCro03aQualificationRunsQueueSafe(): Promise<void> {
  const runs = resultRows(await db.execute(sql`
    SELECT id FROM cro03a_qualification_runs
     WHERE state IN ('queued','running')
     ORDER BY created_at,id
     LIMIT 100
  `));
  for (const run of runs) await processCro03aQualificationRunQueueSafe(String(run.id));
}

async function enqueueCro03aQualificationRun(runId: string): Promise<void> {
  // Non-fatal: the run row is already durable in the DB.  If BullMQ or Redis is
  // unavailable, the scheduled recurring tick will claim queued runs on the next
  // cycle.  Never let a queue-layer failure cause the HTTP route to return
  // CRO03_REQUEST_FAILED when the run was successfully created.
  try {
    const { getQueueManagerProducers, QUEUE_NAMES } = await import("../queue-manager");
    const queue = getQueueManagerProducers()?.getQueue(QUEUE_NAMES.CRO03A_QUALIFICATION);
    if (queue) await queue.add("run", { runId }, { jobId: `cro03a-qualification:${runId}` });
  } catch (enqueueErr: any) {
    console.warn("[CRO03A] enqueueCro03aQualificationRun: queue unavailable — run is durable and will be picked up by the scheduler:", enqueueErr?.message);
  }
}

export async function getCro03aRun(runId: string, actorId: string, role: string) {
  let run = resultRows(await db.execute(sql`
    SELECT id,actor_id,state,total_count,selected_count,review_count,terminal_count,
           cursor_position,created_at,completed_at,cancel_requested_at
      FROM cro03a_qualification_runs WHERE id=${runId}::uuid
  `))[0];
  if (!run || (role !== "admin" && String(run.actor_id) !== actorId)) return null;
  const decisions = resultRows(await db.execute(sql`
    SELECT d.id,d.disposition,d.score,d.reason_codes,d.missing_field_classes,d.selection_hash,
           s.subject_type,s.source_system,encode(sha256(s.subject_key::bytea),'hex') AS source_key_hash,
           h.id AS handoff_id,h.effect_authorized
      FROM cro03a_qualification_decisions d
      JOIN cro03_source_occurrences o ON o.id=d.occurrence_id
      JOIN cro03_source_subjects s ON s.id=o.source_subject_id
      LEFT JOIN cro03a_handoffs h ON h.decision_id=d.id
     WHERE d.run_id=${runId}::uuid ORDER BY d.created_at,d.id
  `));
  return {
    id: String(run.id), state: run.state, totalCount: Number(run.total_count),
    selectedCount: Number(run.selected_count), reviewCount: Number(run.review_count),
    terminalCount: Number(run.terminal_count), cursorPosition: Number(run.cursor_position),
    createdAt: run.created_at, completedAt: run.completed_at, cancelRequestedAt: run.cancel_requested_at,
    decisions: decisions.map((row) => ({
      id: row.id, disposition: row.disposition, score: Number(row.score),
      reasonCodes: json(row.reason_codes), missingFieldClasses: json(row.missing_field_classes),
      selectionHash: row.selection_hash,
      source: { type: row.subject_type, system: row.source_system, keyHash: row.source_key_hash },
      handoff: row.handoff_id ? { id: row.handoff_id, effectAuthorized: false } : null,
    })),
  };
}

export async function cancelCro03aRun(runId: string, actorId: string, role: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const result = resultRows(await tx.execute(sql`
       UPDATE cro03a_qualification_runs
          SET cancel_requested_at=COALESCE(cancel_requested_at,NOW()),updated_at=NOW()
       WHERE id=${runId}::uuid AND state IN ('queued','running')
         AND (${role === "admin"} OR actor_id=${actorId})
       RETURNING id
    `))[0];
    if (!result) return false;
    await tx.execute(sql`
      UPDATE cro03a_qualification_items
          SET state='cancelled',claim_token=NULL,lease_expires_at=NULL,updated_at=NOW()
        WHERE run_id=${runId}::uuid AND state='queued'
    `);
    await reconcileCro03aRun(tx, runId);
    return true;
  });
}

export async function activateCro03aPolicy(input: {
  policyId: string; expectedVersion: number; reason: string; actorId: string;
}) {
  if (input.reason.trim().length < 8) throw new Error("CRO03A_ACTIVATION_REASON_REQUIRED");
  return db.transaction(async (tx) => {
    const policy = resultRows(await tx.execute(sql`
      SELECT id,policy_key,version,policy_hash,policy,status
        FROM cro03a_policy_documents WHERE id=${input.policyId}::uuid
    `))[0];
    if (!policy) throw new Error("CRO03A_POLICY_NOT_FOUND");
    const document = json<Record<string, any>>(policy.policy);
    if (policy.policy_key !== "south_florida_candidate_qualification" ||
        !["draft", "active"].includes(String(policy.status)) ||
        hashCro03Evidence(document) !== String(policy.policy_hash) ||
        document.geographyReferenceVersion !== "south-florida-fips-v1" ||
        document.verticalAlgorithmVersion !== "v1" ||
        document.subverticalMapVersion !== "1" ||
         !["fit-v1", "fit-v2"].includes(String(document.fitVersion)) ||
        !Array.isArray(document.targetVerticals) ||
        !["Auto", "Healthcare", "Salon/Spa"].every((value) => document.targetVerticals.includes(value))) {
      throw new Error("CRO03A_POLICY_INCOMPATIBLE");
    }
    const changed = resultRows(await tx.execute(sql`
      UPDATE cro03a_policy_control
         SET active_policy_id=${input.policyId}::uuid,expected_version=expected_version+1,
             updated_by=${input.actorId},updated_at=NOW()
       WHERE id=1 AND expected_version=${input.expectedVersion}
       RETURNING expected_version
    `))[0];
    if (!changed) throw new Error("CRO03A_POLICY_VERSION_CONFLICT");
    await tx.execute(sql`
      INSERT INTO audit_logs(user_id,action,entity_type,entity_key,details,actor_type,actor_id)
      VALUES (${input.actorId},'cro03a_policy_activated','cro03a_policy',${input.policyId},
              ${JSON.stringify(sanitizeAuditPayload({ reason: input.reason.trim(), policyVersion: Number(policy.version), policyHash: String(policy.policy_hash), previousControlVersion: input.expectedVersion }))}::jsonb,
              'user',${input.actorId})
    `);
    return { policyId: input.policyId, controlVersion: Number(changed.expected_version), policyVersion: Number(policy.version), policyHash: String(policy.policy_hash) };
  });
}

export async function getCro03aSourceCensus(filters?: {
  countyFips?: string[];
  vertical?: string[];
  sourceType?: string[];
}) {
  const [policy, staged] = await Promise.all([getActivePolicy(), db.execute(sql`
    SELECT source_system,subject_type,COUNT(*)::int AS count
      FROM cro03_source_subjects GROUP BY source_system,subject_type ORDER BY source_system,subject_type
  `)]);
  const stagedRows = resultRows(staged);

  // Build a filtered count from cro03_source_observations using filter params
  let filteredCount: number | null = null;
  let filteredSample: any[] = [];
  const hasFilters = (filters?.countyFips?.length ?? 0) > 0
    || (filters?.vertical?.length ?? 0) > 0
    || (filters?.sourceType?.length ?? 0) > 0;

  if (hasFilters) {
    // Build conditions dynamically. All payload probes use JSONB operators.
    const conditions: string[] = ["1=1"];
    const params: unknown[] = [];
    let idx = 1;

    if (filters?.sourceType?.length) {
      conditions.push(`s.subject_type = ANY($${idx}::text[])`);
      params.push(filters.sourceType);
      idx++;
    }
    if (filters?.countyFips?.length) {
      // county_fips may live in the observation payload as an explicit field.
      // Only check the explicit stored fields — do NOT add a broad FL-state fallback
      // here because city/ZIP → FIPS resolution requires in-process evaluation that
      // cannot be expressed accurately in SQL without embedding the full ZIP/city maps.
      // A broad fallback would include Tampa, Orlando, and other non-target areas.
      conditions.push(`(
        v.payload->>'countyFips' = ANY($${idx}::text[])
        OR v.payload->>'county_fips' = ANY($${idx}::text[])
      )`);
      params.push(filters.countyFips);
      idx++;
    }
    if (filters?.vertical?.length) {
      conditions.push(`(
        lower(v.payload->>'vertical') = ANY($${idx}::text[])
        OR lower(v.payload->>'industry') = ANY($${idx}::text[])
      )`);
      params.push(filters.vertical.map((v) => v.toLowerCase()));
      idx++;
    }

    const whereClause = conditions.join(" AND ");
    // Use pg pool directly for parameterized dynamic queries (sql.raw does not support params)
    const countResult = (await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM cro03_source_subjects s
         JOIN cro03_source_occurrences o ON o.source_subject_id = s.id
         JOIN cro03_source_observations v ON v.id = o.source_observation_id
        WHERE ${whereClause}`,
      params,
    )).rows;
    filteredCount = Number(countResult[0]?.total ?? 0);

    const sampleResult = (await pool.query(
      `SELECT s.subject_type, s.source_system,
              encode(sha256(s.subject_key::bytea),'hex') AS source_key_hash,
              o.source_observed_at
         FROM cro03_source_subjects s
         JOIN cro03_source_occurrences o ON o.source_subject_id = s.id
         JOIN cro03_source_observations v ON v.id = o.source_observation_id
        WHERE ${whereClause}
        ORDER BY o.source_observed_at DESC
        LIMIT 25`,
      params,
    )).rows;
    filteredSample = sampleResult;
  }

  const candidates = hasFilters ? filteredSample : resultRows(await db.execute(sql`
    SELECT DISTINCT ON (s.id)
           o.id AS occurrence_id,s.subject_type,s.source_system,
           encode(sha256(s.subject_key::bytea),'hex') AS source_key_hash,
           o.source_observed_at
      FROM cro03_source_occurrences o
      JOIN cro03_source_subjects s ON s.id=o.source_subject_id
     WHERE s.subject_type IN ('prospect','sunbiz_entity','sdr_merchant','provider_csv_row','lead_discovery_result','master_lead')
      ORDER BY s.id,o.source_observed_at DESC,o.ingested_at DESC,o.id DESC
     LIMIT 100
  `));

  return {
    policyVersion: policy.version,
    activePolicyHash: policy.policyHash,
    activeAlgorithmIdentityHash: algorithmIdentityHashFor(policy.policy),
    sources: CRO03A_SOURCE_CENSUS.map((source) => ({
      source, stagedCount: stagedRows.filter((row) => String(row.source_system) === source).reduce((sum, row) => sum + Number(row.count), 0),
    })),
    candidates: (hasFilters ? filteredSample : candidates).map((row) => ({
      occurrenceId: row.occurrence_id ?? null, sourceType: row.subject_type, sourceSystem: row.source_system,
      sourceKeyHash: row.source_key_hash, sourceObservedAt: row.source_observed_at,
    })),
    ...(hasFilters ? { filteredCount, appliedFilters: filters } : {}),
    excludedSourceTypes: ["contacts", "businesses", "companies", "deals", "opportunities", "cr04", "cr06", "ghl"],
  };
}

export async function stageCro03aSourceCensus(input: {
  actorId: string;
  limitPerSource?: number;
  /** Called after each microbatch of items so the route can persist a heartbeat. */
  onProgress?: (p: { completed: number; total: number; currentStage: string }) => Promise<void> | void;
}) {
  const limit = Math.max(1, Math.min(input.limitPerSource ?? 10, 500));
  const policy = await getActivePolicy();
  const cursorFor = async (source: string, table: string, kind: "number" | "uuid" = "number") => {
    // NOWAIT: if a concurrent census run holds the cursor lock, skip this source
    // rather than blocking the entire staging run indefinitely.
    const LOCKED_SENTINEL = { locked: true as const, value: 0, highWater: 0, valueText: "", highWaterText: "", snapshotKey: `locked:${source}` };
    try {
      return await db.transaction(async (tx) => {
        // SET lock_timeout inside the transaction so the FOR UPDATE NOWAIT
        // error message is consistent across Postgres versions.
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    let cursor = resultRows(await tx.execute(sql`
      SELECT * FROM cro03a_census_cursors WHERE source_system=${source} FOR UPDATE NOWAIT
    `))[0];
    const exhausted = kind === "uuid"
      ? !cursor || String(cursor.cursor_value_text ?? "") >= String(cursor.snapshot_high_water_text ?? "")
      : !cursor || Number(cursor.cursor_value) >= Number(cursor.snapshot_high_water);
    if (exhausted) {
      const rawMaximum = resultRows(await tx.execute(sql.raw(kind === "uuid"
        ? `SELECT COALESCE(MAX(id::text),'') AS high_water FROM "${table}"`
        : `SELECT COALESCE(MAX(id),0)::bigint AS high_water FROM "${table}"`)))[0]?.high_water;
      const maximum = kind === "uuid" ? String(rawMaximum ?? "") : Number(rawMaximum ?? 0);
      const snapshotKey = `cro03a:${source}:${maximum}:${policy.policyHash}`;
      cursor = resultRows(await tx.execute(sql`
        INSERT INTO cro03a_census_cursors
          (source_system,snapshot_key,snapshot_high_water,cursor_value,snapshot_high_water_text,cursor_value_text,
           policy_id,policy_hash,updated_by)
        VALUES (${source},${snapshotKey},${kind === "uuid" ? 0 : Number(maximum)},0,
                ${kind === "uuid" ? String(maximum) : null},${kind === "uuid" ? "" : null},
                ${policy.id}::uuid,${policy.policyHash},${input.actorId})
        ON CONFLICT(source_system) DO UPDATE SET
          snapshot_key=EXCLUDED.snapshot_key,snapshot_high_water=EXCLUDED.snapshot_high_water,
          cursor_value=0,snapshot_high_water_text=EXCLUDED.snapshot_high_water_text,
          cursor_value_text=EXCLUDED.cursor_value_text,policy_id=EXCLUDED.policy_id,policy_hash=EXCLUDED.policy_hash,
          updated_by=EXCLUDED.updated_by,updated_at=NOW()
        RETURNING *
      `))[0];
    }
    return {
      locked: false as const,
      value: Number(cursor.cursor_value), highWater: Number(cursor.snapshot_high_water),
      valueText: String(cursor.cursor_value_text ?? ""), highWaterText: String(cursor.snapshot_high_water_text ?? ""),
      snapshotKey: String(cursor.snapshot_key),
    };
      }); // end db.transaction
    } catch (err: any) {
      // Lock not available (NOWAIT / lock_timeout) — skip this source for this run.
      if (/lock.*not available|could not obtain lock|lock timeout/i.test(err?.message ?? "")) {
        console.warn(`[CensusStage] Cursor for "${source}" is locked by another process — skipping source this run`);
        return LOCKED_SENTINEL;
      }
      throw err;
    }
  }; // end cursorFor

  const cursors = {
    prospects: await cursorFor("prospects", "prospects"),
    sunbiz: await cursorFor("sunbiz_entities", "sunbiz_entities"),
    merchants: await cursorFor("sdr_merchants", "sdr_merchants"),
    discovery: await cursorFor("lead_discovery_results", "lead_discovery_results"),
    master: await cursorFor("master_leads", "master_leads", "uuid"),
  };
  // Collect names of sources that were skipped due to cursor lock contention.
  const skippedLocked: string[] = Object.entries(cursors)
    .filter(([, c]) => c.locked)
    .map(([src]) => src);

  const [prospectRows, sunbizRows, merchantRows, discoveryRows, masterRows] = await Promise.all([
    cursors.prospects.locked ? Promise.resolve([]) : db.select().from(prospects).where(and(gt(prospects.id, cursors.prospects.value), lte(prospects.id, cursors.prospects.highWater))).orderBy(prospects.id).limit(limit),
    cursors.sunbiz.locked ? Promise.resolve([]) : db.select().from(sunbizEntities).where(and(gt(sunbizEntities.id, cursors.sunbiz.value), lte(sunbizEntities.id, cursors.sunbiz.highWater))).orderBy(sunbizEntities.id).limit(limit),
    cursors.merchants.locked ? Promise.resolve([]) : db.select().from(sdrMerchants).where(and(gt(sdrMerchants.id, cursors.merchants.value), lte(sdrMerchants.id, cursors.merchants.highWater))).orderBy(sdrMerchants.id).limit(limit),
    cursors.discovery.locked ? Promise.resolve([]) : db.select().from(leadDiscoveryResults).where(and(gt(leadDiscoveryResults.id, cursors.discovery.value), lte(leadDiscoveryResults.id, cursors.discovery.highWater))).orderBy(leadDiscoveryResults.id).limit(limit),
    // uuid cursors: empty-string sentinels are not valid uuid literals, so they must
    // never be passed into a uuid-column comparison. An empty highWaterText means the
    // source table had zero rows at snapshot time — nothing to fetch. An empty
    // valueText means scanning has not started yet — omit the lower bound instead of
    // comparing against ''.
    (cursors.master.locked || !cursors.master.highWaterText) ? Promise.resolve([]) : db.select().from(masterLeads).where(and(
      ...(cursors.master.valueText ? [gt(masterLeads.id, cursors.master.valueText)] : []),
      lte(masterLeads.id, cursors.master.highWaterText),
      isNull(masterLeads.canonicalLeadId),
      isNull(masterLeads.duplicateOfId),
      isNull(masterLeads.promotedAt),
      inArray(masterLeads.status, ["staged", "imported", "needs_website_check", "needs_mx_verification", "ready_for_internal_test"]),
    )).orderBy(masterLeads.id).limit(limit),
  ]);
  const drafts: Cro03aSourceDraft[] = [
    ...prospectRows.map((row) => prospectSourceSubject(row as any)),
    ...sunbizRows.map((row) => sunbizSourceSubject(row as any)),
    ...merchantRows.map((row) => sdrMerchantSourceSubject(row as any)),
    ...discoveryRows.map((row) => leadDiscoverySourceSubject(row as any) ?? linkedDiscoveryEvidence(row as any)).filter((row): row is Cro03aSourceDraft => !!row),
    ...masterRows.map((row) => masterLeadSourceSubject(row as any)),
  ];
  // A census reports only attested source observations.  Do not manufacture a
  // freshness timestamp or event key: doing so changes source identity.
  const stageableDrafts = drafts.filter((draft) => !!draft.sourceObservedAt && !!draft.sourceEventKey);
  let created = 0;
  let replayed = 0;
  // Emit a heartbeat every HEARTBEAT_BATCH items so the route can persist
  // a lastHeartbeat timestamp.  Stall detection uses this timestamp, not
  // elapsed wall-clock time, so a slow-but-healthy run is never falsely killed.
  const HEARTBEAT_BATCH = 5;
  const totalItems = stageableDrafts.length;
  for (let i = 0; i < stageableDrafts.length; i++) {
    const draft = stageableDrafts[i];
    const result = await createCro03SourceBatch({
      // Key incorporates a stable payload fingerprint so a changed payload for the
    // same event key receives a fresh key instead of colliding with the original batch.
    // Exact retries (identical payload) produce the same hash → replayed.
    // Changed payloads produce a different hash → new batch, no collision.
    idempotencyKey: `cro03a-census:${draft.subjectType}:${draft.sourceSystem}:${draft.sourceEventKey}:${hashCro03Evidence(draft.payload).slice(0, 16)}`,
      actorType: "user", actorId: input.actorId, purpose: "staging_review",
      subjects: [draft],
    });
    result.replayed ? replayed++ : created++;
    const completed = i + 1;
    if (completed % HEARTBEAT_BATCH === 0 || completed === totalItems) {
      try {
        await input.onProgress?.({
          completed,
          total: totalItems,
          currentStage: `processing item ${completed}/${totalItems}`,
        });
      } catch { /* non-fatal — heartbeat failure must not abort staging */ }
    }
  }
  // Only advance cursors for sources that were not locked — locked sources keep
  // their current position so the next census run retries them.
  const advances = [
    ["prospects", prospectRows.at(-1)?.id ?? cursors.prospects.highWater, cursors.prospects.locked],
    ["sunbiz", sunbizRows.at(-1)?.id ?? cursors.sunbiz.highWater, cursors.sunbiz.locked],
    ["merchants", merchantRows.at(-1)?.id ?? cursors.merchants.highWater, cursors.merchants.locked],
    ["discovery", discoveryRows.at(-1)?.id ?? cursors.discovery.highWater, cursors.discovery.locked],
    ["master", masterRows.at(-1)?.id ?? cursors.master.highWaterText, cursors.master.locked],
  ] as const;
  await db.transaction(async (tx) => {
    for (const [source, value, locked] of advances) {
      if (locked) continue; // Don't advance a cursor we couldn't lock
      await tx.execute(sql`
        UPDATE cro03a_census_cursors
           SET cursor_value=CASE WHEN snapshot_high_water_text IS NULL THEN ${Number(value) || 0} ELSE cursor_value END,
               cursor_value_text=CASE WHEN snapshot_high_water_text IS NOT NULL THEN ${String(value)} ELSE cursor_value_text END,
               updated_at=NOW()
         WHERE source_system=${source}
      `);
    }
  });
  return {
    created, replayed, total: stageableDrafts.length, skippedUnattested: drafts.length - stageableDrafts.length,
    skippedLocked: skippedLocked.length > 0 ? skippedLocked : undefined,
    sourceResults: {
      prospects: prospectRows.length, sunbiz_entities: sunbizRows.length,
      sdr_merchants: merchantRows.length, lead_discovery_results: discoveryRows.length,
      master_leads: masterRows.length,
      provider_csv_rows: "existing_import_adapter",
      public_web: "existing_persisted_observations_only",
    },
    effectsAuthorized: false,
    snapshots: Object.fromEntries(Object.entries(cursors).map(([source, cursor]) => [source, cursor.snapshotKey])),
  };
}
// ── CRO-03A Qualification Command Outbox Processor ───────────────────────────
// System actor ID used for auto-wired qualification runs from the source registry.
const CRO03A_AUTOWIRE_ACTOR_ID = "system:cro03a-autowire";

/**
 * Polls cro03a_qualification_commands WHERE state='pending', claims each row
 * with FOR UPDATE SKIP LOCKED, calls createCro03aQualificationRun() for each
 * chunk, and marks the command completed or failed. Safe to call concurrently —
 * SKIP LOCKED prevents double-processing.
 */
export async function processOutboxCro03aQualificationCommands(): Promise<{ processed: number; failed: number }> {
  let processed = 0;
  let failed = 0;

  // Table may not exist yet (rolling upgrade — feature-detect before querying).
  try {
    const tableCheck = resultRows(await db.execute(sql`
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'cro03a_qualification_commands'
       LIMIT 1
    `));
    if (tableCheck.length === 0) return { processed: 0, failed: 0 };
  } catch {
    return { processed: 0, failed: 0 };
  }

  // Recover stale 'processing' rows: a worker that claimed a command and then
  // crashed leaves it in 'processing' indefinitely. Reset any row that has been
  // processing for more than 30 minutes so the next sweep can reclaim it.
  // Bounded retries: after 3 failures (tracked in error_text) we leave the row
  // as 'failed' so it no longer blocks the watchdog's stale-occurrence alert.
  try {
    // Historical geography-filtered commands never received row outcomes.
    // Reuse their genuine occurrence IDs; do not fabricate another import.
    await db.execute(sql`
      UPDATE cro03a_qualification_commands
         SET state='pending',claimed_at=NULL,processed_at=NULL,
             error_text='CANONICAL_OUTBOX_REPLAY:' || error_text
       WHERE id IN(SELECT id FROM cro03a_qualification_commands
         WHERE state='completed' AND error_text LIKE 'geography_pre_filter:%'
         ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED)
    `);
    await db.execute(sql`
      UPDATE cro03a_qualification_commands
         SET state = CASE
               WHEN error_text LIKE 'RETRY:3:%' THEN 'failed'
               WHEN error_text LIKE 'RETRY:2:%' THEN 'pending'
               WHEN error_text LIKE 'RETRY:1:%' THEN 'pending'
               ELSE 'pending'
             END,
             claimed_at = NULL,
             error_text = CASE
               WHEN error_text LIKE 'RETRY:3:%' THEN error_text
               WHEN error_text LIKE 'RETRY:2:%' THEN 'RETRY:3:' || COALESCE(error_text, '')
               WHEN error_text LIKE 'RETRY:1:%' THEN 'RETRY:2:' || COALESCE(error_text, '')
               ELSE                                   'RETRY:1:' || COALESCE(error_text, '')
             END
       WHERE state = 'processing'
         AND claimed_at < NOW() - INTERVAL '30 minutes'
    `);
  } catch {
    // Non-fatal: continue to process pending rows even if recovery fails
  }

  // Claim up to 10 pending commands per sweep to bound each invocation's runtime.
  const pending = resultRows(await db.execute(sql`
    SELECT id, source_import_run_id, chunk_number, selection_hash, occurrence_ids
      FROM cro03a_qualification_commands
     WHERE state = 'pending'
     ORDER BY created_at
     LIMIT 10
     FOR UPDATE SKIP LOCKED
  `));

  for (const row of pending) {
    const cmdId = String(row.id);
    let claimStamp: string | null = null;
    try {
      // Claim: transition pending → processing, stamping claimed_at for stale-recovery.
      const claimed = resultRows(await db.execute(sql`
        UPDATE cro03a_qualification_commands
           SET state = 'processing', claimed_at = NOW()
         WHERE id = ${cmdId}::uuid AND state = 'pending'
         RETURNING id,claimed_at::text AS claim_stamp
      `))[0];
      if (!claimed) continue; // race — another processor claimed it first
      claimStamp=String(claimed.claim_stamp);

      const occurrenceIds: string[] = (typeof row.occurrence_ids === "string"
        ? JSON.parse(row.occurrence_ids)
        : row.occurrence_ids) as string[];

      if (!occurrenceIds.length) {
        const completed=resultRows(await db.execute(sql`
          UPDATE cro03a_qualification_commands
             SET state = 'completed', processed_at = NOW()
           WHERE id = ${cmdId}::uuid AND state='processing' AND claimed_at::text=${claimStamp}
           RETURNING id
        `));
        processed+=completed.length;
        continue;
      }

      // Geography remains qualification policy, not source membership. Every
      // retained occurrence receives its own decision, including outside and
      // unknown geography. Version the key so old subset runs remain immutable.
      const runIdempotencyKey = `cro03a-autowire:${String(row.source_import_run_id)}:chunk:${Number(row.chunk_number)}:${String(row.selection_hash).slice(0, 16)}:all-v1`;
      await createCro03aQualificationRun({
        idempotencyKey: runIdempotencyKey,
        occurrenceIds,
        actorId: CRO03A_AUTOWIRE_ACTOR_ID,
        actorRole: "admin",
      });

      const completed=resultRows(await db.execute(sql`
        UPDATE cro03a_qualification_commands
           SET state = 'completed', processed_at = NOW()
         WHERE id = ${cmdId}::uuid AND state='processing' AND claimed_at::text=${claimStamp}
         RETURNING id
      `));
      processed+=completed.length;
    } catch (err: any) {
      console.error(`[CRO03A Outbox] Failed to process command ${cmdId}:`, err?.message);
      try {
        if (claimStamp===null) continue;
        const rejected=resultRows(await db.execute(sql`
          UPDATE cro03a_qualification_commands
             SET state = 'failed',
                 error_text = ${String(err?.message ?? "unknown").slice(0, 1000)},
                 processed_at = NOW()
           WHERE id = ${cmdId}::uuid AND state='processing' AND claimed_at::text=${claimStamp}
           RETURNING id
        `));
        failed+=rejected.length;
      } catch {
        // Non-fatal: swallow secondary failure
      }
    }
  }

  return { processed, failed };
}

// ── CRO-03A Stale-Occurrence Watchdog ────────────────────────────────────────

/**
 * Watchdog: queries for source_import_runs that completed > 48h ago and still have
 * provider_csv_row occurrences with no qualification decision. Distinguishes
 * never-enqueued, queued, running, failed, and decided states.
 * Writes a rate-limited audit_logs entry (one per run per day) for each stale run.
 * Does NOT block deployment.
 */
export async function watchdogCro03aStaleOccurrences(): Promise<{
  staleRunCount: number; alertsWritten: number;
}> {
  // Feature-detect both tables required for the watchdog.
  try {
    const tableCheck = resultRows(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('cro03a_qualification_commands', 'source_import_runs')
    `));
    if (tableCheck.length < 2) return { staleRunCount: 0, alertsWritten: 0 };
  } catch {
    return { staleRunCount: 0, alertsWritten: 0 };
  }

  // Find completed imports > 48h old that still have undecided provider_csv_row
  // occurrences. Occurrences are scoped to their specific run via source_event_key:
  // the import-runner sets sourceEventKey = `${adapterKey}:${stableKey}:${runId}`,
  // so the LIKE pattern `adapterKey || ':%:' || runId` uniquely identifies all
  // occurrences that belong to exactly this run (no cross-run contamination).
  const staleRuns = resultRows(await db.execute(sql`
    SELECT sir.id AS run_id,
           sir.completed_at,
           sir.adapter_key,
           COUNT(o.id)::int AS undecided_count
      FROM source_import_runs sir
      JOIN cro03_source_subjects s
           ON s.source_system = sir.adapter_key
          AND s.subject_type = 'provider_csv_row'
      JOIN cro03_source_occurrences o
           ON o.source_subject_id = s.id
          AND o.source_event_key LIKE sir.adapter_key || ':%:' || sir.id::text
      LEFT JOIN cro03a_qualification_decisions qd
           ON qd.occurrence_id = o.id
     WHERE sir.status = 'completed'
       AND sir.completed_at < NOW() - INTERVAL '48 hours'
       AND qd.id IS NULL
     GROUP BY sir.id, sir.completed_at, sir.adapter_key
     LIMIT 50
  `));

  if (staleRuns.length === 0) return { staleRunCount: 0, alertsWritten: 0 };

  let alertsWritten = 0;

  for (const staleRun of staleRuns) {
    const runId = String(staleRun.run_id);
    const undecidedCount = Number(staleRun.undecided_count);

    // Check command state to classify the gap
    const commands = resultRows(await db.execute(sql`
      SELECT state, COUNT(*)::int AS cnt
        FROM cro03a_qualification_commands
       WHERE source_import_run_id = ${runId}::uuid
       GROUP BY state
    `));
    const commandsByState: Record<string, number> = Object.fromEntries(
      commands.map((r) => [String(r.state), Number(r.cnt)])
    );
    const neverEnqueued = commands.length === 0;
    const hasPending = (commandsByState.pending ?? 0) > 0;
    const hasProcessing = (commandsByState.processing ?? 0) > 0;

    // Still actively queued/running — not stale yet
    if (hasPending || hasProcessing) continue;

    // Rate-limit: one audit alert per run per day
    const existingAlert = resultRows(await db.execute(sql`
      SELECT id FROM audit_logs
       WHERE action = 'cro03a_stale_occurrence_alert'
         AND entity_key = ${runId}
         AND created_at >= NOW() - INTERVAL '24 hours'
       LIMIT 1
    `))[0];
    if (existingAlert) continue;

    const hasFailed = (commandsByState.failed ?? 0) > 0;

    // If every completed command for this run was intentionally short-circuited by the
    // geography pre-filter (no South Florida occurrences in the import chunk), the
    // undecided occurrences are expected — they are not a stale-processing fault.
    // Detect this by checking whether all completed commands carry the
    // 'geography_pre_filter:' error_text prefix written by processOutboxCro03aQualificationCommands.
    const completedCount = commandsByState.completed ?? 0;
    if (!neverEnqueued && !hasFailed && completedCount > 0) {
      const geoFilteredResult = resultRows(await db.execute(sql`
        SELECT COUNT(*)::int AS cnt
          FROM cro03a_qualification_commands
         WHERE source_import_run_id = ${runId}::uuid
           AND state = 'completed'
           AND error_text LIKE 'geography_pre_filter:%'
      `))[0];
      const geoFilteredCount = Number(geoFilteredResult?.cnt ?? 0);
      if (geoFilteredCount === completedCount) {
        // All commands were geography-filtered — undecided occurrences are intentional.
        continue;
      }
    }

    const staleSummary = neverEnqueued
      ? "NEVER_ENQUEUED"
      : hasFailed
        ? "QUALIFICATION_COMMANDS_FAILED"
        : "COMPLETED_WITHOUT_DECISIONS";

    try {
      await db.execute(sql`
        INSERT INTO audit_logs
          (action, entity_type, entity_key, actor_type, actor_id, details)
        VALUES (
          'cro03a_stale_occurrence_alert',
          'source_import_run',
          ${runId},
          'system',
          'cro03a-watchdog',
          ${JSON.stringify(sanitizeAuditPayload({
            adapterKey: String(staleRun.adapter_key),
            completedAt: String(staleRun.completed_at),
            undecidedCount,
            staleSummary,
            commandsByState,
          }))}::jsonb
        )
      `);
      alertsWritten++;
      console.warn(
        `[CRO03A Watchdog] Stale occurrence alert: run=${runId} adapter=${staleRun.adapter_key} ` +
        `undecided=${undecidedCount} status=${staleSummary}`
      );
    } catch (err: any) {
      console.error(`[CRO03A Watchdog] Failed to write alert for run ${runId}:`, err?.message);
    }
  }

  return { staleRunCount: staleRuns.length, alertsWritten };
}

// ── CRO-03A South Florida Geography Pre-filter ───────────────────────────────

/**
 * Given a list of occurrence IDs, returns only the subset whose source-observation
 * payload contains South Florida-eligible geography (evaluated by the TS geography
 * evaluator using state / county / countyFips / zip / city fields).
 *
 * Loads observation payloads in a single query (no per-row round-trips) and runs the
 * geography evaluator in-process.  Any occurrence whose payload yields
 * geography.eligible=true is included in the result.
 *
 * Chunk size cap: caller is responsible for reasonable input sizes; this function
 * does not paginate internally — it trusts the caller to pass bounded slices.
 */
export async function selectSouthFloridaEligibleOccurrenceIds(
  occurrenceIds: string[],
  executor: any = db,
): Promise<string[]> {
  if (!occurrenceIds.length) return [];
  const rows = resultRows(await executor.execute(sql`
    SELECT o.id::text AS occurrence_id, v.payload
      FROM cro03_source_occurrences o
      JOIN cro03_source_observations v ON v.id = o.source_observation_id
     WHERE o.id IN (${sql.join(occurrenceIds.map((id) => sql`${id}::uuid`), sql`,`)})
  `));
  const eligible: string[] = [];
  for (const row of rows) {
    const payload = json<Record<string, unknown>>(row.payload as string | Record<string, unknown>);
    const geo = evaluateSouthFloridaGeography({
      state: normalizeStateFl(payloadStr(payload, "state", "principalState")),
      county: payloadStr(payload, "county", "principalCounty"),
      countyFips: payloadStr(payload, "countyFips", "county_fips"),
      zip: payloadStr(payload, "zip", "postalCode", "principalZip"),
      city: payloadStr(payload, "city", "principalCity"),
    });
    if (geo.eligible) eligible.push(String(row.occurrence_id));
  }
  return eligible;
}

// ── CRO-03A Recurring Geography-Based Qualification Run ──────────────────────

/**
 * Selects occurrence IDs that:
 *   - Belong to selectable subject types
 *   - Were observed within the freshness window (365 days)
 *   - Have no existing qualification decision
 *   - Pass the South Florida geography check (payload state / zip / city evaluated in-process)
 *
 * Returns up to `limit` occurrence IDs ordered by source_observed_at ASC (oldest first)
 * so that the recurring job makes steady forward progress through the backlog.
 */
export async function selectUndecidedSouthFloridaOccurrenceIds(
  limit = 500,
): Promise<string[]> {
  // SQL-side pre-filter using the exact same ZIP, city, and FIPS reference data that
  // the in-process geography evaluator uses.  This eliminates starvation from large
  // non-target FL populations (Tampa, Orlando, Monroe, etc.) that would otherwise
  // block the window forever when eligible SF records are positioned later in the
  // ordered scan.
  //
  // Match criterion (any one sufficient):
  //   1. Explicit countyFips / county_fips payload field equals a target FIPS code
  //   2. ZIP code (zip / postalCode / principalZip) is in the South Florida ZIP list
  //      (single-county, non-Monroe ZIPs from the v2 reference)
  //   3. City name (city / principalCity, lowercased) is in the South Florida city list
  //      (single-county, non-Monroe cities from the v2 reference)
  //
  // In-process verification via evaluateSouthFloridaGeography is still run to
  // catch conflicting evidence (e.g., FL zip + non-FL state) and to apply the
  // full evidenceClass hierarchy.
  //
  // The candidate limit is 4× the requested limit to absorb any SQL false-positives
  // (conflicting evidence, ambiguous zips, etc.) without a second round-trip.
  const candidateLimit = Math.min(limit * 4, 2000);
  const targetFips = Object.values(CRO03A_COUNTY_FIPS);

  const candidates = (await pool.query<{ occurrence_id: string; payload: unknown }>(
    `SELECT o.id::text AS occurrence_id, v.payload
       FROM cro03_source_occurrences o
       JOIN cro03_source_subjects    s  ON s.id = o.source_subject_id
       JOIN cro03_source_observations v  ON v.id = o.source_observation_id
       LEFT JOIN cro03a_qualification_decisions qd ON qd.occurrence_id = o.id
      WHERE s.subject_type IN (
              'prospect', 'sunbiz_entity', 'sdr_merchant',
              'provider_csv_row', 'lead_discovery_result', 'master_lead'
            )
        AND o.source_observed_at >= NOW() - INTERVAL '365 days'
        AND qd.id IS NULL
        AND (
          v.payload->>'countyFips'   = ANY($1::text[])
          OR v.payload->>'county_fips' = ANY($1::text[])
          OR COALESCE(
               v.payload->>'zip',
               v.payload->>'postalCode',
               v.payload->>'principalZip'
             ) = ANY($2::text[])
          OR lower(COALESCE(
               v.payload->>'city',
               v.payload->>'principalCity',
               ''
             )) = ANY($3::text[])
        )
      ORDER BY o.source_observed_at ASC
      LIMIT $4`,
    [targetFips, SOUTH_FLORIDA_ZIPS, SOUTH_FLORIDA_CITIES, candidateLimit],
  )).rows;

  const eligible: string[] = [];
  for (const row of candidates) {
    if (eligible.length >= limit) break;
    const payload = json<Record<string, unknown>>(row.payload as string | Record<string, unknown>);
    const geo = evaluateSouthFloridaGeography({
      state: normalizeStateFl(payloadStr(payload, "state", "principalState")),
      county: payloadStr(payload, "county", "principalCounty"),
      countyFips: payloadStr(payload, "countyFips", "county_fips"),
      zip: payloadStr(payload, "zip", "postalCode", "principalZip"),
      city: payloadStr(payload, "city", "principalCity"),
    });
    if (geo.eligible) eligible.push(String(row.occurrence_id));
  }
  return eligible;
}

/**
 * Recurring geography-based qualification job.
 *
 * Selects undecided South Florida-eligible occurrences and creates a qualification
 * run for them.  This ensures the pilot funnel receives handoffs from the existing
 * observation backlog even when no new source-registry imports arrive.
 *
 * Idempotency: the run idempotency key embeds a date-hour bucket + selection hash,
 * so re-runs within the same hour with the same eligible population are no-ops.
 *
 * Returns null when there are no eligible undecided occurrences (nothing to do).
 */
export async function processRecurringCro03aGeographyQualification(options: {
  limit?: number;
  actorId?: string;
}): Promise<{ runId: string; totalCount: number; replayed: boolean } | null> {
  const limit = options.limit ?? 500;
  const actorId = options.actorId ?? CRO03A_AUTOWIRE_ACTOR_ID;

  const occurrenceIds = await selectUndecidedSouthFloridaOccurrenceIds(limit);
  if (!occurrenceIds.length) return null;

  // Bucket by UTC hour so the idempotency key remains stable within a scheduling window.
  const hourBucket = new Date().toISOString().slice(0, 13); // "2026-09-18T14"
  const selectionHash = stableCro03aSelectionHash([...occurrenceIds].sort());
  const idempotencyKey = `cro03a-recurring-geo:${hourBucket}:${selectionHash.slice(0, 16)}`;

  const result = await createCro03aQualificationRun({
    idempotencyKey,
    occurrenceIds,
    actorId,
    actorRole: "admin",
  });

  return { runId: result.id, totalCount: result.totalCount, replayed: result.replayed };
}

// ── CRO-03A Observation Geography Backfill ───────────────────────────────────

/**
 * Stamps geography_backfill_attempted_at on every cro03_source_observations row
 * that has not yet been processed, preventing those rows from being re-scanned on
 * every scheduler tick.
 *
 * Immutability contract: observations are content-addressed (payload_hash =
 * sha256(payload)). This function NEVER mutates the payload or payload_hash columns.
 * The sentinel column records that geography resolution was attempted; the resolved
 * eligibility result (eligible / ineligible / unknown) is captured separately by
 * the in-process geography evaluator at qualification-run time.
 *
 * Rolling-upgrade safe: feature-detects the sentinel column before doing any work,
 * returning featureDetected=false as a safe no-op on schemas that haven't had the
 * 0274 migration applied yet.
 *
 * @param batchSize  Maximum number of observations to process per call (default 200).
 * @returns          { processed, eligible, ineligible, featureDetected }
 *                   eligible / ineligible counts are informational only (for logging).
 */
// The observation table carries an immutability guard (cro03_immutable_row_guard) that rejects every UPDATE,
// including the informational sentinel stamp below. Once the guard has refused the stamp, the stamp can never
// succeed on this database, so the backfill stands down for the life of the process instead of failing the
// whole recurring qualification job on every tick. Observations are never mutated to work around the guard.
let observationSentinelBlockedByImmutabilityGuard = false;

function isImmutableGuardRefusal(error: unknown): boolean {
  const e = error as { code?: string; message?: string; cause?: { code?: string; message?: string } } | null;
  const code = e?.cause?.code ?? e?.code;
  const message = `${e?.cause?.message ?? ""} ${e?.message ?? ""}`;
  return code === "P0001" && /is immutable/i.test(message);
}

export async function backfillCro03aObservationGeography(
  batchSize = 200,
): Promise<{ processed: number; eligible: number; ineligible: number; featureDetected: boolean }> {
  if (observationSentinelBlockedByImmutabilityGuard) {
    return { processed: 0, eligible: 0, ineligible: 0, featureDetected: false };
  }
  // Feature-detect the sentinel column so the function is safe to call on a schema
  // that hasn't had the 0274 migration applied yet (rolling upgrade guard).
  try {
    const colCheck = resultRows(await db.execute(sql`
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'cro03_source_observations'
         AND column_name  = 'geography_backfill_attempted_at'
       LIMIT 1
    `));
    if (colCheck.length === 0) {
      return { processed: 0, eligible: 0, ineligible: 0, featureDetected: false };
    }
  } catch {
    return { processed: 0, eligible: 0, ineligible: 0, featureDetected: false };
  }

  // Fetch a bounded batch of observations that have not yet been attempted.
  // Order by created_at ASC so the job makes steady forward progress through the
  // historical backlog before reaching recent rows.
  const rows = resultRows(await db.execute(sql`
    SELECT id::text AS id, payload
      FROM cro03_source_observations
     WHERE geography_backfill_attempted_at IS NULL
     ORDER BY created_at ASC
     LIMIT ${batchSize}
  `));

  if (rows.length === 0) {
    return { processed: 0, eligible: 0, ineligible: 0, featureDetected: true };
  }

  let eligible = 0;
  let ineligible = 0;

  // Collect IDs to stamp in a single bulk UPDATE, preserving payload immutability.
  const allIds: string[] = [];

  for (const row of rows) {
    const obsId = String(row.id);
    allIds.push(obsId);

    // Evaluate geography in-process for the informational counters only.
    // Result is NOT persisted — observations are immutable content-addressed records.
    const payload = json<Record<string, unknown>>(row.payload as string | Record<string, unknown>);
    const geo = evaluateSouthFloridaGeography({
      state: normalizeStateFl(payloadStr(payload, "state", "principalState")),
      county: payloadStr(payload, "county", "principalCounty"),
      countyFips: payloadStr(payload, "countyFips", "county_fips"),
      zip: payloadStr(payload, "zip", "postalCode", "principalZip"),
      city: payloadStr(payload, "city", "principalCity"),
    });
    if (geo.eligible) { eligible++; } else { ineligible++; }
  }

  // Single bulk UPDATE — only the sentinel column is touched, never payload or payload_hash.
  try {
    await db.execute(sql`
      UPDATE cro03_source_observations
         SET geography_backfill_attempted_at = NOW()
       WHERE id IN (${sql.join(allIds.map((id) => sql`${id}::uuid`), sql`,`)})
         AND geography_backfill_attempted_at IS NULL
    `);
  } catch (error) {
    if (!isImmutableGuardRefusal(error)) throw error;
    observationSentinelBlockedByImmutabilityGuard = true;
    console.warn("[CRO03A GeoBackfill] observation table is immutable; sentinel stamping disabled for this process");
    return { processed: 0, eligible: 0, ineligible: 0, featureDetected: false };
  }

  return { processed: allIds.length, eligible, ineligible, featureDetected: true };
}

// ── CRO-03A Outbox Observation Geography Pre-filter ──────────────────────────

/**
 * Filters occurrence IDs from an outbox command chunk to only those with South
 * Florida-eligible geography.  Called by processOutboxCro03aQualificationCommands
 * before passing IDs to createCro03aQualificationRun so that pilot runs only
 * include in-territory candidates.
 *
 * Processes in slices of 500 to respect loadOccurrences() caps.  Returns the
 * filtered subset in the same relative order as the input.
 */
export async function filterOutboxOccurrencesByGeography(
  occurrenceIds: string[],
): Promise<string[]> {
  if (!occurrenceIds.length) return [];
  const SLICE = 500;
  const eligible: string[] = [];
  for (let i = 0; i < occurrenceIds.length; i += SLICE) {
    const slice = occurrenceIds.slice(i, i + SLICE);
    const sliceEligible = await selectSouthFloridaEligibleOccurrenceIds(slice);
    eligible.push(...sliceEligible);
  }
  return eligible;
}
