#!/usr/bin/env npx tsx
/**
 * BT-06 static classification gates.
 *
 * This intentionally has no database dependency. It protects the architectural
 * kill lines that are easy to regress in a later feature branch:
 * - public inserts cannot accept recordClass;
 * - destructive heuristic cleanup routes are disabled;
 * - record_class writes are centralized in the authority;
 * - the marketing gate invokes authorizeUse before consent evaluation;
 * - migration journal high-water protection is present.
 */
import fs from "fs";
import path from "path";

let passed = 0;
let failed = 0;
function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
}
function read(file: string) {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}

const schema = read("shared/schema.ts");
const classificationAuthority = read("server/services/commercial-classification-authority.ts");
const contactability = read("server/services/contactability.ts");
const admin = read("server/routes/admin.ts");
const prospectsRoute = read("server/routes/prospects.ts");
const publicRoutes = read("server/routes/public.ts");
const importsRoutes = read("server/routes/imports.ts");
const ghlWorkflows = read("server/services/ghl-workflows.ts");
const ghlTransport = read("server/services/ghl.ts");
const routeHelpers = read("server/routes/helpers.ts");
const workflowEnrollment = read("server/services/ghl-workflow-enrollment.ts");
const contactWriter = read("server/services/contact-writer.ts");
const contactFieldAuthority = read("server/services/contact-field-authority.ts");
const sdrGhlTransport = read("server/services/sdr/ghl-client.ts");
const smtpTransport = read("server/services/smtp-email.ts");
const authority = read("server/services/commercial-classification-authority.ts");
const dealStorage = read("server/storage/deals.ts");
const executiveKpi = read("server/services/executive-kpi.ts");
const analyticsRoutes = read("server/routes/analytics.ts");
const weeklyDigest = read("server/services/digest-service.ts");
const migration = read("migrations/0150_commercial_classification.sql");
const integrity = read("scripts/check-migration-integrity.ts");
const sunbizBootstrap = read("server/services/sunbiz-bootstrap.ts");
const sunbizClassificationPolicyStart = classificationAuthority.indexOf("export async function initializeSunbizBootstrapBusinessClass");
const sunbizClassificationPolicyEnd = classificationAuthority.indexOf("export async function deriveLinkedDealClass", sunbizClassificationPolicyStart);
const sunbizClassificationPolicy = classificationAuthority.slice(
  sunbizClassificationPolicyStart,
  sunbizClassificationPolicyEnd === -1 ? undefined : sunbizClassificationPolicyEnd,
);

for (const name of ["insertContactSchema", "insertCompanySchema", "insertDealSchema", "insertProspectSchema"]) {
  const start = schema.indexOf(`export const ${name}`);
  const next = schema.indexOf("export ", start + 1);
  const block = schema.slice(start, next === -1 ? undefined : next);
  assert(start >= 0 && /recordClass:\s*true/.test(block), `${name} omits authority-managed recordClass`);
}

