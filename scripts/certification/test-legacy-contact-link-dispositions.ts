/**
 * Legacy business-assignment dispositions against real migrated disposable PostgreSQL.
 * Every external transport is denied; no provider, enrollment or send path is used.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import {
  applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount,
} from "../certification-provider-deny";

await assertDisposableTestInfrastructure({ operation: "legacy contact link disposition certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { pool, db } = await import("../../server/db");
const { processContactLinkAutomationTick, getContactLinkAutomationStatus } =
  await import("../../server/services/contact-link-automation");
const { classifyContactLinkDisposition, DISPOSITION_RULE_VERSION } =
  await import("../../server/services/contact-link-disposition-policy");
const { PROGRAM_RULE_VERSION, readContactLinkDispositionReport } =
  await import("../../server/services/contact-link-dispositions");
const { materializeSupportedContactBusiness } = await import("../../server/services/contact-business-materialization");
const { loadEvidenceRelationshipPage } = await import("../../server/services/contact-business-evidence-page");
const { claimCsvExecution } = await import("../../server/services/import-execution");
const { retainProviderImportRow } = await import("../../server/services/provider-import-evidence");
const { computeFileHash } = await import("../../server/services/import-normalizer");

const prefix = `cert_legacy_links_${randomUUID().replaceAll("-", "")}`;
const KEY = "contact_link_automation_v1";
let checks = 0;
const check = (value: unknown, label: string) => { assert(value, label); checks++; };
const originalEnv = {
  NODE_ENV: process.env.NODE_ENV, REPLIT_DEPLOYMENT: process.env.REPLIT_DEPLOYMENT,
  RELEASE_SHA: process.env.RELEASE_SHA, SFP_PUBLISH_ARTIFACT_SHA: process.env.SFP_PUBLISH_ARTIFACT_SHA,
  SFP_PUBLISH_BUILD_ID: process.env.SFP_PUBLISH_BUILD_ID, SFP_PUBLISH_BUILT_AT: process.env.SFP_PUBLISH_BUILT_AT,
};
const build = { sha: "e".repeat(40), id: randomUUID(), at: new Date(Date.now() - 120_000).toISOString() };
function deploy() {
  process.env.NODE_ENV = "production";
  process.env.REPLIT_DEPLOYMENT = "1";
  process.env.RELEASE_SHA = build.sha;
  process.env.SFP_PUBLISH_ARTIFACT_SHA = build.sha;
  process.env.SFP_PUBLISH_BUILD_ID = build.id;
  process.env.SFP_PUBLISH_BUILT_AT = build.at;
}
async function safety() {
  return (await pool.query(`SELECT
    (SELECT count(*) FROM provider_operations) provider_operations,
    (SELECT count(*) FROM sequence_enrollments) enrollments,
    (SELECT count(*) FROM communication_events) communications,
    (SELECT count(*) FROM import_row_dispositions) receipts`)).rows[0];
}
type ContactOpts = { company: string | null; email: string; phone?: string; address?: string | null; city?: string | null;
  state?: string | null; website?: string | null; ghl?: string | null; recordClass?: string; emailStatus?: string; old?: boolean };
async function mkContact(o: ContactOpts) {
  return Number((await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,address,city,state,website,
      ghl_contact_id,record_class,email_status,updated_at)
    VALUES('Legacy','Fixture',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${o.old ? "now()-interval '30 days'" : "now()"}) RETURNING id`,
    [o.email, o.phone ?? "", o.company, o.address ?? null, o.city ?? null, o.state ?? null, o.website ?? null,
      o.ghl ?? null, o.recordClass ?? "production", o.emailStatus ?? "unvalidated"])).rows[0].id);
}
/** A provider import event that predates businessEvidence, with its ORIGINAL retained row. */
async function legacyProviderContact(label: string, row: Record<string, string>, opts: Partial<ContactOpts> = {}, fingerprint?: string) {
  const claim = await claimCsvExecution({ fileHash: `${prefix}_${label}_${randomUUID()}`, totalRows: 1,
    actorType: "user", actorId: "certification", sourcePayload: [row] } as any);
  const executionId = (claim as any).execution.id as string;
  await retainProviderImportRow({ executionId, sourceRowNumber: 1, sourceFormat: "google_maps_outscraper",
    actorId: "certification", rawRow: row });
  const id = await mkContact({ company: row.name, email: `${prefix}.${label}@example.invalid`, phone: row.phone,
    address: row.address, city: row.city, state: row.state, website: row.website, old: true, ...opts });
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,source_external_id,
      import_execution_id,source_row_number,row_fingerprint,actor_type,metadata)
    VALUES($1,$2,'csv_import','outscraper',$2,$3::uuid,1,$4,'import',$5::jsonb)`,
    [id, `${prefix}_${label}_evt`, executionId, fingerprint ?? computeFileHash(Buffer.from(JSON.stringify(row))),
      JSON.stringify({ place_id: row.place_id ?? null, sourceFormat: "google_maps_outscraper" })]);
  return { id, executionId };
}
const disposition = async (id: number) =>
  (await pool.query("SELECT * FROM contact_business_link_dispositions WHERE contact_id=$1", [id])).rows[0];
const decisions = async (id: number) => Number((await pool.query(`SELECT count(*) n FROM contact_business_link_decisions
  WHERE contact_id=$1 AND decision='verified' AND superseded_at IS NULL`, [id])).rows[0].n);
const contactBusiness = async (id: number) =>
  (await pool.query("SELECT business_id FROM contacts WHERE id=$1", [id])).rows[0].business_id as number | null;
const drain = async (limit = 30) => {
  for (let i = 0; i < limit; i++) {
    const r = await processContactLinkAutomationTick();
    if ((r as any).ran && (r as any).complete) return;
  }
};

try {
  for (const key of ["RELEASE_SHA", "SFP_PUBLISH_ARTIFACT_SHA", "SFP_PUBLISH_BUILD_ID", "SFP_PUBLISH_BUILT_AT"])
    delete process.env[key];

  // ---- Pure classification matrix: every outcome carries a specific reason + retry trigger.
  const base = {
    contactId: 1, ruleVersion: PROGRAM_RULE_VERSION, snapshotHash: "s", materializationEvidenceRevision: "m",
    eligible: false, reasons: ["independent_business_identity_not_found"], projectedBusinessId: null,
    currentDecision: null, businessId: null, candidateEvidence: [], hasGhlContactId: false,
    sourceEvents: { count: 0, kinds: [], hasSupportedEvidence: false },
  };
  const cls = (over: any) => classifyContactLinkDisposition({ ...base, ...over });
  assert.equal(cls({}).reasonCode, "LEGACY_CONTACT_FIELDS_ONLY"); checks++;
  assert.equal(cls({ hasGhlContactId: true }).reasonCode, "GHL_ORGANIZATION_EVIDENCE_NOT_RETAINED"); checks++;
  assert.equal(cls({ sourceEvents: { count: 2, kinds: ["website_form:callback_form"], hasSupportedEvidence: false } }).reasonCode,
    "SOURCE_EVIDENCE_NOT_SUPPORTED_FOR_ASSIGNMENT"); checks++;
  assert.equal(cls({ reasons: ["competing_corroborated_businesses"] }).outcome, "awaiting_review"); checks++;
  assert.equal(cls({ reasons: ["independent_corroboration_required"] }).reasonCode, "CANDIDATE_NOT_INDEPENDENTLY_CORROBORATED"); checks++;
  assert.equal(cls({ failure: "statement_timeout" }).outcome, "retryable"); checks++;
  assert.equal(cls({ writer: { status: "rejected", code: "SYSTEM_LINK_SNAPSHOT_STALE" } }).outcome, "retryable"); checks++;
  assert.equal(cls({ materializer: { status: "held", reasonCode: "INDEPENDENT_ORGANIZATION_CORROBORATION_REQUIRED" } }).outcome,
    "unsupported"); checks++;
  const unsupported = cls({});
  check(unsupported.nextRetryTrigger && unsupported.evidenceFingerprint.length === 64 &&
    cls({}).evidenceFingerprint === unsupported.evidenceFingerprint && cls({ snapshotHash: "t" }).evidenceFingerprint !== unsupported.evidenceFingerprint,
    "Unsupported disposition names its retry trigger and a stable evidence fingerprint");
  check(cls({ writer: { status: "applied" } }).nextRetryTrigger === null, "Linked disposition needs no retry trigger");

  // ---- Fixtures created BEFORE the first tick are the dated acceptance baseline.
  const fieldsOnly = await mkContact({ company: `${prefix} Fields Only`, email: `${prefix}.fields@example.invalid`,
    website: `${prefix}-fields.example.test`, old: true });
  const ghlOnly = await mkContact({ company: `${prefix} Ghl Only`, email: `${prefix}.ghl@example.invalid`,
    ghl: `ghl_${randomUUID()}`, old: true });
  const otherClass = await mkContact({ company: `${prefix} Other Class`, email: `${prefix}.other@example.invalid`,
    recordClass: "unknown", old: true });
  const testClass = await mkContact({ company: `${prefix} Test`, email: `${prefix}.test@example.invalid`,
    recordClass: "test", old: true });

  const domain = `${randomUUID()}.example.test`;
  const supported = await legacyProviderContact("supported", {
    name: `${prefix} Supported Cafe`, phone: "2025550141", website: `https://${domain}`, address: "12 Legacy Rd",
    city: "Miami", state: "FL", place_id: `${prefix}_place_supported` }, { emailStatus: "invalid" });
  // Shared mailboxes: two contacts, one provider row, one business.
  const sharedDomain = `${randomUUID()}.example.test`;
  const sharedRow = { name: `${prefix} Shared Salon`, phone: "2025550142", website: `https://${sharedDomain}`,
    address: "3 Shared Way", city: "Tampa", state: "FL", place_id: `${prefix}_place_shared` };
  const sharedA = await legacyProviderContact("sharedA", sharedRow);
  const sharedB = await legacyProviderContact("sharedB", sharedRow);
  // Separate brand locations are never collapsed.
  const brandDomain = `${randomUUID()}.example.test`;
  const brandName = `${prefix} Brand Grill`;
  const brandA = await legacyProviderContact("brandA", { name: brandName, phone: "2025550143", website: `https://${brandDomain}`,
    address: "1 Main St", city: "Miami", state: "FL", place_id: `${prefix}_place_brandA` });
  const brandB = await legacyProviderContact("brandB", { name: brandName, phone: "2025550144", website: `https://${brandDomain}`,
    address: "9 Ocean Dr", city: "Tampa", state: "FL", place_id: `${prefix}_place_brandB` });
  // Genuine conflict between retained source observations for one relationship.
  const conflictName = `${prefix} Conflict Store`, conflictDomain = `${randomUUID()}.example.test`;
  const conflict = await mkContact({ company: conflictName, email: `${prefix}.conflict@example.invalid`, phone: "2025550145",
    address: "5 Conflict Ct", city: "Miami", state: "FL", website: conflictDomain, old: true });
  const proof = (name: string) => ({ canonicalName: name, websiteDomain: conflictDomain, mainPhone: "2025550145",
    streetAddress: "5 Conflict Ct", city: "Miami", state: "FL" });
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,source_external_id,actor_type,metadata)
    VALUES($1,$2,'crm','manual',$2,'system',$3::jsonb)`, [conflict, randomUUID(), JSON.stringify({ businessEvidence: proof(`${prefix} Different Name`) })]);
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,source_external_id,actor_type,metadata)
    VALUES($1,$2,'ghl_sync','inbound',$2,'system',$3::jsonb)`, [conflict, randomUUID(), JSON.stringify({ businessEvidence: proof(conflictName) })]);

  deploy();
  const before = await safety();
  await drain();

  // ---- Baseline: dated, once, production and other non-test classes separate, test excluded.
  const baselines = (await pool.query("SELECT id,contact_count,population FROM contact_link_acceptance_baselines")).rows;
  check(baselines.length === 1, "Exactly one dated acceptance baseline");
  const members = (await pool.query("SELECT contact_id,record_class FROM contact_link_acceptance_members WHERE baseline_id=$1",
    [baselines[0].id])).rows;
  check(members.some(m => m.contact_id === otherClass && m.record_class === "unknown") &&
    !members.some(m => m.contact_id === testClass), "Baseline keeps other non-test classes and excludes test fixtures");
  check(baselines[0].population.other_non_test >= 1 && baselines[0].population.production >= 8,
    "Baseline reports production and other non-test counts separately");
  await drain();
  check((await pool.query("SELECT count(*) n FROM contact_link_acceptance_baselines")).rows[0].n === "1",
    "Baseline is never recaptured");

  // ---- Legacy CRM/GHL records without modern businessEvidence get evidence-backed dispositions.
  const fo = await disposition(fieldsOnly), go = await disposition(ghlOnly);
  check(fo?.outcome === "unsupported" && fo.reason_code === "LEGACY_CONTACT_FIELDS_ONLY" && fo.rule_version === PROGRAM_RULE_VERSION &&
    fo.evidence_fingerprint.length === 64 && fo.next_retry_trigger.includes("source_event_added"),
    "Contact-fields-only legacy record records the specific reason, rule, fingerprint and retry trigger");
  check(go?.outcome === "unsupported" && go.reason_code === "GHL_ORGANIZATION_EVIDENCE_NOT_RETAINED",
    "GHL contact without a retained organization is not linked from copied fields");
  check(await contactBusiness(fieldsOnly) === null && await contactBusiness(ghlOnly) === null &&
    (await pool.query("SELECT count(*) n FROM businesses WHERE canonical_name ILIKE $1", [`%${prefix} Fields Only%`])).rows[0].n === "0",
    "No business is manufactured from contact fields alone");
  const otherDisposition = await disposition(otherClass);
  check(otherDisposition?.outcome === "unsupported", "Other non-test class contact is also accounted for");
  check(await contactBusiness(testClass) === null, "Test-class contact is never assigned and never enters baseline accounting");

  // ---- Original-row adapter: supported missing-business creation, unmapped vertical, unvalidated/invalid email.
  const sup = await disposition(supported.id);
  check(sup?.outcome === "linked" && await decisions(supported.id) === 1, "Legacy provider row (no businessEvidence) links through the audited writer");
  const supportedBusiness = (await pool.query(`SELECT b.record_class,b.vertical,sl.source_system,sl.raw_evidence
    FROM contacts c JOIN businesses b ON b.id=c.business_id
    JOIN canonical_source_links sl ON sl.business_id=b.id AND sl.source_type='organization_location'
    WHERE c.id=$1`, [supported.id])).rows[0];
  check(supportedBusiness.record_class === "canonical" && supportedBusiness.vertical === null,
    "Link does not depend on a canonical vertical");
  check(supportedBusiness.source_system === "outscraper" && supportedBusiness.raw_evidence.adapter === "original_import_row_v1" &&
    supportedBusiness.raw_evidence.businessEvidence.canonicalName === `${prefix} Supported Cafe`,
    "Source attribution stays with the provider original row, not a registry");
  check((await pool.query("SELECT email_status FROM contacts WHERE id=$1", [supported.id])).rows[0].email_status === "invalid",
    "Invalid email status is preserved; assignment is independent of validation");
  // Corrupt the retained row hash: the adapter must refuse, not guess.
  const tampered = await legacyProviderContact("tampered", { name: `${prefix} Tampered`, phone: "2025550146",
    website: `https://${randomUUID()}.example.test`, address: "7 Tamper St", city: "Miami", state: "FL" }, {}, "bad");
  await drain();
  const tam = await disposition(tampered.id);
  check(tam?.outcome === "unsupported" && /LEGACY_ORIGINAL_ROW_EVIDENCE_MISMATCH/.test(tam.reason_code) && await contactBusiness(tampered.id) === null,
    "Unverifiable original row is held with its reason, never trusted");

  // ---- Shared mailboxes: one business, two links; concurrent materialization is safe.
  const bA = await contactBusiness(sharedA.id), bB = await contactBusiness(sharedB.id);
  check(bA !== null && bA === bB, "Shared-mailbox contacts converge on one business");
  check(Number((await pool.query("SELECT count(*) n FROM businesses WHERE canonical_name=$1", [sharedRow.name])).rows[0].n) === 1,
    "No duplicate business from shared provider evidence");
  const raceRow = { name: `${prefix} Race Shop`, phone: "2025550147", website: `https://${randomUUID()}.example.test`,
    address: "8 Race Rd", city: "Orlando", state: "FL", place_id: `${prefix}_place_race` };
  const raceA = await legacyProviderContact("raceA", raceRow), raceB = await legacyProviderContact("raceB", raceRow);
  const auth = async () => true;
  const raced = await Promise.all([materializeSupportedContactBusiness(raceA.id, auth), materializeSupportedContactBusiness(raceB.id, auth)]);
  check(raced.every(r => ["materialized", "matched"].includes(r.status)) &&
    Number((await pool.query("SELECT count(*) n FROM businesses WHERE canonical_name=$1", [raceRow.name])).rows[0].n) === 1,
    "Concurrent creation of the same supported business yields exactly one business");
  const replay = await materializeSupportedContactBusiness(raceA.id, auth);
  check(replay.status === "matched" || replay.status === "materialized", "Replay of materialization is idempotent");

  // ---- Separate brand locations stay separate.
  const brandBusinessA = await contactBusiness(brandA.id), brandBusinessB = await contactBusiness(brandB.id);
  check(brandBusinessA !== null && brandBusinessB !== null && brandBusinessA !== brandBusinessB,
    "Separate brand locations keep separate business identities");

  // ---- Genuine conflict is awaiting review with the concrete reason.
  const cf = await disposition(conflict);
  check(cf?.outcome === "awaiting_review" && /RETAINED_ORGANIZATION_IDENTITY_CONFLICT/.test(cf.reason_code) &&
    await contactBusiness(conflict) === null, "Conflicting retained observations await review with the concrete conflict");

  // ---- No fulfillment receipts, enrollments, or communications are manufactured by links.
  const after = await safety();
  check(after.receipts === before.receipts && after.enrollments === before.enrollments &&
    after.communications === before.communications && after.provider_operations === before.provider_operations,
    "Contact-to-business links create no original-row receipt, enrollment, communication or provider operation");

  // ---- Interruption: a temporary worker failure is retryable, then recovers automatically.
  const retryDomain = `${randomUUID()}.example.test`;
  const retry = await mkContact({ company: `${prefix} Retry Cafe`, email: `${prefix}.retry@example.invalid`, phone: "2025550148",
    address: "4 Retry Rd", city: "Miami", state: "FL", website: retryDomain });
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,source_external_id,actor_type,metadata)
    VALUES($1,$2,'crm','manual',$2,'system',$3::jsonb)`, [retry, randomUUID(), JSON.stringify({ businessEvidence: {
      canonicalName: `${prefix} Retry Cafe`, websiteDomain: retryDomain, mainPhone: "2025550148",
      streetAddress: "4 Retry Rd", city: "Miami", state: "FL" } })]);
  await pool.query(`CREATE OR REPLACE FUNCTION cert_transient_failure() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'cert_transient_failure'; END $$`);
  await pool.query(`CREATE TRIGGER cert_transient_failure BEFORE INSERT ON canonical_source_links
    FOR EACH ROW EXECUTE FUNCTION cert_transient_failure()`);
  try { await drain(); } finally {
    await pool.query("DROP TRIGGER cert_transient_failure ON canonical_source_links");
  }
  const failed = await disposition(retry);
  check(failed?.outcome === "retryable" && failed.next_retry_trigger === "automatic_retry_at" && failed.next_retry_at &&
    await contactBusiness(retry) === null, "Temporary worker failure is retryable, not a relationship conclusion");
  const notDue = (await getContactLinkAutomationStatus(false))!;
  const {listDueRetryableContacts} = await import("../../server/services/contact-link-dispositions");
  check(!(await listDueRetryableContacts(db, 100)).includes(retry), "A retryable disposition is not due before its retry time");
  await pool.query("UPDATE contact_business_link_dispositions SET next_retry_at=now()-interval '1 minute' WHERE contact_id=$1", [retry]);
  check((await listDueRetryableContacts(db, 100)).includes(retry), "The retry becomes due automatically at its retry time");
  await processContactLinkAutomationTick();
  const recovered = await disposition(retry);
  check(recovered.outcome === "linked" && await decisions(retry) === 1 && recovered.evaluation_count >= 2,
    "Due retry recovers automatically without a manual replay");
  check(notDue.cursor !== undefined, "Program checkpoint preserved across the failure");

  // ---- Rule change reconsiders every hold through the ordinary worker, preserving valid links.
  const decisionsBefore = Number((await pool.query("SELECT count(*) n FROM contact_business_link_decisions WHERE superseded_at IS NULL")).rows[0].n);
  const evalBefore = (await disposition(fieldsOnly)).evaluation_count;
  const stateBefore = (await getContactLinkAutomationStatus(false))!;
  await pool.query(`UPDATE system_settings SET value=jsonb_set(value,'{dispositionRule}','"older_rule"') WHERE key=$1`, [KEY]);
  await pool.query("UPDATE contact_business_link_dispositions SET rule_version='older_rule'");
  await drain();
  check((await disposition(fieldsOnly)).evaluation_count > evalBefore && (await disposition(fieldsOnly)).rule_version === PROGRAM_RULE_VERSION,
    "A rule change re-evaluates earlier holds under the new rule");
  check(Number((await pool.query("SELECT count(*) n FROM contact_business_link_decisions WHERE superseded_at IS NULL")).rows[0].n) === decisionsBefore,
    "Re-evaluation preserves valid assignments without duplicate decisions");
  const stateAfter = (await getContactLinkAutomationStatus(false))!;
  check(stateAfter.runId === stateBefore.runId && stateAfter.committed >= stateBefore.committed, "Run identity and counters preserved");

  // ---- Accounting: every baseline contact has a current disposition; new intake is reported separately.
  const intake = await mkContact({ company: `${prefix} New Intake`, email: `${prefix}.intake@example.invalid` });
  await drain();
  check((await disposition(intake))?.outcome === "unsupported", "New intake is dispositioned automatically");
  const status = (await getContactLinkAutomationStatus())!;
  const report = status.dispositions as any;
  check(report?.state === "current", "Disposition report is readable");
  const accounted = (group: string) => Object.entries(report.baselineAccounting[group] ?? {});
  check(accounted("production").length && !accounted("production").some(([k]) => k === "no_disposition" || k.startsWith("stale_rule")),
    "Every production baseline contact has a current-rule disposition");
  check(!accounted("other_non_test").some(([k]) => k === "no_disposition"), "Other non-test class is accounted for separately");
  const newIntake = report.newIntakeSinceBaseline.production ?? {};
  check(Object.values(newIntake).reduce((a: number, b: any) => a + Number(b), 0) >= 1,
    "Contacts added after the baseline are reported separately from it");
  check(report.separateCounts.verifiedLinks >= 5 && report.separateCounts.distinctBusinessesLinked >= 4 &&
    typeof report.separateCounts.originalRowReceiptRows === "number", "Progress is reported as separate counts");

  // ---- Throughput: ordinary ticks commit many supported legacy relationships.
  const N = 120;
  const t0 = Date.now();
  await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,address,city,state,website,record_class)
    SELECT 'Bulk','Fixture',$1||n||'@example.invalid','202555'||lpad(n::text,4,'0'),$1||' Bulk '||n,n||' Bulk Blvd','Miami','FL',
      $2||n||'.example.test','production' FROM generate_series(1,${N}) n`, [`${prefix}.bulk.`, `${prefix}-bulk-`]);
  await pool.query(`INSERT INTO contact_source_events(contact_id,event_key,source_category,source_type,source_external_id,actor_type,metadata)
    SELECT c.id,gen_random_uuid()::text,'crm','manual',gen_random_uuid()::text,'system',jsonb_build_object('businessEvidence',
      jsonb_build_object('canonicalName',c.company_name,'websiteDomain',c.website,'mainPhone',c.phone,
        'streetAddress',c.address,'city',c.city,'state',c.state)) FROM contacts c WHERE c.email LIKE $1`, [`${prefix}.bulk.%`]);
  const committedBefore = (await getContactLinkAutomationStatus(false))!.committed;
  await drain(60);
  const bulkLinked = Number((await pool.query(`SELECT count(*) n FROM contacts c JOIN contact_business_link_decisions d
    ON d.contact_id=c.id AND d.superseded_at IS NULL AND d.decision='verified' WHERE c.email LIKE $1`, [`${prefix}.bulk.%`])).rows[0].n);
  const seconds = (Date.now() - t0) / 1000;
  check(bulkLinked === N && (await getContactLinkAutomationStatus(false))!.committed - committedBefore >= N,
    `Committed throughput: ${N} supported relationships linked by ordinary ticks`);
  const perSecond = bulkLinked / seconds;
  check(perSecond > 1, `Committed throughput above floor (${perSecond.toFixed(1)} links/s)`);

  // ---- Bounded query performance at a larger disposable population.
  await pool.query(`INSERT INTO businesses(canonical_name,normalized_name,website_domain,record_class)
    SELECT $1||' Perf '||n,lower($1||'perf'||n),$2||n||'.example.test','canonical' FROM generate_series(1,3000) n`, [prefix, `${prefix}-perf-`]);
  // The contact commit trigger takes one advisory lock per row; keep each insert below
  // the per-transaction lock table limit, as ordinary bounded intake does.
  for (let start = 1; start <= 20000; start += 500) {
    await pool.query(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,website,record_class,updated_at)
      SELECT 'Perf','Fixture',$1||n||'@example.invalid','',$2||' Perf '||n,$3||n||'.example.test','production',now()-interval '60 days'
      FROM generate_series($4::int,$4::int+499) n`, [`${prefix}.perf.`, prefix, `${prefix}-perf-`, start]);
  }
  const maxId = Number((await pool.query("SELECT max(id) m FROM contacts")).rows[0].m);
  const timings: number[] = [];
  for (let i = 0; i < 12; i++) {
    const after = Math.max(0, maxId - 20000 + Math.floor((i * 20000) / 12));
    const t = Date.now();
    await loadEvidenceRelationshipPage(db, after, 25);
    timings.push(Date.now() - t);
  }
  const worst = Math.max(...timings);
  check(worst < 3000, `Evidence page stays bounded at 20k unlinked contacts and 3k businesses (worst ${worst}ms)`);

  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider/network attempts");
  const receipt = {
    observedAt: new Date().toISOString(), checks, rule: PROGRAM_RULE_VERSION, dispositionRule: DISPOSITION_RULE_VERSION,
    scope: "Disposable real-DB legacy business assignment dispositions only",
    legacyOriginalRowAdapter: true, contactFieldsAloneNeverLink: true, durablePerContactOutcome: true,
    retryableFailureRecovers: true, ruleChangeReconsidersHolds: true, sharedMailboxesAndBrandLocations: true,
    concurrentCreationOneBusiness: true, noReceiptEnrollmentOrCommunicationFromLinks: true,
    throughputLinksPerSecond: Number(perSecond.toFixed(2)), throughputPopulation: N,
    queryWorstPageMs: worst, queryPopulation: { contacts: 20000, businesses: 3000 },
    externalNetworkAttempts: 0, productionExecution: false,
  };
  fs.writeFileSync("docs/certification/contact-link-dispositions-test.json", JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await pool.end();
}