assert(
  /status\(410\)\.json/.test(admin) && admin.includes("/api/admin/purge-test-contacts"),
  "test-contact purge endpoint is permanently disabled with 410",
);
assert(
  /status\(410\)\.json/.test(prospectsRoute) && prospectsRoute.includes("/api/prospect-lists/demo-cleanup"),
  "heuristic prospect-list demo cleanup is permanently disabled with 410",
);
assert(
  contactability.includes('commercialPurpose = "marketing_outreach"') &&
    contactability.includes("authorizeCommercialUse({") &&
    contactability.includes('commercialPurpose === "transactional_response"') &&
    contactability.indexOf("Step 1b: Commercial classification") < contactability.indexOf("BT-04A canonical channel"),
  "commercial authorization runs before canonical consent checks",
);
assert(
  /commercial_classification_events/.test(migration) &&
    /cce_immutable_guard/.test(migration) &&
    /event_namespace/.test(migration) &&
    /event_key/.test(migration),
  "append-only idempotent event persistence is migrated",
);
assert(
  /commercial_class_event_snapshot_immutable/.test(migration) &&
    /osl_record_class_snapshot_immutable/.test(migration) &&
    /suc_record_class_snapshot_immutable/.test(migration),
  "send and statement class snapshots are database-immutable",
);
assert(
  authority.includes('purpose === "internal_test"') &&
    authority.includes('process.env.NODE_ENV !== "test"') &&
    authority.includes("internal_test authorization is available only in NODE_ENV=test"),
  "internal_test classification authorization cannot bypass controls outside test mode",
);
const funnel = read("server/services/sdr/funnel-metrics.ts");
assert(
  (funnel.match(/contacts\.recordClass} = 'production'/g) ?? []).length >= 7 &&
    funnel.includes("innerJoin(contacts, eq(contacts.id, sdrLeadState.contactId))"),
  "every funnel input is scoped through production CRM contacts",
);
assert(
  (publicRoutes.match(/sendConfirmationSms\(/g) ?? []).length <=
    (publicRoutes.match(/commercialPurpose: "transactional_response"/g) ?? []).length &&
    (importsRoutes.match(/sendConfirmationSms\(/g) ?? []).length ===
      (importsRoutes.match(/commercialPurpose: "transactional_response"/g) ?? []).length,
  "every public SMS confirmation has explicit transactional authorization",
);
assert(
  ghlWorkflows.includes("commercialPurpose = declaration.commercialPurpose ?? \"marketing_outreach\"") &&
    ghlWorkflows.includes('commercialPurpose: registryEntry.commercialPurpose ?? "marketing_outreach"') &&
    ghlWorkflows.includes('inbound_confirmation: { purpose: "confirm a merchant\'s inbound form submission", outboundChannels: ["email"], commercialPurpose: "transactional_response" }'),
  "GHL confirmations use transactional purpose while undeclared workflows remain marketing",
);
assert(
  (ghlTransport.match(/authorizeCommercialUse\(\{/g) ?? []).length >= 3 &&
    (ghlTransport.match(/commercial\.effectiveDecision\.allowed/g) ?? []).length >= 3 &&
    (ghlTransport.match(/"account_transactional"/g) ?? []).length >= 3 &&
    (ghlTransport.match(/"marketing_outreach"/g) ?? []).length >= 3 &&
    !ghlTransport.includes('import("./commercial-classification-authority")'),
  "GHL provider email and SMS boundaries fail closed to production marketing",
);
assert(
  ghlTransport.includes("sendGhlEmailForMerchant") &&
    ghlTransport.includes('if (!params.contactId && !params.internalNotification)') &&
    ghlTransport.includes("internalNotification?: boolean") &&
    ghlTransport.includes("subjectId: params.contactId!") &&
    ghlTransport.includes("commercial.effectiveDecision.reasonCode"),
  "GHL merchant-email transport also requires classified contact authorization",
);
assert(
  routeHelpers.includes('commercialPurpose: "transactional_response"') &&
    workflowEnrollment.includes('commercialPurpose: "transactional_response"'),
  "trusted confirmation helpers preserve transactional purpose at final transport",
);
assert(
  contactFieldAuthority.includes('"recordClass"') &&
    contactFieldAuthority.includes("export function stripContactAuthorityFields") &&
    contactFieldAuthority.includes("for (const field of CONTACT_AUTHORITY_OWNED_FIELDS) delete result[field]") &&
    contactWriter.includes("stripContactAuthorityFields(args.mutation)") &&
    contactWriter.includes('recordClass: "unknown"') &&
    !/serverInsertContactSchema[\s\S]*recordClass: false/.test(read("shared/schema.ts")),
  "generic contact creation strips supplied class and quarantines new roots",
);
assert(
  sdrGhlTransport.includes("assertCommercialAllowed") &&
    sdrGhlTransport.includes("resolveLocalContactId") &&
    sdrGhlTransport.includes("await resolveLocalContactId(params.dbContactId, params.contactId)") &&
    sdrGhlTransport.includes('if (!dbContactId) throw new Error("COMMERCIAL_CLASS_UNKNOWN")') &&
    sdrGhlTransport.includes('await assertCommercialAllowed(localContact.id, "marketing_outreach")') &&
    sdrGhlTransport.includes("where(eq(contacts.ghlContactId, merchant.ghlContactId))") &&
    workflowEnrollment.includes('dbContactId: params.contactId, commercialPurpose: "transactional_response"'),
  "SDR GHL email and SMS transport require a locally classified recipient",
);
assert(
  smtpTransport.includes('await import("./commercial-resolution")') &&
    smtpTransport.includes("authorizeCommercialUse") &&
    smtpTransport.includes("decision.effectiveDecision.allowed") &&
    smtpTransport.includes("serverOwnedNoContactCategories") &&
    smtpTransport.includes("trustedTransactionalCategories") &&
    smtpTransport.includes('"transactional_response"'),
  "SMTP provider boundary applies commercial authorization before network delivery",
);
assert(
  classificationAuthority.includes("deriveLinkedDealClass") &&
    classificationAuthority.includes("getLinkedClassesInTransaction") &&
    classificationAuthority.includes("COMMERCIAL_CLASS_CONFLICT") &&
    dealStorage.includes("deriveLinkedDealClass"),
  "linked commercial roots inherit only verified production and conflicts fail closed",
);
assert(
  executiveKpi.includes('aggregateType: "executive_kpi"') &&
    executiveKpi.includes("recordAggregateLineage") &&
    executiveKpi.includes("linked_contact.record_class = 'production'"),
  "executive snapshots record lineage and exclude linked-class conflicts",
);
assert(
  [
    "/api/analytics/tool-upload-attribution",
    "/api/kpi/summary",
    "/api/kpi/comparative",
    "/api/analytics/pipeline",
    "/api/analytics/lead-sources",
    "/api/analytics/growth-kpi",
    "/api/analytics/daily-leads",
    "/api/forecasting/summary",
    "/api/kpi/pipeline-stats",
    "/api/leaderboard",
    "/api/analytics/conversion-funnel",
    "/api/analytics/lifecycle-distribution",
  ].every((path) => {
    const start = analyticsRoutes.indexOf(`"${path}"`);
    const next = analyticsRoutes.indexOf('app.', start + 1);
    const handler = analyticsRoutes.slice(start, next === -1 ? undefined : next);
    return start >= 0 && (
      handler.includes("record_class = 'production'") ||
      handler.includes('recordClass: "production"') ||
      handler.includes('contacts.recordClass, "production"') ||
      (path === "/api/analytics/lifecycle-distribution" && handler.includes("readLifecycleDistribution")) ||
      (path === "/api/analytics/pipeline" && handler.includes("readPipelineAnalytics"))
    );
  }) &&
    (weeklyDigest.match(/record_class = 'production'/g) ?? []).length >= 9,
  "every commercial dashboard, forecast, attribution, and digest aggregate excludes non-production roots",
);
assert(
  integrity.includes("const HIGH_WATER_WHEN = 1793300000000") &&
    integrity.includes("Math.max(...baselineEntries.map"),
  "migration high-water check uses current baseline plus dynamic maximum",
);
assert(
  sunbizBootstrap.includes("initializeSunbizBootstrapBusinessClass") &&
    sunbizBootstrap.includes('claimMode: "active_lease"') &&
    sunbizClassificationPolicy.includes("verified_sunbiz_bootstrap") &&
    sunbizClassificationPolicy.includes("sunbiz_bootstrap_claims") &&
    sunbizClassificationPolicy.includes("canonical_source_links") &&
    sunbizClassificationPolicy.includes("matchedBootstrapIdentity") &&
    sunbizClassificationPolicy.includes("SUNBIZ_CLASSIFICATION_EVIDENCE_INSUFFICIENT") &&
    sunbizClassificationPolicy.includes('actorId: "service:sunbiz_bootstrap"') &&
    !/approverId\s*:/.test(sunbizClassificationPolicy) &&
    classificationAuthority.includes("command.approverId ?? null"),
  "Sunbiz automated production requires database-backed bootstrap proof and records no fabricated approver",
);

const allowedRecordClassWriters = new Set([
  "server/services/commercial-classification-authority.ts",
  // This startup-only migration convergence is the owner of the explicitly
  // documented historical unknown→test/production backfill.
  "server/services/production-seed-convergence.ts",
  "migrations/0150_commercial_classification.sql",
  "shared/schema.ts",
]);
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
const directWriteViolations: string[] = [];
for (const file of walk(path.join(process.cwd(), "server"))) {
  if (!file.endsWith(".ts")) continue;
  const relative = path.relative(process.cwd(), file).replace(/\\/g, "/");
  if (allowedRecordClassWriters.has(relative)) continue;
  const content = fs.readFileSync(file, "utf8");
  if (/\.set\(\s*\{[^}]*recordClass\s*:|SET\s+record_class\s*=/s.test(content)) {
    directWriteViolations.push(relative);
  }
}
assert(
  directWriteViolations.length === 0,
  `no direct record class writes outside authority (${directWriteViolations.join(", ") || "none"})`,
);

if (failed > 0) {
  console.error(`\n✗ BT-06 static classification checks failed (${failed} failed, ${passed} passed).`);
  process.exit(1);
}
console.log(`\n✓ BT-06 static classification checks passed (${passed} checks).`);