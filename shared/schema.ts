import { pgTable, text, serial, integer, boolean, timestamp, jsonb, varchar, real, numeric, index, uniqueIndex, unique, date, uuid, check, bigint, customType, primaryKey, foreignKey, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./models/auth";
import {coverageBusinessKeys,coverageSourceKeys} from "./contact-coverage-keys";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const OPEN_SALES_LEAD_STAGES = [
  "New Lead",
  "Enriched",
  "Statement Received",
  "Review In Progress",
  "Call Booked",
  "Proposal Sent",
  "Negotiation / Follow-Up",
  "Verbal Commit",
  "Promise to Submit",
] as const;

export * from "./models/auth";
export * from "./models/chat";

// ---------------------------------------------------------------------------
// Import Executions — one row per file-based import run (CSV, Sunbiz, etc.)
// ---------------------------------------------------------------------------
export const importExecutions = pgTable("import_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  importType: text("import_type").notNull(), // csv_contact | sunbiz_upload | sunbiz_corevt | prospect_csv
  fileHash: text("file_hash"),
  // Canonical, permanent replay key. Unlike the historical completed-only
  // uniqueness fence, this prevents two processors from starting the same file.
  executionKey: text("execution_key"),
  status: text("status").notNull().default("running"), // running | completed | failed
  totalRows: integer("total_rows"),
  insertedRows: integer("inserted_rows"),
  updatedRows: integer("updated_rows"),
  skippedRows: integer("skipped_rows"),
  errorRows: integer("error_rows"),
  actorType: text("actor_type"),
  actorId: text("actor_id"),
  metadata: jsonb("metadata"),
  // Immutable, normalized source retained for restart-safe import resumption.
  // Raw uploads are discarded after parsing; this contains only the normalized
  // row contract consumed by the canonical intake command.
  sourcePayload: jsonb("source_payload"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  heartbeatAt: timestamp("heartbeat_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  failureReason: text("failure_reason"),
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
 }, (table) => [
  // Prevent re-completing the same file twice (replay protection)
  uniqueIndex("import_executions_type_hash_completed_uidx")
    .on(table.importType, table.fileHash)
    .where(sql`file_hash IS NOT NULL AND status = 'completed'`),
  uniqueIndex("import_executions_execution_key_uidx")
    .on(table.executionKey)
    .where(sql`execution_key IS NOT NULL`),
  index("import_executions_lease_idx").on(table.status, table.leaseExpiresAt),
]);

export type ImportExecution = typeof importExecutions.$inferSelect;
export type InsertImportExecution = typeof importExecutions.$inferInsert;

export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  lifecycleVersion:integer("lifecycle_version").notNull().default(1),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone").notNull(),
  companyName: text("company_name"),
  vertical: text("vertical"),
  effectiveVerticalId: text("effective_vertical_id"),
  effectiveVerticalStatus: text("effective_vertical_status"),
  monthlyVolume: text("monthly_volume"),
  estimatedProcessingVolume: text("estimated_processing_volume"),
  estimatedResidual: text("estimated_residual"),
  volumeConfidence: text("volume_confidence"),
  primaryOfferPath: text("primary_offer_path"),
  interestedIn0Percent: boolean("interested_in_0_percent").default(false),
  needTerminal: boolean("need_terminal").default(false),
  currentProvider: text("current_provider"),
  preferredChannel: text("preferred_channel"),
  consentSms: boolean("consent_sms").default(false),
  consentEmail: boolean("consent_email").default(false),
  doNotContact: boolean("do_not_contact").default(false),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  landingPage: text("landing_page"),
  gclid: text("gclid"),
  promoCode: text("promo_code"),
  tags: text("tags").array(),
  notes: text("notes"),
  status: text("status").default("New"),
  ghlContactId: text("ghl_contact_id"),
  leadScore: integer("lead_score").default(0),
  revPotentialScore: integer("rev_potential_score").default(0),
  switchabilityScore: integer("switchability_score").default(0),
  uwConfidenceScore: integer("uw_confidence_score").default(0),
  engagementScore: integer("engagement_score").default(0),
  scoreBreakdown: jsonb("score_breakdown"),
  lastScoredAt: timestamp("last_scored_at"),
  painPoints: text("pain_points").array(),
  contractStatus: text("contract_status"),
  lookingReason: text("looking_reason"),
  referralSource: text("referral_source"),
  avgTicket: text("avg_ticket"),
  locationCount: integer("location_count").default(1),
  businessAge: text("business_age"),
  smsOptInAt: timestamp("sms_opt_in_at"),
  emailOptInAt: timestamp("email_opt_in_at"),
  dncReason: text("dnc_reason"),
  contactAttempts: integer("contact_attempts").default(0),
  lastContactedAt: timestamp("last_contacted_at"),
  lastContactChannel: text("last_contact_channel"),
  coolingUntil: timestamp("cooling_until"),
  title: text("title"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  website: text("website"),
  linkedinUrl: text("linkedin_url"),
  facebookUrl: text("facebook_url"),
  linkedinEnrichedAt: timestamp("linkedin_enriched_at"),
  outreachQueueSkippedAt: timestamp("outreach_queue_skipped_at"),
  linkedinEnrichmentLog: jsonb("linkedin_enrichment_log"),
  industry: text("industry"),
  leadSource: text("lead_source"),
  employeeCount: integer("employee_count"),
  annualRevenue: text("annual_revenue"),
  businessId: integer("business_id").references(() => businesses.id),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  archivedAt: timestamp("archived_at"),
  partnerOrgId: integer("partner_org_id"),
  lastSyncedAt: timestamp("last_synced_at"),
  churnRiskTier: text("churn_risk_tier"),
  isParentAccount: boolean("is_parent_account").default(false),
  parentContactId: integer("parent_contact_id"),
  locationName: text("location_name"),
  emailStatus: text("email_status").notNull().default("unvalidated"),
  // BT-10 validation state is generation-fenced. The legacy emailStatus remains
  // a compatibility projection; provider observations are the evidence source.
  emailMutationGeneration: integer("email_mutation_generation").notNull().default(0),
  emailTokenHash: text("email_token_hash"),
  emailValidationUpdatedAt: timestamp("email_validation_updated_at"),
  bouncedAt: timestamp("bounced_at"),
  // Set when an outbound send bounces for this contact; nullable — most
  // contacts have never bounced. Live DB column predates this typed field
  // (previously only reachable via raw SQL).
  contactBouncedAt: timestamp("contact_bounced_at"),
  isDecisionMaker: boolean("is_decision_maker").notNull().default(false),
  decisionMakerConfidence: integer("decision_maker_confidence").notNull().default(0),
  managementType: text("management_type").notNull().default("unknown"),
  smsStatus: text("sms_status").notNull().default("active"),
  lastVoicemailAt: timestamp("last_voicemail_at"),
  reachabilityScore: integer("reachability_score").notNull().default(100),
  callAttempts: integer("call_attempts").notNull().default(0),
  doNotAutoContact: boolean("do_not_auto_contact").notNull().default(false),
  phoneType: text("phone_type"),
  consentTier: text("consent_tier").notNull().default("cold_no_consent"),
  lifecycleStage: text("lifecycle_stage").notNull().default("prospect"),
  timezone: text("timezone"),
  sourceCategory: text("source_category"),
  offerConfidence: integer("offer_confidence"),
  recommendedNextAction: text("recommended_next_action"),
  offerReasoning: text("offer_reasoning"),
  offerRoutingSource: text("offer_routing_source"),
  processorDetected: text("processor_detected"),
  offerRoutedAt: timestamp("offer_routed_at"),
  offerMatchedSignals: jsonb("offer_matched_signals"),
  optedOutEmail: boolean("opted_out_email").default(false),
  dataCompletenessScore: integer("data_completeness_score"),
  dataReadinessScore: integer("data_readiness_score"),
  dataReadinessGrade: text("data_readiness_grade"),
  readinessBreakdown: jsonb("readiness_breakdown"),
  readinessUpdatedAt: timestamp("readiness_updated_at", {withTimezone:true}),
  readinessModelVersion: integer("readiness_model_version"),
  lastMeaningfulContactMutationAt: timestamp("last_meaningful_contact_mutation_at", {withTimezone:true}),
  // Intake provenance — immutable after first set; dual-field design:
  // sourceCategory (line 99 above) = operational field read by contactability.ts
  // primarySourceCategory = permanent record of acquisition origin
  primarySourceCategory: text("primary_source_category"),
  primarySourceType: text("primary_source_type"),
  // Source events are assigned after contact insertion and retained once selected.
  primarySourceEventId: integer("primary_source_event_id").references((): AnyPgColumn => contactSourceEvents.id, { onDelete: "restrict" }),
  // Vertical provenance — server-assigned only; never accepted from client input.
  // verticalSource: which pipeline/process last set the vertical value.
  // verticalConfidence: 0–100 integer; NULL = not yet scored.
  // manualVerticalOverride: NULL=unknown, false=evaluated/not-overridden, true=confirmed operator override.
  verticalSource: text("vertical_source"),
  verticalConfidence: integer("vertical_confidence"),
  manualVerticalOverride: boolean("manual_vertical_override"),
  // ── Suppression / compliance metadata ────────────────────────────────────
  leadConsentLevel: text("lead_consent_level").default("unknown"),     // unknown|implied|explicit|pewc
  emailReadiness: text("email_readiness").default("unknown"),          // unknown|valid|invalid|bounced|unverifiable
  smsConsentStatus: text("sms_consent_status").default("not_collected"), // not_collected|opted_in|opted_out|a2p_blocked
  optOutStatus: text("opt_out_status").default("active"),              // active|opted_out
  optOutDate: timestamp("opt_out_date"),
  optOutChannel: text("opt_out_channel"),
  unsubscribeStatus: text("unsubscribe_status").default("active"),     // active|unsubscribed
  unsubscribeDate: timestamp("unsubscribe_date"),
  bounceStatus: text("bounce_status").default("none"),                 // none|soft|hard
  bounceDate: timestamp("bounce_date"),
  bounceReason: text("bounce_reason"),
  complaintStatus: text("complaint_status").default("none"),           // none|reported
  complaintDate: timestamp("complaint_date"),
  dncDate: timestamp("dnc_date"),
  dncSource: text("dnc_source"),
  existingMerchantCustomer: boolean("existing_merchant_customer").default(false),
  suppressionReason: text("suppression_reason"),
  suppressionHistory: jsonb("suppression_history").default(sql`'[]'::jsonb`),
  nextAllowedContactDate: timestamp("next_allowed_contact_date"),
  consentAuditTrail: jsonb("consent_audit_trail").default(sql`'[]'::jsonb`),
  // ── Attribution extras ────────────────────────────────────────────────────
  referrerUrl: text("referrer_url"),
  sourcePath: text("source_path"),
  // importBatchId links every contact to its import_executions record so
  // admins can query "all contacts from batch X" without joining tables.
  importBatchId: text("import_batch_id"),
  rowProvenance: jsonb("row_provenance"),
  // ── Rep assignment ────────────────────────────────────────────────────────
  // Stores the email of the rep who owns this contact (consistent with deals.owner).
  // NULL = unassigned. Set manually or auto-populated from the deal owner.
  assignedTo: text("assigned_to"),
  // ── Canonical lifecycle state ─────────────────────────────────────────────
  // Observer/derived field managed by LifecycleService. Never set directly.
  // Valid values: see LIFECYCLE_STATES in server/services/lifecycle-service.ts
  lifecycleState: text("lifecycle_state").notNull().default("PROSPECT"),
  lifecycleStateUpdatedAt: timestamp("lifecycle_state_updated_at"),
  // ── Lead freshness SLA ────────────────────────────────────────────────────
  // Set by processNewLead() for high-score leads (score >= LEAD_SLA_SCORE_THRESHOLD).
  // The SLA worker checks this every 5 minutes and escalates when past-due
  // with no human touch. NULL = not yet set or already resolved.
  nextSlaDueAt: timestamp("next_sla_due_at"),
  // ── BT-06: Commercial classification ─────────────────────────────────────
  // Managed ONLY by CommercialClassificationAuthority; never set directly.
  // See server/services/commercial-classification-authority.ts.
  // Vocabulary: production | test | demo | synthetic | unknown (default)
  recordClass: text("record_class").notNull().default("unknown"),
}, (table) => [
  index("contacts_active_email_idx").on(table.email).where(sql`archived_at IS NULL`),
  index("contacts_phone_idx").on(table.phone),
  uniqueIndex("contacts_ghl_contact_id_unique").on(table.ghlContactId).where(sql`ghl_contact_id IS NOT NULL AND BTRIM(ghl_contact_id) <> ''`),
  index("contacts_created_at_idx").on(table.createdAt),
  index("contacts_email_archived_at_idx").on(table.email, table.archivedAt),
  index("contacts_phone_archived_at_idx").on(table.phone, table.archivedAt),
  index("contacts_lifecycle_state_idx").on(table.lifecycleState),
  check("contacts_vertical_confidence_range", sql`vertical_confidence IS NULL OR (vertical_confidence BETWEEN 0 AND 100)`),
]);

export const insertContactSchema = createInsertSchema(contacts).omit({
  id: true,
  // BT-06: classification is authority-managed and never client supplied.
  recordClass: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
  // Provenance fields are server-assigned only — never accepted from client input.
  // Use serverInsertContactSchema (below) for internal writes that need these.
  sourceCategory: true,
  primarySourceCategory: true,
  primarySourceType: true,
  primarySourceEventId: true,
  // Vertical provenance — server-assigned; clients cannot forge vertical authority.
  verticalSource: true,
  verticalConfidence: true,
  manualVerticalOverride: true,
});

// Internal-only schema used by writeContact() — includes provenance fields.
// Never expose this to client-facing request parsing.
export const serverInsertContactSchema = createInsertSchema(contacts).omit({
  id: true,
  createdAt: true,
  recordClass: true,
  updatedAt: true,
  archivedAt: true,
});
export type ServerInsertContact = z.infer<typeof serverInsertContactSchema>;

// ---------------------------------------------------------------------------
// Contact Source Events — one row per intake event per contact
// UNIQUE (contact_id, event_key) prevents duplicate ingestion of same event
// ---------------------------------------------------------------------------
export const contactSourceEvents = pgTable("contact_source_events", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  // eventKey is server-generated, non-null, guaranteed unique per contact.
  // Examples: form:statement_upload:<nanoid>, ghl:<ghlId>:<hash>, import:<execId>:row:<n>
  eventKey: text("event_key").notNull(),
  sourceCategory: text("source_category").notNull(),
  sourceType: text("source_type").notNull(),
  sourceExternalId: text("source_external_id"),
  importExecutionId: uuid("import_execution_id").references(() => importExecutions.id),
  sourceRowNumber: integer("source_row_number"),
  rowFingerprint: text("row_fingerprint"),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  metadata: jsonb("metadata"),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  // Core idempotency constraint — non-null eventKey ensures this always fires
  uniqueIndex("contact_source_events_contact_key_uidx").on(table.contactId, table.eventKey),
  index("contact_source_events_contact_id_idx").on(table.contactId),
  index("contact_source_events_import_execution_idx").on(table.importExecutionId),
]);

export type ContactSourceEvent = typeof contactSourceEvents.$inferSelect;
export type InsertContactSourceEvent = typeof contactSourceEvents.$inferInsert;

// ---------------------------------------------------------------------------
// Canonical intake durability — immutable CSV row accounting and provider work
// ---------------------------------------------------------------------------
export const importRowDispositions = pgTable("import_row_dispositions", {
  id: serial("id").primaryKey(),
  executionId: uuid("execution_id").notNull().references(() => importExecutions.id, { onDelete: "cascade" }),
  // One-based logical record number from the parsed CSV, excluding the header.
  sourceRowNumber: integer("source_row_number").notNull(),
  rowFingerprint: text("row_fingerprint").notNull(),
  disposition: text("disposition").notNull(), // created|matched_noop|updated|rejected|deferred|failed
  reasonCode: text("reason_code").notNull(),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  diagnostic: jsonb("diagnostic"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("import_row_dispositions_execution_row_uidx").on(table.executionId, table.sourceRowNumber),
  index("import_row_dispositions_execution_disposition_idx").on(table.executionId, table.disposition),
]);
export type ImportRowDisposition = typeof importRowDispositions.$inferSelect;

export const contactProviderProjections = pgTable("contact_provider_projections", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("ghl"),
  projectionKey: text("projection_key").notNull(),
  state: text("state").notNull().default("pending"), // pending|processing|succeeded|retry|terminal
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  terminalReason: text("terminal_reason"),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  uniqueIndex("contact_provider_projections_contact_key_uidx").on(table.contactId, table.provider, table.projectionKey),
  index("contact_provider_projections_claim_idx").on(table.provider, table.state, table.nextAttemptAt),
]);
export type ContactProviderProjection = typeof contactProviderProjections.$inferSelect;

// ---------------------------------------------------------------------------
// BT-10 provider health, durable operations, and safe eligibility controls.
// These rows intentionally keep provider evidence separate from consent,
// identity, intake provenance, GHL projections, and manual field authority.
// ---------------------------------------------------------------------------
export const providerControls = pgTable("provider_controls", {
  provider: text("provider").primaryKey(),
  capability: text("capability").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  circuitState: text("circuit_state").notNull().default("closed"),
  localBudgetUnits: integer("local_budget_units"),
  reservedUnits: integer("reserved_units").notNull().default(0),
  consumedUnits: integer("consumed_units").notNull().default(0),
  windowStartedAt: timestamp("window_started_at"),
  windowEndsAt: timestamp("window_ends_at"),
  lastCompletedAt: timestamp("last_completed_at"),
  lastOutcome: text("last_outcome"),
  lastErrorCode: text("last_error_code"),
  observedAt: timestamp("observed_at"),
  version: integer("version").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const providerOperations = pgTable("provider_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().references(() => providerControls.provider),
  operationType: text("operation_type").notNull(),
  purpose: text("purpose").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  targetFingerprint: text("target_fingerprint").notNull(),
  state: text("state").notNull().default("pending"),
  requestedUnits: integer("requested_units").notNull().default(0),
  reservedUnits: integer("reserved_units").notNull().default(0),
  settledUnits: integer("settled_units").notNull().default(0),
  runtimeOwnerEpoch: bigint("runtime_owner_epoch", { mode: "number" }),
  runtimeOwnerToken: uuid("runtime_owner_token"),
  providerRequestId: text("provider_request_id"),
  providerUsageQuantity: numeric("provider_usage_quantity"),
  providerUsageUnit: text("provider_usage_unit"),
  providerUsageStatus: text("provider_usage_status"),
  providerUsageReconciledAt: timestamp("provider_usage_reconciled_at", { withTimezone: true }),
  sfpDispatchReceipt: jsonb("sfp_dispatch_receipt"),
  sfpDispatchReceiptFingerprint: text("sfp_dispatch_receipt_fingerprint"),
  // Exact reviewed-price snapshot cost for SFP operations. Legacy and
  // non-SFP provider operations remain NULL rather than being backfilled
  // from today's price as if it were historical fact.
  unitPriceMicros: bigint("unit_price_micros", { mode: "number" }),
  unitPriceUnit: text("unit_price_unit"),
  settledCostMicros: bigint("settled_cost_micros", { mode: "number" }),
  billingState: text("billing_state").notNull().default("none"),
  attemptCount: integer("attempt_count").notNull().default(0),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  cancelRequestedAt: timestamp("cancel_requested_at"),
  failureCode: text("failure_code"),
  sfpResultData: jsonb("sfp_result_data"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("provider_operations_idempotency_schema_uidx").on(table.provider, table.idempotencyKey),
  uniqueIndex("provider_operations_provider_request_uidx").on(table.provider, table.providerRequestId)
    .where(sql`${table.providerRequestId} IS NOT NULL`),
  index("provider_operations_claim_schema_idx").on(table.provider, table.state, table.leaseExpiresAt),
  check("provider_operations_settled_units_nonnegative_chk", sql`settled_units >= 0`),
  check("provider_operations_usage_contract_chk",
    sql`provider_usage_status IS NULL OR provider_usage_status IN ('known','unknown','conflict','not_applicable')`),
  check("provider_operations_known_usage_complete_chk", sql`
    provider_usage_status IS DISTINCT FROM 'known'
    OR (provider_usage_quantity IS NOT NULL AND provider_usage_quantity >= 0 AND provider_usage_unit IS NOT NULL)
  `),
  check("provider_operations_dispatch_receipt_contract_chk", sql`
    (sfp_dispatch_receipt IS NULL AND sfp_dispatch_receipt_fingerprint IS NULL)
    OR (sfp_dispatch_receipt IS NOT NULL AND sfp_dispatch_receipt_fingerprint IS NOT NULL
      AND jsonb_typeof(sfp_dispatch_receipt)='object'
      AND sfp_dispatch_receipt_fingerprint ~ '^[0-9a-f]{64}$')
  `),
]);

/** Durable current routine-SFP deployment owner. CRO03C certificate authority is separate. */
export const sfpRuntimeOwnerAuthority = pgTable("sfp_runtime_owner_authority", {
  authorityKey: text("authority_key").primaryKey().default("routine_sfp"),
  deploymentIdentity: text("deployment_identity").notNull(),
  environmentIdentity: text("environment_identity").notNull(),
  artifactSha: text("artifact_sha").notNull(),
  queueTopologyHash: text("queue_topology_hash").notNull(),
  ownerEpoch: bigint("owner_epoch", { mode: "number" }).notNull(),
  ownerToken: uuid("owner_token").notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("sfp_runtime_owner_authority_singleton_chk", sql`authority_key = 'routine_sfp'`),
  check("sfp_runtime_owner_authority_epoch_chk", sql`owner_epoch > 0`),
]);

/** Append-only audit evidence for authenticated SFP release bootstrap/transfer. */
export const sfpRuntimeReleaseSelectionEvents = pgTable("sfp_runtime_release_selection_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  action: text("action").notNull(),
  actorId: text("actor_id").notNull(),
  previousSelection: jsonb("previous_selection"),
  selectedRelease: jsonb("selected_release").notNull(),
  publisherVerificationReference: text("publisher_verification_reference").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sfp_runtime_release_selection_events_created_idx").on(table.createdAt),
  check("sfp_runtime_release_selection_event_action_chk", sql`action IN ('bootstrap','transfer')`),
  check("sfp_runtime_release_selection_event_actor_chk", sql`length(btrim(actor_id)) > 0`),
  check("sfp_runtime_release_selection_event_verification_chk",
    sql`length(btrim(publisher_verification_reference)) BETWEEN 1 AND 500`),
  check("sfp_runtime_release_selection_event_release_object_chk", sql`jsonb_typeof(selected_release) = 'object'`),
  check("sfp_runtime_release_selection_event_previous_object_chk",
    sql`previous_selection IS NULL OR jsonb_typeof(previous_selection) = 'object'`),
]);

/** Non-expiring admin-selected SFP release authority, separate from its leased owner row. */
export const sfpRuntimeReleaseSelectors = pgTable("sfp_runtime_release_selectors", {
  authorityKey: text("authority_key").primaryKey().default("routine_sfp"),
  deploymentIdentity: text("deployment_identity").notNull(),
  environmentIdentity: text("environment_identity").notNull(),
  artifactSha: text("artifact_sha").notNull(),
  queueTopologyHash: text("queue_topology_hash").notNull(),
  publisherVerifiedArtifactSha: text("publisher_verified_artifact_sha").notNull(),
  publisherVerifiedDeploymentIdentity: text("publisher_verified_deployment_identity").notNull(),
  verificationReference: text("verification_reference").notNull(),
  selectedBy: text("selected_by").notNull(),
  selectedAt: timestamp("selected_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  selectionVersion: bigint("selection_version", { mode: "number" }).notNull().default(1),
  selectionEventId: uuid("selection_event_id").notNull()
    .references(() => sfpRuntimeReleaseSelectionEvents.id, { onDelete: "restrict" }),
}, (table) => [
  check("sfp_runtime_release_selector_singleton_chk", sql`authority_key = 'routine_sfp'`),
  check("sfp_runtime_release_selector_sha_chk", sql`
    artifact_sha ~ '^[0-9a-fA-F]{40}$' AND publisher_verified_artifact_sha = artifact_sha
  `),
  check("sfp_runtime_release_selector_deployment_chk", sql`
    deployment_identity <> '' AND publisher_verified_deployment_identity = deployment_identity
  `),
  check("sfp_runtime_release_selector_environment_chk", sql`environment_identity <> ''`),
  check("sfp_runtime_release_selector_topology_chk", sql`queue_topology_hash ~ '^[0-9a-fA-F]{64}$'`),
  check("sfp_runtime_release_selector_verification_chk",
    sql`length(btrim(verification_reference)) BETWEEN 1 AND 500`),
  check("sfp_runtime_release_selector_actor_chk", sql`length(btrim(selected_by)) > 0`),
  check("sfp_runtime_release_selector_version_chk", sql`selection_version > 0`),
]);

/** Token/epoch-fenced per-operation owner lease; integer work leases stay separate from billing usage. */
export const sfpRuntimeJobLeases = pgTable("sfp_runtime_job_leases", {
  operationId: uuid("operation_id").primaryKey().references(() => providerOperations.id, { onDelete: "restrict" }),
  deploymentIdentity: text("deployment_identity").notNull(),
  environmentIdentity: text("environment_identity").notNull(),
  artifactSha: text("artifact_sha").notNull(),
  processIdentity: text("process_identity").notNull(),
  ownerEpoch: bigint("owner_epoch", { mode: "number" }).notNull(),
  ownerToken: uuid("owner_token").notNull(),
  operationClaimToken: uuid("operation_claim_token").notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sfp_runtime_job_leases_owner_idx").on(table.deploymentIdentity, table.ownerEpoch, table.leaseExpiresAt),
  check("sfp_runtime_job_leases_epoch_chk", sql`owner_epoch > 0`),
]);

/** Request-ID keyed async provider billing reconciliation, idempotent per economic operation. */
export const sfpProviderUsageReconciliations = pgTable("sfp_provider_usage_reconciliations", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().references(() => providerControls.provider),
  providerRequestId: text("provider_request_id").notNull(),
  operationId: uuid("operation_id").notNull().references(() => providerOperations.id, { onDelete: "restrict" }),
  usageQuantity: numeric("usage_quantity"),
  usageUnit: text("usage_unit"),
  usageStatus: text("usage_status").notNull().default("unknown"),
  reconciliationSource: text("reconciliation_source"),
  resultHash: text("result_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("sfp_provider_usage_operation_request_uidx").on(table.provider, table.providerRequestId),
  index("sfp_provider_usage_operation_idx").on(table.operationId),
  check("sfp_provider_usage_status_chk", sql`usage_status IN ('known','unknown','conflict')`),
  check("sfp_provider_usage_known_contract_chk", sql`
    usage_status <> 'known' OR (usage_quantity IS NOT NULL AND usage_quantity >= 0 AND usage_unit IS NOT NULL)
  `),
]);

export const providerAttempts = pgTable("provider_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => providerOperations.id, { onDelete: "cascade" }),
  attemptNumber: integer("attempt_number").notNull(),
  outcome: text("outcome").notNull().default("pending"),
  retryable: boolean("retryable").notNull().default(false),
  safeHttpClass: text("safe_http_class"),
  requestId: text("request_id"),
  errorCode: text("error_code"),
  dispatchMarkedAt: timestamp("dispatch_marked_at", { withTimezone: true }),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  uniqueIndex("provider_attempts_operation_number_schema_uidx").on(table.operationId, table.attemptNumber),
]);

export const providerObservations = pgTable("provider_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().references(() => providerControls.provider),
  operationId: uuid("operation_id").references(() => providerOperations.id, { onDelete: "set null" }),
  attemptId: uuid("attempt_id").references(() => providerAttempts.id, { onDelete: "set null" }),
  subjectType: text("subject_type").notNull(),
  subjectId: integer("subject_id").notNull(),
  emailTokenHash: text("email_token_hash"),
  subjectGeneration: integer("subject_generation"),
  outcome: text("outcome").notNull(),
  safeHttpClass: text("safe_http_class"),
  requestId: text("request_id"),
  evidenceHash: text("evidence_hash"),
  retryable: boolean("retryable").notNull().default(false),
  observedAt: timestamp("observed_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("provider_observations_subject_schema_idx").on(table.subjectType, table.subjectId, table.observedAt),
  index("provider_observations_email_schema_idx").on(table.subjectId, table.emailTokenHash, table.subjectGeneration, table.observedAt),
  index("canonical_address_receipt_lookup_idx").on(table.emailTokenHash,table.observedAt.desc())
    .where(sql`provider='zerobounce' AND retryable=FALSE AND outcome IN ('valid','invalid')`),
]);

// ---------------------------------------------------------------------------
// CRO-03 durable enrichment factory. Membership/evidence rows are immutable;
export const canonicalAddressValidationClaims = pgTable("canonical_address_validation_claims", {
  emailTokenHash: text("email_token_hash").primaryKey(),
  normalizationVersion: integer("normalization_version").notNull().default(1),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  operationId: uuid("operation_id").references(() => providerOperations.id, { onDelete: "restrict" }),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check("canonical_address_validation_claims_hash_check", sql`${table.emailTokenHash} ~ '^[a-f0-9]{64}$'`),
  check("canonical_address_validation_claims_version_check", sql`${table.normalizationVersion}=1`),
  check("canonical_address_validation_claims_lease_check",
    sql`(${table.claimToken} IS NULL)=(${table.leaseExpiresAt} IS NULL)`),
  check("canonical_address_validation_claims_dispatch_check",
    sql`${table.dispatchedAt} IS NULL OR ${table.operationId} IS NOT NULL`),
]);
// execution rows are mutable and recoverable through claim leases.
// Candidate values are encrypted envelopes, never raw provider payloads.
// ---------------------------------------------------------------------------
export const cro03EnrichmentBatches = pgTable("cro03_enrichment_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  purpose: text("purpose").notNull().default("provider_pre_spend"),
  selectionPolicyVersion: integer("selection_policy_version").notNull().default(1),
  routingPolicyVersion: integer("routing_policy_version").notNull().default(1),
  state: text("state").notNull().default("queued"),
  totalCount: integer("total_count").notNull().default(0),
  executableCount: integer("executable_count").notNull().default(0),
  blockedCount: integer("blocked_count").notNull().default(0),
  completedCount: integer("completed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  cancelledCount: integer("cancelled_count").notNull().default(0),
  selectionHash: text("selection_hash").notNull(),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03BatchMemberships = pgTable("cro03_batch_memberships", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id").notNull().references(() => cro03EnrichmentBatches.id, { onDelete: "cascade" }),
  ordinal: integer("ordinal").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: integer("subject_id").notNull(),
  rootSubjectType: text("root_subject_type").notNull(),
  rootSubjectId: integer("root_subject_id").notNull(),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
  businessId: integer("business_id").references(() => businesses.id, { onDelete: "restrict" }),
  selectionPolicyVersion: integer("selection_policy_version").notNull(),
  dependencyFingerprint: text("dependency_fingerprint").notNull(),
  preSpendSnapshotId: uuid("pre_spend_snapshot_id").references(() => commercialResolutionSnapshots.id, { onDelete: "restrict" }),
  preSpendDecision: text("pre_spend_decision").notNull(),
  disposition: text("disposition").notNull().default("executable"),
  dispositionReason: text("disposition_reason"),
  membershipHash: text("membership_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03EnrichmentItems = pgTable("cro03_enrichment_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchId: uuid("batch_id").notNull().references(() => cro03EnrichmentBatches.id, { onDelete: "cascade" }),
  membershipId: uuid("membership_id").notNull().unique().references(() => cro03BatchMemberships.id, { onDelete: "restrict" }),
  state: text("state").notNull().default("queued"),
  currentProvider: text("current_provider"),
  currentProviderRunId: uuid("current_provider_run_id"),
  attemptCount: integer("attempt_count").notNull().default(0),
  executionFence: integer("execution_fence").notNull().default(0),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  terminalCode: text("terminal_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03ProviderRuns = pgTable("cro03_provider_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03EnrichmentItems.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  operationId: uuid("operation_id").references(() => providerOperations.id, { onDelete: "restrict" }),
  routePolicyVersion: integer("route_policy_version").notNull(),
  purpose: text("purpose").notNull(),
  state: text("state").notNull().default("planned"),
  providerOutcome: text("provider_outcome"),
  billingDisposition: text("billing_disposition").notNull().default("none"),
  targetFingerprint: text("target_fingerprint").notNull(),
  authorizationContextHash: text("authorization_context_hash"),
  attemptCount: integer("attempt_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const cro03Candidates = pgTable("cro03_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03EnrichmentItems.id, { onDelete: "restrict" }),
  providerRunId: uuid("provider_run_id").notNull().references(() => cro03ProviderRuns.id, { onDelete: "restrict" }),
  observationId: uuid("observation_id").references(() => providerObservations.id, { onDelete: "restrict" }),
  field: text("field").notNull(),
  normalizedValueHash: text("normalized_value_hash").notNull(),
  maskedValue: text("masked_value").notNull(),
  envelopeCiphertext: text("envelope_ciphertext").notNull(),
  envelopeNonce: text("envelope_nonce").notNull(),
  envelopeTag: text("envelope_tag").notNull(),
  envelopeKeyVersion: integer("envelope_key_version").notNull().default(1),
  subjectGeneration: integer("subject_generation"),
  confidence: integer("confidence").notNull().default(0),
  sourceRank: integer("source_rank").notNull().default(100),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03ArbitrationDecisions = pgTable("cro03_arbitration_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03EnrichmentItems.id, { onDelete: "restrict" }),
  field: text("field").notNull(),
  state: text("state").notNull().default("pending"),
  winningCandidateId: uuid("winning_candidate_id").references(() => cro03Candidates.id, { onDelete: "restrict" }),
  decisionKey: text("decision_key").notNull().unique(),
  reasonCode: text("reason_code").notNull(),
  candidateCount: integer("candidate_count").notNull().default(0),
  policyVersion: integer("policy_version"),
  policyHash: text("policy_hash"),
  candidateSetHash: text("candidate_set_hash"),
  confidenceThreshold: integer("confidence_threshold"),
  minimumMargin: integer("minimum_margin"),
  topConfidence: integer("top_confidence"),
  runnerUpConfidence: integer("runner_up_confidence"),
  reviewReason: text("review_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("cro03_arbitration_item_field_schema_uidx").on(table.itemId, table.field),
]);

export const cro03MutationCommands = pgTable("cro03_mutation_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03EnrichmentItems.id, { onDelete: "restrict" }),
  candidateId: uuid("candidate_id").notNull().references(() => cro03Candidates.id, { onDelete: "restrict" }),
  mutationKey: text("mutation_key").notNull().unique(),
  subjectType: text("subject_type").notNull(),
  subjectId: integer("subject_id").notNull(),
  field: text("field").notNull(),
  expectedGeneration: integer("expected_generation"),
  expectedValueHash: text("expected_value_hash").notNull(),
  state: text("state").notNull().default("pending"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  disposition: text("disposition").notNull().default("pending"),
  failureCode: text("failure_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03ProviderLedger = pgTable("cro03_provider_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerRunId: uuid("provider_run_id").notNull().references(() => cro03ProviderRuns.id, { onDelete: "restrict" }),
  providerOperationId: uuid("provider_operation_id").references(() => providerOperations.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  entryKey: text("entry_key").notNull().unique(),
  disposition: text("disposition").notNull(),
  units: integer("units").notNull().default(0),
  amountMicros: bigint("amount_micros", { mode: "number" }).notNull().default(0),
  receiptReference: text("receipt_reference"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03Receipts = pgTable("cro03_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerRunId: uuid("provider_run_id").notNull().references(() => cro03ProviderRuns.id, { onDelete: "restrict" }),
  providerOperationId: uuid("provider_operation_id").references(() => providerOperations.id, { onDelete: "restrict" }),
  receiptKey: text("receipt_key").notNull().unique(),
  providerRequestHash: text("provider_request_hash"),
  receiptReference: text("receipt_reference"),
  billingDisposition: text("billing_disposition").notNull(),
  units: integer("units").notNull().default(0),
  amountMicros: bigint("amount_micros", { mode: "number" }).notNull().default(0),
  redactedMetadata: jsonb("redacted_metadata").notNull().default(sql`'{}'::jsonb`),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03SourceSubjects = pgTable("cro03_source_subjects", {
  id: uuid("id").primaryKey().defaultRandom(),
  subjectType: text("subject_type").notNull(),
  subjectKey: text("subject_key").notNull(),
  sourceSystem: text("source_system").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // NOTE: this column is already live in production (added outside a tracked
  // Drizzle migration) and is actively read/written via raw SQL in
  // source-registry/import-runner.ts, routes/source-registry.ts, and
  // routes/lead-ops.ts for soft-delete/reclaim of source subjects. It must
  // never be dropped. This entry only adds the missing typed representation;
  // it does not change the live column.
  tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("cro03_source_subject_unique").on(table.subjectType, table.sourceSystem, table.subjectKey),
  // Matches migration 0250: extends the original 0187 list with 'business'.
  // Declared here (not just in the migration file) so Publish's schema diff
  // can actually apply it to production — Publish diffs shared/schema.ts
  // against live production, it does not execute migrations/*.sql directly.
  check("cro03_source_subject_type_chk", sql`subject_type IN ('contact','prospect','sunbiz_entity','sdr_merchant','provider_csv_row','public_web','lead_discovery_result','master_lead','business')`),
]);

export const cro03SourceObservations = pgTable("cro03_source_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceSubjectId: uuid("source_subject_id").notNull().references(() => cro03SourceSubjects.id, { onDelete: "restrict" }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  observedByActorType: text("observed_by_actor_type").notNull(),
  observedByActorId: text("observed_by_actor_id"),
  provenance: jsonb("provenance").notNull(),
  payload: jsonb("payload").notNull(),
  payloadHash: text("payload_hash").notNull(),
  hashAlgorithmVersion: text("hash_algorithm_version").notNull().default("sha256-v1"),
  geographyBackfillAttemptedAt: timestamp("geography_backfill_attempted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro03_source_observation_unique").on(table.sourceSubjectId, table.payloadHash),
  index("cro03_obs_geo_backfill_pending_idx").on(table.createdAt).where(sql`geography_backfill_attempted_at IS NULL`),
]);

export const cro03SourceOccurrences = pgTable("cro03_source_occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceSubjectId: uuid("source_subject_id").notNull().references(() => cro03SourceSubjects.id, { onDelete: "restrict" }),
  sourceObservationId: uuid("source_observation_id").notNull().references(() => cro03SourceObservations.id, { onDelete: "restrict" }),
  sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }).notNull(),
  importObservedAt: timestamp("import_observed_at", { withTimezone: true }),
  manuallyAttestedAt: timestamp("manually_attested_at", { withTimezone: true }),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  timestampProvenance: text("timestamp_provenance").notNull(),
  sourceEventKey: text("source_event_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  contractVersion: text("contract_version").notNull().default("cro03a-source-v1"),
  normalizationVersion: integer("normalization_version").notNull().default(1),
  hashAlgorithmVersion: text("hash_algorithm_version").notNull().default("sha256-v1"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro03a_occurrence_source_event_uidx").on(table.sourceSubjectId, table.sourceEventKey),
  index("cro03a_occurrences_subject_time_idx").on(table.sourceSubjectId, table.sourceObservedAt, table.ingestedAt),
]);

export const cro03aPolicyDocuments = pgTable("cro03a_policy_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  policyKey: text("policy_key").notNull(),
  version: integer("version").notNull(),
  policy: jsonb("policy").notNull(),
  policyHash: text("policy_hash").notNull(),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro03a_policy_identity_uidx").on(table.policyKey, table.version),
]);

export const cro03aPolicyControl = pgTable("cro03a_policy_control", {
  id: integer("id").primaryKey().default(1),
  activePolicyId: uuid("active_policy_id").references(() => cro03aPolicyDocuments.id, { onDelete: "restrict" }),
  expectedVersion: integer("expected_version").notNull().default(0),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03aQualificationRuns = pgTable("cro03a_qualification_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  actorId: text("actor_id").notNull(),
  actorRole: text("actor_role").notNull(),
  policyId: uuid("policy_id").notNull().references(() => cro03aPolicyDocuments.id, { onDelete: "restrict" }),
  policyHash: text("policy_hash").notNull(),
  algorithmIdentity: jsonb("algorithm_identity"),
  algorithmIdentityHash: text("algorithm_identity_hash"),
  scopeHash: text("scope_hash").notNull(),
  frozenOccurrenceIds: jsonb("frozen_occurrence_ids").notNull(),
  state: text("state").notNull().default("queued"),
  totalCount: integer("total_count").notNull().default(0),
  selectedCount: integer("selected_count").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  terminalCount: integer("terminal_count").notNull().default(0),
  cursorPosition: integer("cursor_position").notNull().default(0),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03aQualificationItems = pgTable("cro03a_qualification_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => cro03aQualificationRuns.id, { onDelete: "restrict" }),
  occurrenceId: uuid("occurrence_id").notNull().references(() => cro03SourceOccurrences.id, { onDelete: "restrict" }),
  ordinal: integer("ordinal").notNull(),
  state: text("state").notNull().default("queued"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  executionFence: integer("execution_fence").notNull().default(0),
  authorityEvidence: jsonb("authority_evidence").notNull().default({}),
  authorityEvaluatedAt: timestamp("authority_evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro03a_item_run_occurrence_uidx").on(table.runId, table.occurrenceId),
  uniqueIndex("cro03a_item_run_ordinal_uidx").on(table.runId, table.ordinal),
]);

export const cro03aQualificationDecisions = pgTable("cro03a_qualification_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().unique().references(() => cro03aQualificationItems.id, { onDelete: "restrict" }),
  runId: uuid("run_id").notNull().references(() => cro03aQualificationRuns.id, { onDelete: "restrict" }),
  occurrenceId: uuid("occurrence_id").notNull().references(() => cro03SourceOccurrences.id, { onDelete: "restrict" }),
  disposition: text("disposition").notNull(),
  score: integer("score").notNull(),
  geographyResult: jsonb("geography_result").notNull(),
  verticalResult: jsonb("vertical_result").notNull(),
  activeStateEvidence: jsonb("active_state_evidence").notNull(),
  identityRelationshipEvidence: jsonb("identity_relationship_evidence").notNull(),
  fitComponents: jsonb("fit_components").notNull(),
  reasonCodes: jsonb("reason_codes").notNull(),
  missingFieldClasses: jsonb("missing_field_classes").notNull().default([]),
  frozenOccurrenceIds: jsonb("frozen_occurrence_ids").notNull(),
  policyId: uuid("policy_id").notNull().references(() => cro03aPolicyDocuments.id, { onDelete: "restrict" }),
  algorithmIdentity: jsonb("algorithm_identity"),
  algorithmIdentityHash: text("algorithm_identity_hash"),
  policyVersion: integer("policy_version").notNull(),
  policyHash: text("policy_hash").notNull(),
  selectionHash: text("selection_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("cro03a_decisions_disposition_idx").on(table.disposition, table.createdAt),
]);

export const cro03aHandoffs = pgTable("cro03a_handoffs", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => cro03aQualificationRuns.id, { onDelete: "restrict" }),
  decisionId: uuid("decision_id").notNull().unique().references(() => cro03aQualificationDecisions.id, { onDelete: "restrict" }),
  sourceType: text("source_type").notNull(),
  sourceSystem: text("source_system").notNull(),
  sourceKey: text("source_key").notNull(),
  occurrenceIds: jsonb("occurrence_ids").notNull(),
  policyId: uuid("policy_id").notNull().references(() => cro03aPolicyDocuments.id, { onDelete: "restrict" }),
  policyVersion: integer("policy_version").notNull(),
  policyHash: text("policy_hash").notNull(),
  reasonCodes: jsonb("reason_codes").notNull(),
  missingFieldClasses: jsonb("missing_field_classes").notNull().default([]),
  selectionHash: text("selection_hash").notNull(),
  effectAuthorized: boolean("effect_authorized").notNull().default(false),
  algorithmIdentity: jsonb("algorithm_identity"),
  algorithmIdentityHash: text("algorithm_identity_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("cro03a_handoffs_source_idx").on(table.sourceType, table.sourceSystem, table.sourceKey),
  uniqueIndex("cro03a_handoffs_source_unique").on(table.sourceType, table.sourceSystem, table.sourceKey),
]);

export const cro03aConsumptionReceipts = pgTable("cro03a_consumption_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  handoffId: uuid("handoff_id").notNull().references(() => cro03aHandoffs.id, { onDelete: "restrict" }),
  consumerKey: text("consumer_key").notNull().unique(),
  consumerName: text("consumer_name").notNull().default("cro03b"),
  receiptMetadata: jsonb("receipt_metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03aCensusCursors = pgTable("cro03a_census_cursors", {
  sourceSystem: text("source_system").primaryKey(),
  snapshotKey: text("snapshot_key").notNull(),
  snapshotHighWater: bigint("snapshot_high_water", { mode: "number" }).notNull(),
  cursorValue: bigint("cursor_value", { mode: "number" }).notNull().default(0),
  snapshotHighWaterText: text("snapshot_high_water_text"),
  cursorValueText: text("cursor_value_text"),
  policyId: uuid("policy_id").notNull().references(() => cro03aPolicyDocuments.id, { onDelete: "restrict" }),
  policyHash: text("policy_hash").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03bRecipeDefinitions = pgTable("cro03b_recipe_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipeKey: text("recipe_key").notNull(),
  version: integer("version").notNull(),
  recipe: jsonb("recipe").notNull(),
  recipeHash: text("recipe_hash").notNull(),
  status: text("status").notNull().default("draft"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03b_recipe_identity_uidx").on(table.recipeKey, table.version)]);

export const cro03bRecipeCommands = pgTable("cro03b_recipe_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  commandKey: text("command_key").notNull().unique(),
  actorId: text("actor_id").notNull(),
  actorRole: text("actor_role").notNull(),
  recipeDefinitionId: uuid("recipe_definition_id").notNull().references(() => cro03bRecipeDefinitions.id, { onDelete: "restrict" }),
  recipeVersion: integer("recipe_version").notNull(),
  recipeHash: text("recipe_hash").notNull(),
  payloadHash: text("payload_hash").notNull(),
  reason: text("reason"),
  state: text("state").notNull().default("queued"),
  totalCount: integer("total_count").notNull(),
  terminalCount: integer("terminal_count").notNull().default(0),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03bRecipeItems = pgTable("cro03b_recipe_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  commandId: uuid("command_id").notNull().references(() => cro03bRecipeCommands.id, { onDelete: "restrict" }),
  handoffId: uuid("handoff_id").notNull().references(() => cro03aHandoffs.id, { onDelete: "restrict" }),
  originatingRunId: uuid("originating_run_id").notNull().references(() => cro03aQualificationRuns.id, { onDelete: "restrict" }),
  ownerActorId: text("owner_actor_id").notNull(),
  recipeVersion: integer("recipe_version").notNull(),
  frozenHandoffHash: text("frozen_handoff_hash").notNull(),
  frozenRecipeHash: text("frozen_recipe_hash").notNull(),
  payloadHash: text("payload_hash").notNull(),
  state: text("state").notNull().default("queued"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  executionFence: integer("execution_fence").notNull().default(0),
  terminalCode: text("terminal_code"),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
  businessId: integer("business_id").references(() => businesses.id, { onDelete: "restrict" }),
  reviewRequestedAt: timestamp("review_requested_at", { withTimezone: true }),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro03b_handoff_recipe_uidx").on(table.handoffId, table.recipeVersion),
  index("cro03b_item_claim_idx").on(table.state, table.leaseExpiresAt, table.createdAt),
]);

export const cro03bRecipeReceipts = pgTable("cro03b_recipe_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  commandId: uuid("command_id").notNull().references(() => cro03bRecipeCommands.id, { onDelete: "restrict" }),
  itemId: uuid("item_id").references(() => cro03bRecipeItems.id, { onDelete: "restrict" }),
  handoffId: uuid("handoff_id").notNull().references(() => cro03aHandoffs.id, { onDelete: "restrict" }),
  receiptType: text("receipt_type").notNull(),
  receiptKey: text("receipt_key").notNull().unique(),
  payloadHash: text("payload_hash").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03bStepExecutions = pgTable("cro03b_step_executions", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03bRecipeItems.id, { onDelete: "restrict" }),
  stepKey: text("step_key").notNull(),
  stepIndex: integer("step_index").notNull(),
  contractHash: text("contract_hash").notNull(),
  executionOwner: text("execution_owner").notNull(),
  accountingOwner: text("accounting_owner").notNull(),
  state: text("state").notNull().default("queued"),
  attemptCount: integer("attempt_count").notNull().default(0),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  operationId: uuid("operation_id").references(() => providerOperations.id, { onDelete: "restrict" }),
  evidenceExpiresAt: timestamp("evidence_expires_at", { withTimezone: true }),
  outcomeCode: text("outcome_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03b_step_identity_uidx").on(table.itemId, table.stepKey)]);

export const cro03bDomainLimits = pgTable("cro03b_domain_limits", {
  registrableDomain: text("registrable_domain").primaryKey(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  windowCount: integer("window_count").notNull().default(0),
  activeCount: integer("active_count").notNull().default(0),
  leaseVersion: bigint("lease_version", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03bEvidenceObservations = pgTable("cro03b_evidence_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03bRecipeItems.id, { onDelete: "restrict" }),
  stepKey: text("step_key").notNull(),
  sourceObservationId: uuid("source_observation_id").references(() => cro03SourceObservations.id, { onDelete: "restrict" }),
  operationId: uuid("operation_id").references(() => providerOperations.id, { onDelete: "restrict" }),
  evidenceHash: text("evidence_hash").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  outcome: text("outcome").notNull(),
  provenance: jsonb("provenance").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03b_evidence_identity_uidx").on(table.itemId, table.stepKey, table.evidenceHash)]);

export const cro03bFieldCandidates = pgTable("cro03b_field_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03bRecipeItems.id, { onDelete: "restrict" }),
  observationId: uuid("observation_id").notNull().references(() => cro03bEvidenceObservations.id, { onDelete: "restrict" }),
  field: text("field").notNull(),
  normalizedValue: text("normalized_value").notNull(),
  displayValue: text("display_value").notNull(),
  valueHash: text("value_hash").notNull(),
  authorityRank: integer("authority_rank").notNull(),
  confidence: integer("confidence").notNull(),
  protectedManual: boolean("protected_manual").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro03b_candidate_identity_uidx").on(table.itemId, table.observationId, table.field, table.valueHash),
]);

export const cro03bFieldDecisions = pgTable("cro03b_field_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03bRecipeItems.id, { onDelete: "restrict" }),
  field: text("field").notNull(),
  policyVersion: integer("policy_version").notNull(),
  policyHash: text("policy_hash").notNull(),
  candidateSetHash: text("candidate_set_hash").notNull(),
  threshold: integer("threshold").notNull(),
  minimumMargin: integer("minimum_margin").notNull(),
  winnerCandidateId: uuid("winner_candidate_id").references(() => cro03bFieldCandidates.id, { onDelete: "restrict" }),
  outcome: text("outcome").notNull(),
  reasonCode: text("reason_code").notNull(),
  topConfidence: integer("top_confidence"),
  runnerUpConfidence: integer("runner_up_confidence"),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03b_field_decision_uidx").on(table.itemId, table.field)]);

export const cro03bTerminalHookRequests = pgTable("cro03b_terminal_hook_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03bRecipeItems.id, { onDelete: "restrict" }).unique(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  subjectGeneration: integer("subject_generation").notNull(),
  requestKey: text("request_key").notNull().unique(),
  state: text("state").notNull().default("pending"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03bStageOperations = pgTable("cro03b_stage_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03bRecipeItems.id, { onDelete: "restrict" }),
  stepKey: text("step_key").notNull(),
  executionOwner: text("execution_owner").notNull(),
  accountingOwner: text("accounting_owner").notNull(),
  operationKey: text("operation_key").notNull().unique(),
  state: text("state").notNull(),
  requestedUnits: integer("requested_units").notNull().default(0),
  settledUnits: integer("settled_units").notNull().default(0),
  outcomeCode: text("outcome_code").notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03b_stage_operation_identity_uidx").on(table.itemId, table.stepKey)]);

export const cro03bStageAttempts = pgTable("cro03b_stage_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => cro03bStageOperations.id, { onDelete: "restrict" }),
  attemptNumber: integer("attempt_number").notNull(),
  outcome: text("outcome").notNull(),
  transportInvoked: boolean("transport_invoked").notNull().default(false),
  errorCode: text("error_code"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("cro03b_stage_attempt_identity_uidx").on(table.operationId, table.attemptNumber)]);

export const cro03bStageReceipts = pgTable("cro03b_stage_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => cro03bStageOperations.id, { onDelete: "restrict" }).unique(),
  receiptKey: text("receipt_key").notNull().unique(),
  outcome: text("outcome").notNull(),
  requestedUnits: integer("requested_units").notNull().default(0),
  settledUnits: integer("settled_units").notNull().default(0),
  evidenceHash: text("evidence_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const validationIntents = pgTable("validation_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  normalizedEmailTokenHash: text("normalized_email_token_hash").notNull(),
  subjectGeneration: integer("subject_generation").notNull(),
  policyVersion: integer("policy_version").notNull().default(1),
  purpose: text("purpose").notNull().default("marketing_outreach"),
  state: text("state").notNull().default("pending"),
  enqueueState: text("enqueue_state").notNull().default("deferred"),
  operationId: uuid("operation_id").references(() => providerOperations.id, { onDelete: "set null" }),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
  terminalCode: text("terminal_code"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  executionAuthorizedAt: timestamp("execution_authorized_at", { withTimezone: true }),
  executionAuthority: text("execution_authority"),
}, (table) => [
  uniqueIndex("validation_intents_current_schema_uidx")
    .on(table.contactId, table.normalizedEmailTokenHash, table.subjectGeneration, table.purpose),
  index("validation_intents_claim_schema_idx").on(table.state, table.nextAttemptAt, table.leaseExpiresAt),
]);

/** Free (no provider spend) DNS/syntax/disposable result per sending domain. */
export const emailDomainChecks = pgTable("email_domain_checks", {
  domain: text("domain").primaryKey(),
  status: text("status").notNull(),
  mxHosts: integer("mx_host_count").notNull().default(0),
  detail: text("detail"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Free prefilter outcome saved per contact address; keyed to the address hash
 * so an email change invalidates it. Never authorizes sending; it only decides
 * whether ZeroBounce credits should be spent and in what order. */
export const contactEmailPrefilter = pgTable("contact_email_prefilter", {
  contactId: integer("contact_id").primaryKey().references(() => contacts.id, { onDelete: "cascade" }),
  emailTokenHash: text("email_token_hash").notNull(),
  domain: text("domain"),
  status: text("status").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("contact_email_prefilter_status_idx").on(table.status),
]);

/** Last Serper lookup outcome per business and purpose. Skipped only while unexpired and
 * the input fingerprint and matcher rule version still match; also carries a short claim
 * so concurrent workers cannot buy the same lookup. Stores no provider payloads. */
export const sfpSerperLookupMemory = pgTable("sfp_serper_lookup_memory", {
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  requestedEvidence: text("requested_evidence").notNull(),
  outcomeClass: text("outcome_class"),
  ruleVersion: integer("rule_version"),
  inputFingerprint: text("input_fingerprint"),
  reasonSummary: text("reason_summary"),
  requestsUsed: integer("requests_used").notNull().default(0),
  observedAt: timestamp("observed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  claimToken: uuid("claim_token"),
  claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.businessId, table.purpose] }),
  index("sfp_serper_lookup_memory_expiry_idx").on(table.expiresAt),
]);

/** Current per-contact business-assignment disposition (observation only, never authority). */
export const contactBusinessLinkDispositions = pgTable("contact_business_link_dispositions", {
  contactId: integer("contact_id").primaryKey().references(() => contacts.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  reasonCode: text("reason_code").notNull(),
  ruleVersion: text("rule_version").notNull(),
  evidenceFingerprint: text("evidence_fingerprint").notNull(),
  evidenceRefs: jsonb("evidence_refs").notNull().default(sql`'{}'::jsonb`),
  nextRetryTrigger: text("next_retry_trigger"),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  businessId: integer("business_id").references(() => businesses.id, { onDelete: "set null" }),
  runId: text("run_id"),
  evaluationCount: integer("evaluation_count").notNull().default(1),
  firstEvaluatedAt: timestamp("first_evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("contact_business_link_dispositions_outcome_idx").on(table.outcome, table.reasonCode),
]);

/** Dated acceptance population for the business-assignment program. */
export const contactLinkAcceptanceBaselines = pgTable("contact_link_acceptance_baselines", {
  id: uuid("id").primaryKey().defaultRandom(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  ruleVersion: text("rule_version").notNull(),
  contactCount: integer("contact_count").notNull(),
  population: jsonb("population").notNull().default(sql`'{}'::jsonb`),
});
export const contactLinkAcceptanceMembers = pgTable("contact_link_acceptance_members", {
  baselineId: uuid("baseline_id").notNull().references(() => contactLinkAcceptanceBaselines.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  recordClass: text("record_class").notNull(),
  linkedAtCapture: boolean("linked_at_capture").notNull(),
}, (table) => [
  primaryKey({ columns: [table.baselineId, table.contactId] }),
  index("contact_link_acceptance_members_contact_idx").on(table.contactId),
]);

// CRO-03C governed live execution authority is deliberately separate from the
// immutable CRO-03B denied-generation records.
export type Cro03cBillingSemantics = "not_billable" | "per_unit_no_result_free" | "per_unit_no_result_billable";
export interface Cro03cPriceScheduleRecord {
  version: number;
  unitType: string;
  currency: string;
  amountMicros: number;
  billingSemantics: Cro03cBillingSemantics;
}
export interface Cro03cApprovalEvidenceRecord {
  approvalId: string;
  version: number;
  approvedBy: string;
  approvedAt: string;
  scopeHash: string;
}
export const cro03cApprovalReceipts = pgTable("cro03c_approval_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  dimension: text("dimension").notNull(),
  issuerId: text("issuer_id").notNull(),
  issuerReceiptId: text("issuer_receipt_id").notNull(),
  scope: jsonb("scope").notNull(),
  scopeHash: text("scope_hash").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  signature: text("signature").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03c_approval_receipt_issuer_uidx").on(table.dimension, table.issuerId, table.issuerReceiptId)]);
export const cro03cApprovalReceiptRevocations = pgTable("cro03c_approval_receipt_revocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  receiptId: uuid("receipt_id").notNull().unique().references(() => cro03cApprovalReceipts.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  reason: text("reason").notNull(),
  revokedBy: text("revoked_by").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
});
export const cro03cDeploymentInventories = pgTable("cro03c_deployment_inventories", {
  id: uuid("id").primaryKey(),
  issuerId: text("issuer_id").notNull(),
  deploymentIdentity: text("deployment_identity").notNull(),
  environmentIdentity: text("environment_identity").notNull(),
  releaseSha: text("release_sha").notNull(),
  queueTopologyHash: text("queue_topology_hash").notNull(),
  identityKind: text("identity_kind").notNull(),
  workerIdentities: jsonb("worker_identities").$type<string[]>().notNull(),
  expectedCount: integer("expected_count").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  payload: jsonb("payload").notNull(),
  payloadHash: text("payload_hash").notNull().unique(),
  signature: text("signature").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const cro03cDeploymentInventoryRevocations = pgTable("cro03c_deployment_inventory_revocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  inventoryId: uuid("inventory_id").notNull().unique().references(() => cro03cDeploymentInventories.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  reason: text("reason").notNull(),
  revokedBy: text("revoked_by").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
});
export const cro03cActivationPolicies = pgTable("cro03c_activation_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  policyKey: text("policy_key").notNull(),
  version: integer("version").notNull(),
  policy: jsonb("policy").notNull(),
  policyHash: text("policy_hash").notNull(),
  // Immutable, versioned authority artifacts. Request schemas must never
  // accept these fields from the browser.
  priceSchedules: jsonb("price_schedules").$type<Record<string, Cro03cPriceScheduleRecord>>().notNull().default({}),
  requiredApprovals: jsonb("required_approvals").$type<Record<string, Cro03cApprovalEvidenceRecord>>().notNull(),
  status: text("status").notNull().default("draft"),
  expectedRevision: integer("expected_revision").notNull().default(0),
  reason: text("reason").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03c_activation_policy_identity_uidx").on(table.policyKey, table.version)]);

export const cro03cRuntimeAttestations = pgTable("cro03c_runtime_attestations", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  inventoryId: uuid("inventory_id").notNull().references(() => cro03cDeploymentInventories.id, { onDelete: "restrict" }),
  workerIdentities: jsonb("worker_identities").$type<string[]>().notNull(),
  artifactSha: text("artifact_sha").notNull(),
  migrationHead: text("migration_head").notNull(),
  deploymentIdentity: text("deployment_identity").notNull(),
  environmentIdentity: text("environment_identity").notNull(),
  webBootIdentity: text("web_boot_identity").notNull(),
  workerBootIdentity: text("worker_boot_identity").notNull(),
  queueTopologyHash: text("queue_topology_hash").notNull(),
  workerHeartbeatAt: timestamp("worker_heartbeat_at", { withTimezone: true }).notNull(),
  dbHealthy: boolean("db_healthy").notNull(),
  redisHealthy: boolean("redis_healthy").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  attestationHash: text("attestation_hash").notNull().unique(),
  createdBy: text("created_by").notNull(),
});

export const cro03cCommands = pgTable("cro03c_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  commandKey: text("command_key").notNull().unique(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  commandType: text("command_type").notNull(),
  actorId: text("actor_id").notNull(),
  activationPolicyId: uuid("activation_policy_id").notNull().references(() => cro03cActivationPolicies.id, { onDelete: "restrict" }),
  activationRevision: integer("activation_revision").notNull(),
  recipeVersion: integer("recipe_version").notNull(),
  recipeHash: text("recipe_hash").notNull(),
  stagePlanHash: text("stage_plan_hash").notNull(),
  cohortHash: text("cohort_hash"),
  runtimeAttestationId: uuid("runtime_attestation_id").notNull().references(() => cro03cRuntimeAttestations.id, { onDelete: "restrict" }),
  caps: jsonb("caps").notNull(),
  stopPolicyHash: text("stop_policy_hash").notNull(),
  approvalEvidence: jsonb("approval_evidence").notNull(),
  preRunSnapshotId: uuid("pre_run_snapshot_id"),
  effectAuthorized: boolean("effect_authorized").notNull().default(false),
  effectCorrelationId: uuid("effect_correlation_id").notNull().defaultRandom(),
  prePauseEpoch: bigint("pre_pause_epoch", { mode: "number" }),
  state: text("state").notNull().default("queued"),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03cRuns = pgTable("cro03c_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  commandId: uuid("command_id").notNull().unique().references(() => cro03cCommands.id, { onDelete: "restrict" }),
  runKey: text("run_key").notNull().unique(),
  mode: text("mode").notNull(),
  state: text("state").notNull().default("queued"),
  claimToken: uuid("claim_token"),
  executionFence: integer("execution_fence").notNull().default(0),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  stopReason: text("stop_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03cGenerations = pgTable("cro03c_generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  handoffId: uuid("handoff_id").notNull().references(() => cro03aHandoffs.id, { onDelete: "restrict" }),
  recipeVersion: integer("recipe_version").notNull(),
  recipeHash: text("recipe_hash").notNull(),
  mode: text("mode").notNull().default("cro03c_live_v1"),
  activationRevision: integer("activation_revision").notNull(),
  commandId: uuid("command_id").notNull().references(() => cro03cCommands.id, { onDelete: "restrict" }),
  pilotRunId: uuid("pilot_run_id"),
  runId: uuid("run_id").notNull().references(() => cro03cRuns.id, { onDelete: "restrict" }),
  frozenHandoffHash: text("frozen_handoff_hash").notNull(),
  stagePlanHash: text("stage_plan_hash").notNull(),
  cohortHash: text("cohort_hash").notNull(),
  runtimeAttestationId: uuid("runtime_attestation_id").notNull().references(() => cro03cRuntimeAttestations.id, { onDelete: "restrict" }),
  state: text("state").notNull().default("queued"),
  claimToken: uuid("claim_token"),
  executionFence: integer("execution_fence").notNull().default(0),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03c_generation_handoff_recipe_uidx").on(table.handoffId, table.recipeVersion)]);

export const cro03cStageDispositions = pgTable("cro03c_stage_dispositions", {
  id: uuid("id").primaryKey().defaultRandom(),
  generationId: uuid("generation_id").notNull().references(() => cro03cGenerations.id, { onDelete: "restrict" }),
  stageKey: text("stage_key").notNull(),
  disposition: text("disposition").notNull(),
  inputHash: text("input_hash").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  recipeHash: text("recipe_hash").notNull(),
  policyHash: text("policy_hash").notNull(),
  reasonCode: text("reason_code").notNull(),
  frozenInput: jsonb("frozen_input").notNull().default({}),
  stageInputReferenceId: uuid("stage_input_reference_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03c_stage_disposition_identity_uidx").on(table.generationId, table.stageKey)]);

export const cro03cStageInputReferences = pgTable("cro03c_stage_input_references", {
  id: uuid("id").primaryKey().defaultRandom(),
  generationId: uuid("generation_id").notNull().references(() => cro03cGenerations.id, { onDelete: "restrict" }),
  stageKey: text("stage_key").notNull(),
  sourceObservationId: uuid("source_observation_id").notNull().references(() => cro03SourceObservations.id, { onDelete: "restrict" }),
  sourcePayloadHash: text("source_payload_hash").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  provider: text("provider").notNull(),
  priceScheduleVersion: integer("price_schedule_version").notNull(),
  priceScheduleHash: text("price_schedule_hash").notNull(),
  reservedUnits: integer("reserved_units").notNull(),
  unitsHash: text("units_hash").notNull(),
  capHash: text("cap_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro03c_stage_input_reference_identity_uidx").on(table.generationId, table.stageKey),
]);

export const cro03cStageOperations = pgTable("cro03c_stage_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  generationId: uuid("generation_id").notNull().references(() => cro03cGenerations.id, { onDelete: "restrict" }),
  stageKey: text("stage_key").notNull(),
  provider: text("provider").notNull(),
  operationType: text("operation_type").notNull(),
  operationKey: text("operation_key").notNull().unique(),
  providerOperationId: uuid("provider_operation_id").references(() => providerOperations.id, { onDelete: "restrict" }),
  commandId: uuid("command_id").references(() => cro03cCommands.id, { onDelete: "restrict" }),
  runId: uuid("run_id").references(() => cro03cRuns.id, { onDelete: "restrict" }),
  claimToken: uuid("claim_token"),
  executionFence: integer("execution_fence"),
  attemptId: uuid("attempt_id"),
  preIoAuthorizedAt: timestamp("pre_io_authorized_at", { withTimezone: true }),
  dispatchState: text("dispatch_state").notNull().default("not_dispatched"),
  reconciliationRequired: boolean("reconciliation_required").notNull().default(false),
  caller: text("caller").notNull(),
  unitType: text("unit_type").notNull(),
  currency: text("currency").notNull().default("USD"),
  priceScheduleVersion: integer("price_schedule_version").notNull(),
  priceScheduleHash: text("price_schedule_hash").notNull(),
  maxReservedUnits: integer("max_reserved_units").notNull().default(0),
  maxReservedAmountMicros: bigint("max_reserved_amount_micros", { mode: "number" }).notNull().default(0),
  settledUnits: integer("settled_units").notNull().default(0),
  settledAmountMicros: bigint("settled_amount_micros", { mode: "number" }).notNull().default(0),
  providerReceiptReference: text("provider_receipt_reference"),
  billingCertainty: text("billing_certainty").notNull().default("none"),
  terminalDisposition: text("terminal_disposition"),
  state: text("state").notNull().default("reserved"),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03c_stage_operation_identity_uidx").on(table.generationId, table.stageKey)]);

export const cro03cDomainRequestLimits = pgTable("cro03c_domain_request_limits", {
  hostnameHash: text("hostname_hash").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
  requestCount: integer("request_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03c_domain_request_limit_uidx").on(table.hostnameHash, table.windowStartedAt)]);

export const cro03cDispatchCheckpoints = pgTable("cro03c_dispatch_checkpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  stageOperationId: uuid("stage_operation_id").notNull().references(() => cro03cStageOperations.id, { onDelete: "restrict" }),
  attemptId: uuid("attempt_id").notNull(),
  checkpoint: text("checkpoint").notNull(),
  authorityHash: text("authority_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03c_dispatch_checkpoint_uidx").on(table.stageOperationId, table.attemptId, table.checkpoint)]);

export const cro03cReceipts = pgTable("cro03c_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  generationId: uuid("generation_id").notNull().references(() => cro03cGenerations.id, { onDelete: "restrict" }),
  pilotRunId: uuid("pilot_run_id"),
  stageOperationId: uuid("stage_operation_id").references(() => cro03cStageOperations.id, { onDelete: "restrict" }),
  receiptKey: text("receipt_key").notNull().unique(),
  receiptType: text("receipt_type").notNull(),
  normalizedOutcome: text("normalized_outcome").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  providerReceiptReference: text("provider_receipt_reference"),
  redactedMetadata: jsonb("redacted_metadata").notNull().default({}),
  settledUnits: integer("settled_units").notNull().default(0),
  settledAmountMicros: bigint("settled_amount_micros", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03cRequestHopReceipts = pgTable("cro03c_request_hop_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  stageOperationId: uuid("stage_operation_id").notNull().references(() => cro03cStageOperations.id, { onDelete: "restrict" }),
  hopNumber: integer("hop_number").notNull(),
  requestHash: text("request_hash").notNull(),
  hostname: text("hostname").notNull(),
  pinnedAddressHash: text("pinned_address_hash").notNull(),
  responseStatus: integer("response_status"),
  redirectTargetHash: text("redirect_target_hash"),
  bytes: integer("bytes").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03c_hop_receipt_identity_uidx").on(table.stageOperationId, table.hopNumber)]);

export const cro03cNoOutboundSnapshots = pgTable("cro03c_no_outbound_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  commandId: uuid("command_id").notNull().references(() => cro03cCommands.id, { onDelete: "restrict" }),
  runId: uuid("run_id").references(() => cro03cRuns.id, { onDelete: "restrict" }),
  phase: text("phase").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  counters: jsonb("counters").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03c_snapshot_identity_uidx").on(table.commandId, table.phase)]);

export const cro03cForbiddenEffects = pgTable("cro03c_forbidden_effects", {
  id: uuid("id").primaryKey().defaultRandom(),
  commandId: uuid("command_id").notNull().references(() => cro03cCommands.id, { onDelete: "restrict" }),
  runId: uuid("run_id").references(() => cro03cRuns.id, { onDelete: "restrict" }),
  effectKind: text("effect_kind").notNull(),
  correlationId: text("correlation_id"),
  attemptedCount: integer("attempted_count").notNull().default(0),
  effectiveCount: integer("effective_count").notNull().default(0),
  disposition: text("disposition").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// CRO-08A: Continuous Candidate Factory & Enrichment Operations.
// Scope is deliberately narrow: versioned schedule authority + durable
// occurrence/checkpoint contract for discovery/enrichment/freshness/backfill
// only, a real daily/monthly provider budget rollover ledger, and a minimal
// CRO-03D production-certification receipt gating schedule activation.
// Provider I/O itself is created via a new continuous_occurrence CRO-03C
// command type (see cro03cCommands.commandType) and goes through the
// existing, unchanged CRO-03C authority/reservation/settlement pathway.
// ---------------------------------------------------------------------------
export const cro08aCertificationReceipts = pgTable("cro08a_certification_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  releaseSha: text("release_sha").notNull(),
  migrationHead: text("migration_head").notNull(),
  providerSet: jsonb("provider_set").$type<string[]>().notNull(),
  priceScheduleHash: text("price_schedule_hash").notNull(),
  approvalReceiptIds: jsonb("approval_receipt_ids").$type<string[]>().notNull(),
  runtimeAttestationId: uuid("runtime_attestation_id").notNull().references(() => cro03cRuntimeAttestations.id, { onDelete: "restrict" }),
  outboundPauseEpoch: bigint("outbound_pause_epoch", { mode: "number" }).notNull(),
  issuedBy: text("issued_by").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedReason: text("revoked_reason"),
});

export const cro08aScheduleDefinitions = pgTable("cro08a_schedule_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  logicalKey: text("logical_key").notNull(),
  definitionVersion: integer("definition_version").notNull(),
  purpose: text("purpose").notNull(),
  sourceRecipePolicyVersions: jsonb("source_recipe_policy_versions").notNull().default({}),
  cadenceCron: text("cadence_cron").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  windowSeconds: integer("window_seconds").notNull(),
  overlapSeconds: integer("overlap_seconds").notNull().default(0),
  batchSize: integer("batch_size").notNull(),
  concurrencyLimit: integer("concurrency_limit").notNull(),
  cursorSemantics: jsonb("cursor_semantics").notNull().default({}),
  budgets: jsonb("budgets").notNull().default({}),
  timeoutMs: integer("timeout_ms").notNull(),
  leaseMs: integer("lease_ms").notNull(),
  heartbeatMs: integer("heartbeat_ms").notNull(),
  retryPolicy: jsonb("retry_policy").notNull().default({}),
  deadLetterPolicy: jsonb("dead_letter_policy").notNull().default({}),
  downstreamOwner: text("downstream_owner").notNull(),
  cancellationBehavior: text("cancellation_behavior").notNull().default("preserve_completed_evidence"),
  definitionHash: text("definition_hash").notNull().unique(),
  active: boolean("active").notNull().default(false),
  activeVersion: integer("active_version").notNull().default(0),
  activationEpoch: bigint("activation_epoch", { mode: "number" }),
  activatedBy: text("activated_by"),
  activationReason: text("activation_reason"),
  activationExpiresAt: timestamp("activation_expires_at", { withTimezone: true }),
  certificationReceiptId: uuid("certification_receipt_id").references(() => cro08aCertificationReceipts.id, { onDelete: "restrict" }),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro08a_schedule_definition_version_uidx").on(table.logicalKey, table.definitionVersion),
]);

export const cro08aScheduleOccurrences = pgTable("cro08a_schedule_occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  scheduleDefinitionId: uuid("schedule_definition_id").notNull().references(() => cro08aScheduleDefinitions.id, { onDelete: "restrict" }),
  definitionHash: text("definition_hash").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
  frozenCursorSnapshot: jsonb("frozen_cursor_snapshot").notNull(),
  frozenPopulationHash: text("frozen_population_hash").notNull(),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  state: text("state").notNull().default("open"),
  enumerationCheckpoint: text("enumeration_checkpoint").notNull().default("pending"),
  enumerationCommittedAt: timestamp("enumeration_committed_at", { withTimezone: true }),
  selectionReceiptHash: text("selection_receipt_hash"),
  selectedCount: integer("selected_count").notNull().default(0),
  reconciliationCheckpoint: text("reconciliation_checkpoint").notNull().default("pending"),
  reconciliationCompletedAt: timestamp("reconciliation_completed_at", { withTimezone: true }),
  terminalCount: integer("terminal_count").notNull().default(0),
  cro03cCommandId: uuid("cro03c_command_id").references(() => cro03cCommands.id, { onDelete: "restrict" }),
  cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro08a_occurrence_window_uidx").on(table.scheduleDefinitionId, table.windowStart, table.windowEnd),
  uniqueIndex("cro08a_occurrence_command_uidx").on(table.cro03cCommandId),
  index("cro08a_occurrence_claim_idx").on(table.state, table.leaseExpiresAt),
]);

export const cro08aOccurrenceSelectedHandoffs = pgTable("cro08a_occurrence_selected_handoffs", {
  occurrenceId: uuid("occurrence_id").notNull().references(() => cro08aScheduleOccurrences.id, { onDelete: "restrict" }),
  handoffId: uuid("handoff_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.occurrenceId, table.handoffId] }),
  index("cro08a_occurrence_selected_handoffs_occurrence_idx").on(table.occurrenceId),
]);

export const providerBudgetPeriodLedger = pgTable("provider_budget_period_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().references(() => providerControls.provider, { onDelete: "restrict" }),
  periodKey: text("period_key").notNull(),
  periodStartedAt: timestamp("period_started_at", { withTimezone: true }).notNull(),
  periodEndedAt: timestamp("period_ended_at", { withTimezone: true }).notNull(),
  consumedUnits: integer("consumed_units").notNull(),
  localBudgetUnits: integer("local_budget_units"),
  closedReservationVersion: integer("closed_reservation_version").notNull(),
  closedBy: text("closed_by").notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("provider_budget_period_uidx").on(table.provider, table.periodKey, table.periodStartedAt),
]);

export const cro03cValidationAuthorizations = pgTable("cro03c_validation_authorizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  validationIntentId: uuid("validation_intent_id").notNull().unique().references(() => validationIntents.id, { onDelete: "restrict" }),
  commandId: uuid("command_id").notNull().references(() => cro03cCommands.id, { onDelete: "restrict" }),
  runId: uuid("run_id").notNull().references(() => cro03cRuns.id, { onDelete: "restrict" }),
  generationId: uuid("generation_id").notNull().references(() => cro03cGenerations.id, { onDelete: "restrict" }),
  activationRevision: integer("activation_revision").notNull(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  normalizedEmailHash: text("normalized_email_hash").notNull(),
  subjectGeneration: integer("subject_generation").notNull(),
  runtimeAttestationId: uuid("runtime_attestation_id").notNull().references(() => cro03cRuntimeAttestations.id, { onDelete: "restrict" }),
  expectedProviderControlRevision: integer("expected_provider_control_revision").notNull(),
  unitCap: integer("unit_cap").notNull(),
  costCapMicros: bigint("cost_cap_micros", { mode: "number" }).notNull().default(0),
  authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revocationReason: text("revocation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03cValidationRevocations = pgTable("cro03c_validation_revocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  authorizationId: uuid("authorization_id").notNull().unique().references(() => cro03cValidationAuthorizations.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03cInitialRollouts = pgTable("cro03c_initial_rollouts", {
  rolloutKey: text("rollout_key").primaryKey(),
  commandId: uuid("command_id").unique().references(() => cro03cCommands.id, { onDelete: "restrict" }),
  activationRevision: integer("activation_revision"),
  membershipHash: text("membership_hash"),
  state: text("state").notNull().default("reserved"),
  consumedAt: timestamp("consumed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03cInitialMemberships = pgTable("cro03c_initial_memberships", {
  rolloutKey: text("rollout_key").notNull().references(() => cro03cInitialRollouts.rolloutKey, { onDelete: "restrict" }),
  generationId: uuid("generation_id").notNull().unique().references(() => cro03cGenerations.id, { onDelete: "restrict" }),
  ordinal: integer("ordinal").notNull(),
  handoffHash: text("handoff_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("cro03c_initial_membership_identity_uidx").on(table.rolloutKey, table.ordinal)]);

export const eligibilitySnapshots = pgTable("eligibility_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Retained readiness/commercial evidence must not silently disappear when a
  // contact is removed. A reviewed retention/tombstone workflow owns deletion.
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  purpose: text("purpose").notNull(),
  policyVersion: integer("policy_version").notNull(),
  subjectGeneration: integer("subject_generation").notNull(),
  decision: text("decision").notNull(),
  reasonCodes: jsonb("reason_codes").notNull().default([]),
  evidenceRefs: jsonb("evidence_refs").notNull().default([]),
  // CRO-02 commercial resolution is an immutable lower layer; BT-10 retains
  // ownership of this snapshot's readiness decision.
  commercialResolutionSnapshotId: uuid("commercial_resolution_snapshot_id").references(() => commercialResolutionSnapshots.id, { onDelete: "restrict" }),
  evaluatedAt: timestamp("evaluated_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("eligibility_snapshots_contact_schema_idx").on(table.contactId, table.purpose, table.evaluatedAt),
]);


// ---------------------------------------------------------------------------
// Contact Lifecycle History — one row per lifecycle_state transition
// ---------------------------------------------------------------------------
export const contactLifecycleHistory = pgTable("contact_lifecycle_history", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  fromState: text("from_state"),
  toState: text("to_state").notNull(),
  transitionedAt: timestamp("transitioned_at").notNull().defaultNow(),
  trigger: text("trigger"),
  actorType: text("actor_type"),
  actorId: text("actor_id"),
  source: text("source"),
  reason: text("reason"),
  automationKey: text("automation_key"),
  metadata: jsonb("metadata"),
}, (table) => [
  index("contact_lifecycle_history_contact_idx").on(table.contactId, table.transitionedAt),
]);

export type ContactLifecycleHistoryRow = typeof contactLifecycleHistory.$inferSelect;
export type InsertContactLifecycleHistory = typeof contactLifecycleHistory.$inferInsert;

export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  createdByUserId:varchar("created_by_user_id").references(()=>users.id),
  legalName: text("legal_name").notNull(),
  dba: text("dba"),
  vertical: text("vertical"),
  address: text("address"),
  website: text("website"),
  volumeRange: text("volume_range"),
  currentProvider: text("current_provider"),
  notes: text("notes"),
  managementType: text("management_type").notNull().default("unknown"),
  // BT-06: mutable projection maintained only by CommercialClassificationAuthority.
  recordClass: text("record_class").notNull().default("unknown"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCompanySchema = createInsertSchema(companies).omit({
  id: true,
  createdByUserId:true,
  recordClass: true,
  createdAt: true,
});

export const deals = pgTable("deals", {
  id: serial("id").primaryKey(),
  // Public fulfillment deals are owned by one inbound occurrence. Sales and
  // legacy deals leave this null; the unique fence makes fulfillment replay
  // safe without creating a competing deal authority.
  inboundRequestId: uuid("inbound_request_id").references((): AnyPgColumn => inboundRequests.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").references(() => contacts.id),
  companyId: integer("company_id").references(() => companies.id),
  pipeline: text("pipeline").notNull().default("sales"),
  stage: text("stage").notNull().default("New Lead"),
  name: text("name"),
  owner: text("owner"),
  priorityScore: integer("priority_score").default(0),
  offerPath: text("offer_path"),
  nextFollowUp: timestamp("next_follow_up"),
  effectiveRate: text("effective_rate"),
  totalVolume: text("total_volume"),
  totalFees: text("total_fees"),
  avgTicket: text("avg_ticket"),
  highestTicket: text("highest_ticket"),
  estimatedGrossProfitBps: integer("estimated_gross_profit_bps"),
  estimatedGrossProfitMonthly: text("estimated_gross_profit_monthly"),
  estimatedNetProfitMonthly: text("estimated_net_profit_monthly"),
  merchantTier: text("merchant_tier"),
  riskTier: text("risk_tier"),
  healthScore: text("health_score"),
  churnRiskFlag: text("churn_risk_flag"),
  topCostDrivers: text("top_cost_drivers").array(),
  recommendedPath: text("recommended_path"),
  terminalRecommendation: text("terminal_recommendation"),
  terminalStatus: text("terminal_status"),
  terminalApprovalStatus: text("terminal_approval_status").default("not_required"),
  terminalApprovalTaskId: integer("terminal_approval_task_id"),
  terminalCostAtOrder: real("terminal_cost_at_order"),
  fundingNotes: text("funding_notes"),
  expectedGoLiveDate: timestamp("expected_go_live_date"),
  goLiveDate: timestamp("go_live_date"),
  lastStatementReviewDate: timestamp("last_statement_review_date"),
  nextStatementReviewDate: timestamp("next_statement_review_date"),
  onboardingStatusNotes: text("onboarding_status_notes"),
  leadSource: text("lead_source"),
  promoCode: text("promo_code"),
  referredBy: text("referred_by"),
  partnerType: text("partner_type"),
  campaignName: text("campaign_name"),
  notes: text("notes"),
  dealBlueprint: jsonb("deal_blueprint"),
  savingsProposal: jsonb("savings_proposal"),
  proposalGeneratedAt: timestamp("proposal_generated_at"),
  recommendedProgram: text("recommended_program"),
  hardwarePackage: text("hardware_package"),
  estMonthlyRevenue: text("est_monthly_revenue"),
  underwritingPath: text("underwriting_path"),
  competitivePositioning: text("competitive_positioning"),
  repBriefing: text("rep_briefing"),
  repOpener: text("rep_opener"),
  likelyObjections: text("likely_objections").array(),
  proposalToken: text("proposal_token"),
  proposalEmailSentAt: timestamp("proposal_email_sent_at"),
  proposalStatus: text("proposal_status").default("none"),
  analysisStatus: text("analysis_status").default("none"),
  statementReceived: boolean("statement_received").default(false),
  voidedCheckReceived: boolean("voided_check_received").default(false),
  idReceived: boolean("id_received").default(false),
  appCompleted: boolean("app_completed").default(false),
  docReadinessScore: integer("doc_readiness_score").default(0),
  lastNudgeAt: timestamp("last_nudge_at"),
  nextNudgeAt: timestamp("next_nudge_at"),
  blueprintGeneratedAt: timestamp("blueprint_generated_at"),
  closedAt: timestamp("closed_at"),
  processorApplicationId: text("processor_application_id"),
  mid: text("mid"),
  boardingStatus: text("boarding_status").default("not_submitted"),
  boardingLog: jsonb("boarding_log"),
  boardingSubmittedAt: timestamp("boarding_submitted_at"),
  boardingApprovedAt: timestamp("boarding_approved_at"),
  // Idempotency for durable processor submission (item 8).
  boardingIdempotencyKey: text("boarding_idempotency_key"),
  // REV-05A boarding authority fields (migration 0220)
  processorProgram: text("processor_program"),          // 'traditional' | 'payfac'
  boardingAmbiguousAt: timestamp("boarding_ambiguous_at"), // set when result is ambiguous
  boardingReconciledAt: timestamp("boarding_reconciled_at"), // set when reconciled
  shareToken: varchar("share_token", { length: 64 }).unique(),
  shareData: jsonb("share_data"),
  shareViewCount: integer("share_view_count").default(0),
  shareLastViewedAt: timestamp("share_last_viewed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  archivedAt: timestamp("archived_at"),
  partnerOrgId: integer("partner_org_id"),
  vertical: text("vertical"),
  autoEnrollmentSuppressedAt: timestamp("auto_enrollment_suppressed_at"),
  autoEnrollmentSuppressedReason: text("auto_enrollment_suppressed_reason"),
  // ── VAS upsell suppression (Day-30 cross-sell) ────────────────────────────
  // Set by a rep from the portfolio page to prevent automatic VAS sequence
  // enrollment at the Day-30 milestone. Does NOT affect initial auto-enrollment.
  vasUpsellSuppressedAt: timestamp("vas_upsell_suppressed_at"),
  vasUpsellSuppressedReason: text("vas_upsell_suppressed_reason"),
  // ── Onboarding linkage ───────────────────────────────────────────────────
  // Set on onboarding pipeline deals to point back to the sales deal that
  // triggered the Closed Won → Onboarding auto-kickoff.
  salesDealId: integer("sales_deal_id").references((): AnyPgColumn => deals.id),
  // ── Google Ads attribution ────────────────────────────────────────────────
  attributionGclid: text("attribution_gclid"),
  attributionSource: text("attribution_source"),
  attributionMedium: text("attribution_medium"),
  attributionCampaign: text("attribution_campaign"),
  bookingAttributedAt: timestamp("booking_attributed_at"),
  conversionAttributedAt: timestamp("conversion_attributed_at"),
  ghlOpportunityId: text("ghl_opportunity_id"),
  // ── Post-enrichment automation ────────────────────────────────────────────
  // Set by the post-enrichment BullMQ worker when it first processes a lead
  // that received contact info from enrichment. Acts as an idempotency guard
  // so re-enrichments never double-enroll the contact.
  postEnrichmentAutomationAt: timestamp("post_enrichment_automation_at"),
  // Human-readable next action chip shown on the Kanban deal card.
  // Set by the post-enrichment worker (e.g. "Enrolled — restaurant lead, sequence started").
  nextAction: text("next_action"),
  // BT-06: mutable projection maintained only by CommercialClassificationAuthority.
  recordClass: text("record_class").notNull().default("unknown"),
}, (table) => [
  uniqueIndex("deals_inbound_request_uidx").on(table.inboundRequestId).where(sql`inbound_request_id IS NOT NULL`),
  index("deals_contact_id_idx").on(table.contactId),
  index("deals_pipeline_idx").on(table.pipeline),
  index("deals_stage_idx").on(table.stage),
  index("deals_pipeline_stage_idx").on(table.pipeline, table.stage),
  index("deals_created_at_idx").on(table.createdAt),
  index("deals_sales_deal_id_idx").on(table.salesDealId),
]);

export const insertDealSchema = createInsertSchema(deals).omit({
  id: true,
  recordClass: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
});

export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id),
  subject: text("subject").notNull(),
  description: text("description").notNull(),
  status: text("status").default("New Ticket"),
  priority: text("priority").default("Normal"),
  category: text("category").default("Other"),
  assignedTo: text("assigned_to"),
  slaDeadline: timestamp("sla_deadline"),
  firstResponseAt: timestamp("first_response_at"),
  resolvedAt: timestamp("resolved_at"),
  // Authority fields are additive.  The display status remains a legacy
  // projection while authorityState is the only state used by new commands.
  producer: text("producer"),
  issueKey: text("issue_key"),
  subjectType: text("subject_type"),
  subjectId: integer("subject_id"),
  generation: integer("generation").notNull().default(0),
  canonicalAssignee: text("canonical_assignee"),
  commandKey: text("command_key"),
  authorityFence: integer("authority_fence").notNull().default(0),
  terminalReason: text("terminal_reason"),
  authorityState: text("authority_state").notNull().default("open"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("tickets_command_key_uidx").on(table.commandKey).where(sql`command_key IS NOT NULL`),
  index("tickets_subject_identity_idx").on(table.subjectType, table.subjectId, table.generation),
  uniqueIndex("tickets_active_authority_subject_uidx").on(table.producer, table.issueKey, table.subjectType, table.subjectId)
    .where(sql`producer IS NOT NULL AND authority_state IN ('open', 'in_progress')`),
  check("tickets_authority_state_check", sql`authority_state IN ('open', 'in_progress', 'completed', 'cancelled')`),
]);

export const insertTicketSchema = createInsertSchema(tickets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  producer: true,
  issueKey: true,
  subjectType: true,
  subjectId: true,
  generation: true,
  canonicalAssignee: true,
  commandKey: true,
  authorityFence: true,
  terminalReason: true,
  authorityState: true,
});

export const ticketAuthorityEvents = pgTable("ticket_authority_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(),
  eventType: text("event_type").notNull(),
  producer: text("producer").notNull(),
  commandKey: text("command_key"),
  fence: integer("fence").notNull(),
  fromState: text("from_state"),
  toState: text("to_state"),
  terminalReason: text("terminal_reason"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("ticket_authority_events_ticket_key_uidx").on(table.ticketId, table.eventKey),
  index("ticket_authority_events_ticket_created_idx").on(table.ticketId, table.createdAt),
  index("ticket_authority_events_command_idx").on(table.commandKey).where(sql`command_key IS NOT NULL`),
]);

export const DOCUMENT_CATEGORIES = [
  "Application",
  "Voided Check",
  "Photo ID",
  "Bank Statement",
  "EIN Letter",
  "Signed Proposal",
  "Processing Statement",
  "Rate Review Statement",
  "KYC",
  "Other",
] as const;

export const DOCUMENT_STATUSES = ["pending", "approved", "rejected", "archived"] as const;
export type DocumentStatus = typeof DOCUMENT_STATUSES[number];

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  type: text("type").notNull(),
  category: text("category").default("Other"),
  fileName: text("file_name").notNull(),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  uploadedBy: text("uploaded_by"),
  storageKey: text("storage_key"),
  accessScope: text("access_scope").default("internal"),
  status: text("status").default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("documents_contact_id_idx").on(table.contactId),
  index("documents_created_at_idx").on(table.createdAt),
]);

export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
  createdAt: true,
});

export const documentAccessLog = pgTable("document_access_log", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").references(() => documents.id).notNull(),
  userId: text("user_id").notNull(),
  ip: text("ip"),
  accessedAt: timestamp("accessed_at").defaultNow(),
}, (table) => [
  index("document_access_log_document_id_idx").on(table.documentId),
  index("document_access_log_accessed_at_idx").on(table.accessedAt),
]);

export const insertDocumentAccessLogSchema = createInsertSchema(documentAccessLog).omit({
  id: true,
  accessedAt: true,
});

export type DocumentAccessLog = typeof documentAccessLog.$inferSelect;
export type InsertDocumentAccessLog = z.infer<typeof insertDocumentAccessLogSchema>;

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id),
  contactId: integer("contact_id").references(() => contacts.id),
  ticketId: integer("ticket_id").references(() => tickets.id),
  title: text("title").notNull(),
  description: text("description"),
  assignedTo: text("assigned_to"),
  dueDate: timestamp("due_date"),
  status: text("status").default("pending"),
  priority: text("priority").default("normal"),
  completedAt: timestamp("completed_at"),
  ghlTaskId: text("ghl_task_id"),
  deletedAt: timestamp("deleted_at"),
  createdAt: timestamp("created_at").defaultNow(),
  source: text("source"),
  automationKey: text("automation_key"),
  // Task 1721 authority projection. `status` deliberately remains intact for
  // legacy readers; authorityState has the constrained canonical vocabulary.
  producer: text("producer"),
  issueKey: text("issue_key"),
  subjectType: text("subject_type"),
  subjectId: integer("subject_id"),
  generation: integer("generation").notNull().default(0),
  canonicalAssignee: text("canonical_assignee"),
  commandKey: text("command_key"),
  authorityFence: integer("authority_fence").notNull().default(0),
  terminalReason: text("terminal_reason"),
  authorityState: text("authority_state").notNull().default("open"),
}, (table) => [
  uniqueIndex("tasks_command_key_uidx").on(table.commandKey).where(sql`command_key IS NOT NULL`),
  uniqueIndex("tasks_active_authority_issue_uidx")
    .on(table.producer, table.issueKey, table.subjectType, table.subjectId)
    .where(sql`producer IS NOT NULL AND issue_key IS NOT NULL AND authority_state IN ('open', 'in_progress')`),
  index("tasks_subject_identity_idx").on(table.subjectType, table.subjectId, table.generation),
  index("tasks_native_contact_identity_idx").on(table.contactId,table.ghlTaskId).where(sql`ghl_task_id IS NOT NULL`),
  check("tasks_authority_state_check", sql`authority_state IN ('open', 'in_progress', 'completed', 'cancelled')`),
]);

// Append-only command/transition record. This intentionally has no updatedAt:
// retries use eventKey and cannot mutate an already recorded authority fact.
export const taskAuthorityEvents = pgTable("task_authority_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: integer("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  eventKey: text("event_key").notNull(),
  eventType: text("event_type").notNull(),
  producer: text("producer").notNull(),
  commandKey: text("command_key"),
  fence: integer("fence").notNull(),
  fromState: text("from_state"),
  toState: text("to_state"),
  terminalReason: text("terminal_reason"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("task_authority_events_task_key_uidx").on(table.taskId, table.eventKey),
  index("task_authority_events_task_created_idx").on(table.taskId, table.createdAt),
  index("task_authority_events_command_idx").on(table.commandKey).where(sql`command_key IS NOT NULL`),
]);

export const insertTaskSchema = createInsertSchema(tasks).omit({
  id: true,
  createdAt: true,
  source: true,
  automationKey: true,
  producer: true,
  issueKey: true,
  subjectType: true,
  subjectId: true,
  generation: true,
  canonicalAssignee: true,
  commandKey: true,
  authorityFence: true,
  terminalReason: true,
  authorityState: true,
});

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: text("user_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  entityKey: text("entity_key"),
  details: jsonb("details"),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  actorType: text("actor_type").default("user"),
  actorId: text("actor_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("audit_logs_created_at_idx").on(table.createdAt),
  index("audit_logs_entity_type_entity_id_idx").on(table.entityType, table.entityId),
  index("audit_logs_entity_key_idx").on(table.entityKey),
  index("audit_logs_actor_type_idx").on(table.actorType),
  index("audit_logs_user_id_idx").on(table.userId),
]);

export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({
  id: true,
  createdAt: true,
});

export const workflows = pgTable("workflows", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  triggerType: text("trigger_type").notNull(),
  triggerConfig: jsonb("trigger_config"),
  triggerConditions: jsonb("trigger_conditions"),
  actions: jsonb("actions"),
  enabled: boolean("enabled").default(true),
  version: integer("version").notNull().default(1),
  retiredAt: timestamp("retired_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, t => [check("workflows_version_positive", sql`${t.version}>0`)]);

export const repMessageDrafts = pgTable("rep_message_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: varchar("actor_id").notNull().references(() => users.id),
  contextType: text("context_type").notNull(),
  contextId: text("context_id").notNull(),
  channel: text("channel").notNull(),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  version: integer("version").notNull().default(1),
  savedAt: timestamp("saved_at").notNull().defaultNow(),
}, t => [
  unique("rep_message_drafts_context_key").on(t.actorId, t.contextType, t.contextId, t.channel),
  check("rep_message_drafts_context_type_check", sql`${t.contextType} IN ('global','contact','prospect','inbox')`),
  check("rep_message_drafts_channel_check", sql`${t.channel} IN ('email','sms','ghl_chat','voicemail','site')`),
  check("rep_message_drafts_version_check", sql`${t.version}>0`),
]);

export const repMessageDraftCommands = pgTable("rep_message_draft_commands", {
  actorId: varchar("actor_id").notNull().references(() => users.id),
  commandId: uuid("command_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.actorId, t.commandId] })]);

export const workflowRuns = pgTable("workflow_runs", {
  id: serial("id").primaryKey(),
  workflowId: integer("workflow_id").references(() => workflows.id),
  entityType: text("entity_type"),
  entityId: integer("entity_id"),
  status: text("status").default("running"),
  currentStep: integer("current_step").default(0),
  nextRunAt: timestamp("next_run_at"),
  completedAt: timestamp("completed_at"),
  log: jsonb("log"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  inboundRequestId: uuid("inbound_request_id").references((): AnyPgColumn => inboundRequests.id, { onDelete: "restrict" }),
  commandKey: text("command_key"),
  channel: text("channel").notNull(),
  recipientId: text("recipient_id"),
  title: text("title").notNull(),
  message: text("message").notNull(),
  type: text("type").default("info"),
  read: boolean("read").default(false),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  uniqueIndex("notifications_command_key_uidx").on(table.commandKey).where(sql`command_key IS NOT NULL`),
  index("notifications_inbound_request_idx").on(table.inboundRequestId),
]);

export const notificationActorStates=pgTable("notification_actor_states",{
  actorId:varchar("actor_id").notNull().references(()=>users.id),
  notificationId:integer("notification_id").notNull().references(()=>notifications.id),
  readAt:timestamp("read_at"),dismissedAt:timestamp("dismissed_at"),
},table=>[primaryKey({columns:[table.actorId,table.notificationId]})]);

export const contactLifecycleReceipts=pgTable("contact_lifecycle_receipts",{
  actorId:varchar("actor_id").notNull().references(()=>users.id),
  commandId:uuid("command_id").notNull(),payloadHash:text("payload_hash").notNull(),
  result:jsonb("result").notNull(),createdAt:timestamp("created_at").notNull().defaultNow(),
},table=>[primaryKey({columns:[table.actorId,table.commandId]})]);

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
});

export type Contact = typeof contacts.$inferSelect;
export type InsertContact = z.infer<typeof insertContactSchema>;
export type CreateContactRequest = InsertContact;
export type UpdateContactRequest = Partial<InsertContact>;

export type Company = typeof companies.$inferSelect;
export type InsertCompany = z.infer<typeof insertCompanySchema>;

export const maEvents = pgTable("ma_events", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  eventType: text("event_type").notNull(),
  counterpartyName: text("counterparty_name"),
  counterpartyContactId: integer("counterparty_contact_id").references(() => contacts.id),
  eventDate: timestamp("event_date"),
  note: text("note"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("ma_events_entity_idx").on(table.entityType, table.entityId),
]);

export const insertMaEventSchema = createInsertSchema(maEvents).omit({
  id: true,
  createdAt: true,
});

export type MaEvent = typeof maEvents.$inferSelect;
export type InsertMaEvent = z.infer<typeof insertMaEventSchema>;

export type Deal = typeof deals.$inferSelect;
export type InsertDeal = z.infer<typeof insertDealSchema>;
/**
 * Stage is deliberately excluded from generic edits.  Every post-creation
 * stage mutation must pass through DealStageService so it is serialized,
 * audited, and has durable follow-on effect intents.
 */
export type UpdateDealRequest = Partial<Omit<InsertDeal, "stage">>;

// ─── Deal Stage Effect Intents ──────────────────────────────────────────────
// A narrow, stage-owned recovery ledger.  It is intentionally not a replacement
// for the merchant-application or boarding outboxes; it captures only material
// work caused by a successful deal-stage transition.
export const dealStageEffectIntents = pgTable("deal_stage_effect_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: integer("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  transitionKey: text("transition_key").notNull(),
  effectType: text("effect_type").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  lastError: text("last_error"),
  result: jsonb("result"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("deal_stage_effect_intents_unique").on(t.dealId, t.transitionKey, t.effectType),
  uniqueIndex("deal_stage_effect_intents_idempotency_unique").on(t.idempotencyKey),
  index("deal_stage_effect_intents_dispatch_idx").on(t.state, t.leaseExpiresAt, t.createdAt),
]);
export type DealStageEffectIntent = typeof dealStageEffectIntents.$inferSelect;
export const dealStageEffectReceipts = pgTable("deal_stage_effect_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  effectIntentId: uuid("effect_intent_id").notNull().references(() => dealStageEffectIntents.id, { onDelete: "cascade" }),
  targetKey: text("target_key").notNull(),
  state: text("state").notNull().default("pending"),
  providerIdempotencyKey: text("provider_idempotency_key").notNull(),
  providerReference: text("provider_reference"),
  result: jsonb("result"),
  error: text("error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("deal_stage_effect_receipts_unique").on(t.effectIntentId, t.targetKey)]);

export type Ticket = typeof tickets.$inferSelect;
export type InsertTicket = z.infer<typeof insertTicketSchema>;
export type CreateTicketRequest = InsertTicket;
export type UpdateTicketRequest = Partial<InsertTicket>;

export type Document = typeof documents.$inferSelect;
export type InsertDocument = z.infer<typeof insertDocumentSchema>;

export type Task = typeof tasks.$inferSelect;
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type PublicTaskCreateInput = InsertTask;
export type PublicTaskUpdateInput = Partial<PublicTaskCreateInput>;
export type UpdateTaskRequest = PublicTaskUpdateInput;

export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;

export type Notification = typeof notifications.$inferSelect;
export type InsertNotification = z.infer<typeof insertNotificationSchema>;

export const rfis = pgTable("rfis", {
  id: serial("id").primaryKey(),
  authorityFence: integer("authority_fence").notNull().default(0),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  subject: text("subject").notNull(),
  description: text("description"),
  category: text("category").default("General"),
  priority: text("priority").default("Normal"),
  status: text("status").default("Open"),
  assignedTo: text("assigned_to"),
  requestedBy: text("requested_by"),
  dueDate: timestamp("due_date"),
  response: text("response"),
  respondedAt: timestamp("responded_at"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const rfiCommandReceipts=pgTable("rfi_command_receipts",{
  actorId:varchar("actor_id").notNull().references(()=>users.id),
  commandId:uuid("command_id").notNull(),
  rfiId:integer("rfi_id").notNull().references(()=>rfis.id),
  operation:text("operation").notNull().$type<"create"|"edit">(),
  payloadHash:text("payload_hash").notNull(),result:jsonb("result").notNull(),
  createdAt:timestamp("created_at",{withTimezone:true}).notNull().defaultNow(),
},table=>[primaryKey({columns:[table.actorId,table.commandId]})]);

export const insertRfiSchema = createInsertSchema(rfis).omit({
  id: true,
  authorityFence:true,
  createdAt: true,
  updatedAt: true,
});

export type Rfi = typeof rfis.$inferSelect;
export type InsertRfi = z.infer<typeof insertRfiSchema>;
export type UpdateRfiRequest = Partial<InsertRfi>;

export const RFI_CATEGORIES = [
  "General",
  "Pricing",
  "Compliance",
  "Technical",
  "Onboarding",
  "Underwriting",
  "Equipment",
] as const;

export const RFI_STATUSES = [
  "Open",
  "In Progress",
  "Waiting on Merchant",
  "Responded",
  "Closed",
] as const;

export const insertWorkflowSchema = createInsertSchema(workflows).omit({
  id: true,
  createdAt: true,
});

export const insertWorkflowRunSchema = createInsertSchema(workflowRuns).omit({
  id: true,
  createdAt: true,
});

export type Workflow = typeof workflows.$inferSelect;
export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>;
export type UpdateWorkflowRequest = Partial<InsertWorkflow>;

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type InsertWorkflowRun = z.infer<typeof insertWorkflowRunSchema>;

export const WORKFLOW_TRIGGERS = [
  "deal_stage_changed",
  "ticket_created",
  "contact_created",
  "deal_created",
  "ticket_sla_breach",
  "deal_sla_breach",
  "form_submitted",
  "go_live_milestone",
  "scheduled",
  "manual",
  "application_reminder",
  "inbound_message",
] as const;

export const INBOUND_CLASSIFICATIONS = [
  "booking_intent",
  "positive_reply",
  "objection",
  "unsubscribe",
  "interested",
  "callback",
  "support",
  "question",
  "neutral",
] as const;

export const INBOUND_CLASSIFICATION_LABELS: Record<string, string> = {
  booking_intent: "Booking Intent",
  positive_reply: "Positive Reply",
  objection: "Objection",
  unsubscribe: "Unsubscribe / Opt-Out",
  interested: "Interested",
  callback: "Callback Request",
  support: "Support Request",
  question: "Question",
  neutral: "Neutral",
};

export const WORKFLOW_ACTIONS = [
  "create_task",
  "send_notification",
  "update_deal",
  "update_contact_tags",
  "create_audit_log",
  "send_ghl_email",
  "send_ghl_sms",
  "send_packet",
  "generate_proposal",
  "request_review",
  "wait",
  "create_onboarding_checklist",
  "enroll_sequence",
] as const;

export const SALES_STAGES = [
  "New Lead",
  "Enriched",
  "Statement Received",
  "Review In Progress",
  "Call Booked",
  "Proposal Sent",
  "Negotiation / Follow-Up",
  "Verbal Commit",
  "Promise to Submit", // #513
  "Closed Won",
  "Closed Lost",
  "Nurture / Not Now",
] as const;

export const ONBOARDING_STAGES = [
  "Contract Sent",
  "Application Started",
  "Underwriting Submitted",
  "Approved",
  "Terminal Ordered",
  "Go-Live Scheduled",
  "Live (First Batch)",
  "Active (7 Days)",
  "Active (30 Days)",
] as const;

export const SUPPORT_STAGES = [
  "New Ticket",
  "In Progress",
  "Waiting on Merchant",
  "Resolved",
  "Closed",
] as const;

export const VERTICALS = [
  "Medical/Dental/Medspa",
  "Automotive",
  "Restaurant",
  "Home Services",
  "Retail",
  "Med Spa",
  "Dental",
  "Auto Repair",
  "Salon",
  "Gym",
  "Hotel",
  "Landscaping",
  "Construction",
  "Legal",
  "Other",
] as const;

export const OFFER_PATHS = [
  "Wholesale",
  "0% Program",
  "Terminal Needed",
  "Compare vs Square/Stripe",
  "Not Sure",
] as const;

export const TICKET_CATEGORIES = [
  "Funding/Deposits",
  "Terminal",
  "Chargeback/Dispute",
  "PCI",
  "Other",
] as const;

export const messageTemplates = pgTable("message_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  channel: text("channel").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  mergeFields: text("merge_fields").array(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertMessageTemplateSchema = createInsertSchema(messageTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type MessageTemplate = typeof messageTemplates.$inferSelect;
export type InsertMessageTemplate = z.infer<typeof insertMessageTemplateSchema>;

export const collateralPackets = pgTable("collateral_packets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  offerPath: text("offer_path"),
  vertical: text("vertical"),
  tags: text("tags").array(),
  pages: text("pages").array(),
  description: text("description"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCollateralPacketSchema = createInsertSchema(collateralPackets).omit({
  id: true,
  createdAt: true,
});

export type CollateralPacket = typeof collateralPackets.$inferSelect;
export type InsertCollateralPacket = z.infer<typeof insertCollateralPacketSchema>;

export const ghlActivityLog = pgTable("ghl_activity_log", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  direction: text("direction").notNull(),
  channel: text("channel").notNull(),
  templateId: integer("template_id"),
  subject: text("subject"),
  body: text("body"),
  status: text("status").default("sent"),
  ghlMessageId: text("ghl_message_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertGhlActivityLogSchema = createInsertSchema(ghlActivityLog).omit({
  id: true,
  createdAt: true,
});

export type GhlActivityLog = typeof ghlActivityLog.$inferSelect;
export type InsertGhlActivityLog = z.infer<typeof insertGhlActivityLogSchema>;

export const slaConfigs = pgTable("sla_configs", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull(),
  stage: text("stage"),
  maxDurationMinutes: integer("max_duration_minutes").notNull(),
  escalationAction: text("escalation_action").notNull(),
  escalationConfig: jsonb("escalation_config"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSlaConfigSchema = createInsertSchema(slaConfigs).omit({
  id: true,
  createdAt: true,
});

export type SlaConfig = typeof slaConfigs.$inferSelect;
export type InsertSlaConfig = z.infer<typeof insertSlaConfigSchema>;

export const MERCHANT_TIERS = [
  "Starter",
  "Growth",
  "Enterprise",
  "Strategic",
] as const;

export const RISK_TIERS = [
  "Low",
  "Medium",
  "High",
  "Review Required",
] as const;

export const TEMPLATE_CATEGORIES = [
  "proposal",
  "follow_up",
  "onboarding",
  "lifecycle",
  "nurture",
  "reactivation",
  "review_request",
  "support",
  "case_study",
] as const;

export const GHL_CHANNELS = [
  "email",
  "sms",
] as const;

export const prospectLists = pgTable("prospect_lists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  fileName: text("file_name"),
  fileHash: text("file_hash"),
  importType: text("import_type"),
  totalRecords: integer("total_records").default(0),
  enrichedRecords: integer("enriched_records").default(0),
  qualifiedRecords: integer("qualified_records").default(0),
  insertedRows: integer("inserted_rows").default(0),
  skippedWithinFile: integer("skipped_within_file").default(0),
  skippedExisting: integer("skipped_existing").default(0),
  conflictRows: integer("conflict_rows").default(0),
  actor: text("actor"),
  status: text("status").default("processing"),
  uploadedBy: text("uploaded_by"),
  // Archival fields — set when a list is soft-deleted (e.g. demo cleanup)
  archivedAt: timestamp("archived_at"),
  archivedReason: text("archived_reason"),
  // Staged import pipeline — tracks where in the readiness lifecycle this list sits
  // Values: uploaded | mapped | validated | scored | suppressed | ready
  readinessState: text("readiness_state").notNull().default("uploaded"),
  // Required lead source for compliance and attribution tracking
  leadSource: text("lead_source"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  // Replay protection: same (importType, fileHash) cannot produce two running/complete lists.
  uniqueIndex("prospect_lists_import_type_hash_uidx")
    .on(table.importType, table.fileHash)
    .where(sql`status IN ('running', 'complete')`),
  index("prospect_lists_archived_at_idx").on(table.archivedAt),
]);

export const insertProspectListSchema = createInsertSchema(prospectLists).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ProspectList = typeof prospectLists.$inferSelect;
export type InsertProspectList = z.infer<typeof insertProspectListSchema>;

export const PROSPECT_STATUSES = [
  "raw",
  "enriching",
  "enriched",
  "qualified",
  "disqualified",
  "in_campaign",
  "converted",
  "do_not_contact",
] as const;

export const QUALIFICATION_SCORES = [
  "A",
  "B",
  "C",
  "D",
  "F",
] as const;

export const prospects = pgTable("prospects", {
  id: serial("id").primaryKey(),
  listId: integer("list_id").references(() => prospectLists.id),
  importExecutionId: integer("import_execution_id").references(() => prospectLists.id),
  sourceRowIndex: integer("source_row_index"),
  // BT-06: mutable projection maintained only by CommercialClassificationAuthority.
  recordClass: text("record_class").notNull().default("unknown"),
  contactId: integer("contact_id").references(() => contacts.id),
  companyName: text("company_name"),
  dba: text("dba"),
  website: text("website"),
  phone: text("phone"),
  email: text("email"),
  ownerFirstName: text("owner_first_name"),
  ownerLastName: text("owner_last_name"),
  ownerEmail: text("owner_email"),
  ownerPhone: text("owner_phone"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  vertical: text("vertical"),
  estimatedVolume: text("estimated_volume"),
  estimatedResidual: text("estimated_residual"),
  estimatedAvgTicket: text("estimated_avg_ticket"),
  estimatedProcessor: text("estimated_processor"),
  employeeCount: text("employee_count"),
  yearEstablished: text("year_established"),
  googleRating: text("google_rating"),
  googleReviews: text("google_reviews"),
  estimatedRevenue: text("estimated_revenue"),
  score: text("score").default("cold"),
  qualificationScore: text("qualification_score").default("C"),
  qualificationReason: text("qualification_reason"),
  status: text("status").default("raw"),
  enrichmentData: jsonb("enrichment_data"),
  enrichedAt: timestamp("enriched_at"),
  aiSummary: text("ai_summary"),
  aiPitchAngle: text("ai_pitch_angle"),
  notes: text("notes"),
  tags: text("tags").array(),
  doNotContact: boolean("do_not_contact").default(false),
  lastContactedAt: timestamp("last_contacted_at"),
  conversionClaimId: text("conversion_claim_id"),
  conversionClaimedAt: timestamp("conversion_claimed_at"),
  conversionClaimOwnerId: text("conversion_claim_owner_id"),
  conversionContactId: integer("conversion_contact_id").references(() => contacts.id),
  conversionLastError: text("conversion_last_error"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("prospects_list_id_idx").on(table.listId),
  index("prospects_retained_contact_idx").on(table.contactId).where(sql`contact_id IS NOT NULL`),
  index("prospects_status_idx").on(table.status),
  index("prospects_created_at_idx").on(table.createdAt),
  // Provenance + retry protection: same (importExecutionId, sourceRowIndex) cannot be inserted twice.
  uniqueIndex("prospects_execution_row_uidx")
    .on(table.importExecutionId, table.sourceRowIndex)
    .where(sql`import_execution_id IS NOT NULL AND source_row_index IS NOT NULL`),
  // DB-level email uniqueness for new imports (import_execution_id IS NOT NULL).
  // Pre-existing rows have NULL import_execution_id so they are excluded.
  uniqueIndex("prospects_email_import_unique_idx")
    .on(table.email)
    .where(sql`email IS NOT NULL AND import_execution_id IS NOT NULL`),
]);

export const insertProspectSchema = createInsertSchema(prospects).omit({
  id: true,
  recordClass: true,
  createdAt: true,
  updatedAt: true,
});

export type Prospect = typeof prospects.$inferSelect;
export type InsertProspect = z.infer<typeof insertProspectSchema>;
export type UpdateProspectRequest = Partial<InsertProspect>;

export const enrichmentJobs = pgTable("enrichment_jobs", {
  id: serial("id").primaryKey(),
  listId: integer("list_id").references(() => prospectLists.id),
  prospectId: integer("prospect_id").references(() => prospects.id),
  jobType: text("job_type").notNull(),
  status: text("status").default("pending"),
  totalCount: integer("total_count").default(0),
  processedCount: integer("processed_count").default(0),
  result: jsonb("result"),
  error: text("error"),
  errorLog: text("error_log"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertEnrichmentJobSchema = createInsertSchema(enrichmentJobs).omit({
  id: true,
  createdAt: true,
});

export type EnrichmentJob = typeof enrichmentJobs.$inferSelect;
export type InsertEnrichmentJob = z.infer<typeof insertEnrichmentJobSchema>;

export const CAMPAIGN_STATUSES = [
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
] as const;

export const campaigns = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  targetListId: integer("target_list_id").references(() => prospectLists.id),
  targetVerticals: text("target_verticals").array(),
  targetScores: text("target_scores").array(),
  filterCriteria: jsonb("filter_criteria"),
  aiPersonalization: boolean("ai_personalization").default(true),
  totalSteps: integer("total_steps").default(3),
  status: text("status").default("draft"),
  dailySendLimit: integer("daily_send_limit").default(200),
  totalSent: integer("total_sent").default(0),
  totalOpened: integer("total_opened").default(0),
  totalReplied: integer("total_replied").default(0),
  totalBounced: integer("total_bounced").default(0),
  totalUnsubscribed: integer("total_unsubscribed").default(0),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  readinessThreshold: integer("readiness_threshold"),
  // Bumped on every material edit (content, audience, sender, caps).
  // Approval is only valid when approvedRevision = contentRevision.
  contentRevision: integer("content_revision").notNull().default(1),
  // The contentRevision that was approved. NULL = unapproved.
  approvedRevision: integer("approved_revision"),
});

// ---------------------------------------------------------------------------
// Campaign Approvals — immutable launch approval per content revision.
// Every campaign queueing action requires an approval whose revision matches
// the campaign's current content_revision.  Material edits bump content_revision
// and set approved_revision to NULL, making prior approvals stale.
// ---------------------------------------------------------------------------
export const campaignApprovals = pgTable("campaign_approvals", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  // Matches campaigns.content_revision at approval time.
  revision: integer("revision").notNull(),
  approvedBy: text("approved_by").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  // Fingerprint of content+audience+sender+caps at approval time.
  scopeHash: text("scope_hash").notNull(),
  // Human confirmation phrase required from the approver.
  confirmToken: text("confirm_token").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("campaign_approvals_campaign_revision_uidx").on(t.campaignId, t.revision),
  index("campaign_approvals_campaign_id_idx").on(t.campaignId),
]);

export type CampaignApproval = typeof campaignApprovals.$inferSelect;

export const insertCampaignSchema = createInsertSchema(campaigns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Campaign = typeof campaigns.$inferSelect;
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type UpdateCampaignRequest = Partial<InsertCampaign>;

export const campaignSteps = pgTable("campaign_steps", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").references(() => campaigns.id),
  stepOrder: integer("step_order").notNull(),
  stepType: text("step_type").notNull(),
  delayDays: integer("delay_days").default(0),
  subject: text("subject"),
  bodyTemplate: text("body_template"),
  aiPrompt: text("ai_prompt"),
  useAiPersonalization: boolean("use_ai_personalization").default(true),
  channel: text("channel").default("email"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCampaignStepSchema = createInsertSchema(campaignSteps).omit({
  id: true,
  createdAt: true,
});

export type CampaignStep = typeof campaignSteps.$inferSelect;
export type InsertCampaignStep = z.infer<typeof insertCampaignStepSchema>;

// ---------------------------------------------------------------------------
// Campaign Previews — durable DB record of every audience preview run.
// The queue endpoint verifies a completed, unexpired, unconsumed, hash-matching
// preview before proceeding. Status lifecycle:
//   running → done | failed | interrupted (server restart)
// ---------------------------------------------------------------------------
export const campaignPreviews = pgTable("campaign_previews", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("running"),
  eligibleCount: integer("eligible_count"),
  totalInVerticals: integer("total_in_verticals"),
  blockedCount: integer("blocked_count"),
  blockReasons: jsonb("block_reasons").$type<Record<string, number>>().default({}),
  sampleContacts: jsonb("sample_contacts").$type<Array<{ id: number; name: string; email: string; vertical: string | null }>>().default([]),
  targetVerticals: text("target_verticals").array().default([]),
  targetingHash: text("targeting_hash").notNull(),
  requestedBy: text("requested_by"),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  expiresAt: timestamp("expires_at"),
  consumedAt: timestamp("consumed_at"),
  readinessThreshold: integer("readiness_threshold"),
  readinessModelVersion: integer("readiness_model_version"),
  readinessBreakdown: jsonb("readiness_breakdown"),
  cr04CohortRunId: uuid("cr04_cohort_run_id"),
  cr04PolicyVersion: integer("cr04_policy_version"),
  cr04DependencyFingerprint: text("cr04_dependency_fingerprint"),
});

export const insertCampaignPreviewSchema = createInsertSchema(campaignPreviews).omit({ id: true, createdAt: true });
export type CampaignPreview = typeof campaignPreviews.$inferSelect;
export type InsertCampaignPreview = z.infer<typeof insertCampaignPreviewSchema>;

// ---------------------------------------------------------------------------
// Contact Readiness Runs — tracks backfill execution state
// ---------------------------------------------------------------------------
export const contactReadinessRuns = pgTable("contact_readiness_runs", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  modelVersion: integer("model_version").notNull(),
  status: text("status").notNull().default("idle"),
  totalEligible: integer("total_eligible"),
  processed: integer("processed").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  force: boolean("force").notNull().default(false),
  lastProcessedContactId: integer("last_processed_contact_id"),
  startedAt: timestamp("started_at").defaultNow(),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  completedAt: timestamp("completed_at"),
  lastError: text("last_error"),
});

export type ContactReadinessRun = typeof contactReadinessRuns.$inferSelect;
export type InsertContactReadinessRun = typeof contactReadinessRuns.$inferInsert;

export const OUTBOUND_STATUSES = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "opened",
  "replied",
  "bounced",
  "failed",
  "skipped",
  "unsubscribed",
] as const;

export const outboundMessages = pgTable("outbound_messages", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").references(() => campaigns.id),
  stepId: integer("step_id").references(() => campaignSteps.id),
  prospectId: integer("prospect_id").references(() => prospects.id),
  contactId: integer("contact_id").references(() => contacts.id),
  channel: text("channel").default("email"),
  toEmail: text("to_email"),
  toPhone: text("to_phone"),
  subject: text("subject"),
  body: text("body"),
  personalizedSubject: text("personalized_subject"),
  personalizedBody: text("personalized_body"),
  status: text("status").default("queued"),
  scheduledFor: timestamp("scheduled_for"),
  sendingAt: timestamp("sending_at"),
  sentAt: timestamp("sent_at"),
  openedAt: timestamp("opened_at"),
  repliedAt: timestamp("replied_at"),
  bouncedAt: timestamp("bounced_at"),
  ghlMessageId: text("ghl_message_id"),
  error: text("error"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("outbound_messages_campaign_id_idx").on(table.campaignId),
  index("outbound_messages_status_idx").on(table.status),
  index("outbound_messages_campaign_status_idx").on(table.campaignId, table.status),
  index("outbound_messages_scheduled_for_idx").on(table.scheduledFor),
]);

// Frozen campaign-membership ledger and the durable queue owner. Queue items
// have a composite FK to this ledger, so a queue cannot add a non-preview
// contact even after the audience changes.
export const campaignPreviewMembers = pgTable("campaign_preview_members", {
  previewId: integer("preview_id").notNull().references(() => campaignPreviews.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  subjectGeneration: integer("subject_generation").notNull(),
  subjectMutationAt: timestamp("subject_mutation_at"),
  normalizedEmailTokenHash: text("normalized_email_token_hash").notNull(),
  eligibilityDecision: text("eligibility_decision").notNull(),
  reasonCodes: jsonb("reason_codes").notNull().default([]),
  taxonomyVersion: text("taxonomy_version"),
  prerequisiteVersion: integer("prerequisite_version").notNull().default(1),
  readinessModelVersion: integer("readiness_model_version"),
  contactabilitySnapshotRef: uuid("contactability_snapshot_ref").references(() => eligibilitySnapshots.id, { onDelete: "set null" }),
  // This is an optional lower-layer CRO-02 observation.  It never replaces the
  // frozen campaign or BT-10 readiness decision.
  commercialResolutionSnapshotId: uuid("commercial_resolution_snapshot_id").references(() => commercialResolutionSnapshots.id, { onDelete: "restrict" }),
  cr04DecisionId: uuid("cr04_decision_id"),
  cr04CohortOrdinal: integer("cr04_cohort_ordinal"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("campaign_preview_members_schema_pk").on(table.previewId, table.contactId),
  index("campaign_preview_members_eligible_schema_idx").on(table.previewId, table.contactId),
]);

export const campaignQueueRuns = pgTable("campaign_queue_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  previewId: integer("preview_id").notNull().references(() => campaignPreviews.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull(),
  actorId: text("actor_id"),
  state: text("state").notNull().default("pending"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  cursorContactId: integer("cursor_contact_id"),
  queuedCount: integer("queued_count").notNull().default(0),
  excludedCount: integer("excluded_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  failureCode: text("failure_code"),
}, (table) => [
  uniqueIndex("campaign_queue_runs_preview_schema_uidx").on(table.previewId),
  uniqueIndex("campaign_queue_runs_idempotency_schema_uidx").on(table.campaignId, table.idempotencyKey),
]);

export const campaignQueueItems = pgTable("campaign_queue_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  queueRunId: uuid("queue_run_id").notNull().references(() => campaignQueueRuns.id, { onDelete: "cascade" }),
  previewId: integer("preview_id").notNull(),
  contactId: integer("contact_id").notNull(),
  stepId: integer("step_id").references(() => campaignSteps.id, { onDelete: "set null" }),
  disposition: text("disposition").notNull().default("pending"),
  reasonCode: text("reason_code"),
  outboundMessageId: integer("outbound_message_id").references(() => outboundMessages.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  uniqueIndex("campaign_queue_items_member_schema_uidx").on(table.queueRunId, table.contactId, table.stepId),
  index("campaign_queue_items_run_schema_idx").on(table.queueRunId, table.disposition, table.contactId),
]);

// CR-04 — channel-qualified decisions and immutable cohort authority.
export const cr04QualificationPolicies = pgTable("cr04_qualification_policies", {
  version: integer("version").primaryKey(),
  status: text("status").notNull().default("active"),
  decisionTtlSeconds: integer("decision_ttl_seconds").notNull(),
  taxonomyVersion: text("taxonomy_version").notNull(),
  document: jsonb("document").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const cr04ChannelDecisions = pgTable("cr04_channel_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  purpose: text("purpose").notNull().default("marketing_outreach"),
  policyVersion: integer("policy_version").notNull().references(() => cr04QualificationPolicies.version),
  taxonomyVersion: text("taxonomy_version").notNull(),
  decision: text("decision").notNull(),
  reasonCodes: text("reason_codes").array().notNull(),
  dependencyFingerprint: text("dependency_fingerprint").notNull(),
  inputSnapshot: jsonb("input_snapshot").notNull(),
  evidenceRefs: jsonb("evidence_refs").notNull().default([]),
  commercialResolutionSnapshotId: uuid("commercial_resolution_snapshot_id").references(() => commercialResolutionSnapshots.id),
  decidedAt: timestamp("decided_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cr04_channel_decisions_schema_uidx").on(
    table.contactId, table.channel, table.purpose, table.policyVersion, table.dependencyFingerprint,
  ),
  index("cr04_channel_decisions_schema_current_idx").on(table.contactId, table.channel, table.expiresAt),
]);

export const cr04CohortDefinitions = pgTable("cr04_cohort_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  purpose: text("purpose").notNull(),
  channel: text("channel").notNull(),
  policyVersion: integer("policy_version").notNull().references(() => cr04QualificationPolicies.version),
  scope: jsonb("scope").notNull(),
  filters: jsonb("filters").notNull(),
  definitionFingerprint: text("definition_fingerprint").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cr04_cohort_definitions_schema_fingerprint_uidx").on(table.definitionFingerprint),
]);

export const cr04CohortRuns = pgTable("cr04_cohort_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  definitionId: uuid("definition_id").notNull().references(() => cr04CohortDefinitions.id),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("frozen"),
  asOf: timestamp("as_of").notNull(),
  frozenAt: timestamp("frozen_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  cancelledAt: timestamp("cancelled_at"),
  consumedAt: timestamp("consumed_at"),
  memberCount: integer("member_count").notNull().default(0),
  membershipFingerprint: text("membership_fingerprint").notNull(),
  buildCursor: integer("build_cursor").notNull().default(0),
  reconciliationCursor: integer("reconciliation_cursor").notNull().default(0),
  buildPhase: text("build_phase").notNull().default("building"),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  buildFence: integer("build_fence").notNull().default(0),
  failedAt: timestamp("failed_at"),
  failureCode: text("failure_code"),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cr04_cohort_runs_schema_uidx").on(table.definitionId, table.idempotencyKey),
]);

export const cr04CohortMembers = pgTable("cr04_cohort_members", {
  runId: uuid("run_id").notNull().references(() => cr04CohortRuns.id),
  ordinal: integer("ordinal").notNull(),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  decisionId: uuid("decision_id").notNull().references(() => cr04ChannelDecisions.id),
  dependencyFingerprint: text("dependency_fingerprint").notNull(),
  includedAt: timestamp("included_at").notNull().defaultNow(),
  removedAt: timestamp("removed_at"),
  removalReasonCode: text("removal_reason_code"),
}, (table) => [
  unique("cr04_cohort_members_schema_pk").on(table.runId, table.ordinal),
  unique("cr04_cohort_members_schema_contact_uidx").on(table.runId, table.contactId),
  index("cr04_cohort_members_schema_order_idx").on(table.runId, table.ordinal),
]);

export const cr04EnrollmentIntents = pgTable("cr04_enrollment_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  sequenceId: integer("sequence_id").notNull().references(() => followUpSequences.id),
  channel: text("channel").notNull(),
  source: text("source").notNull(),
  actorId: text("actor_id").notNull(),
  decisionId: uuid("decision_id").notNull().references(() => cr04ChannelDecisions.id),
  cohortRunId: uuid("cohort_run_id").references(() => cr04CohortRuns.id),
  status: text("status").notNull().default("approved"),
  reasonCode: text("reason_code"),
  enrollmentId: integer("enrollment_id").references(() => sequenceEnrollments.id),
  programId: uuid("program_id").references(() => sfpPrograms.id),
  businessId: integer("business_id").references(() => businesses.id),
  normalizedEmailHash: text("normalized_email_hash"),
  preparationState: text("preparation_state"),
  preparationSnapshot: jsonb("preparation_snapshot"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("canonical_preparation_business_program_idx").on(table.businessId,table.programId,table.preparationState),
  uniqueIndex("canonical_preparation_sequence_address_idx")
    .on(table.businessId,table.programId,table.normalizedEmailHash,table.sequenceId)
    .where(sql`program_id IS NOT NULL`),
  check("canonical_preparation_scope_chk", sql`(
    program_id IS NULL AND business_id IS NULL AND normalized_email_hash IS NULL
      AND preparation_state IS NULL AND preparation_snapshot IS NULL
  ) OR (
    program_id IS NOT NULL AND business_id IS NOT NULL
      AND normalized_email_hash IS NOT NULL AND preparation_state IS NOT NULL
      AND preparation_snapshot IS NOT NULL
      AND normalized_email_hash ~ '^[a-f0-9]{64}$'
      AND preparation_state IN ('pending_validation','ready_held','exception','rejected','suppressed')
      AND jsonb_typeof(preparation_snapshot)='object'
      AND channel='email' AND status='blocked'
  )`),
]);

export type Cr04ChannelDecision = typeof cr04ChannelDecisions.$inferSelect;
export type Cr04CohortRun = typeof cr04CohortRuns.$inferSelect;
export type Cr04CohortMember = typeof cr04CohortMembers.$inferSelect;

export const insertOutboundMessageSchema = createInsertSchema(outboundMessages).omit({
  id: true,
  createdAt: true,
});

export type OutboundMessage = typeof outboundMessages.$inferSelect;
export type InsertOutboundMessage = z.infer<typeof insertOutboundMessageSchema>;
export type UpdateOutboundMessageRequest = Partial<InsertOutboundMessage>;

export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  content: text("content").notNull(),
  version:integer("version").notNull().default(1),
  deletedAt:timestamp("deleted_at"),
  authorId: text("author_id"),
  authorName: text("author_name"),
  pinned: boolean("pinned").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertNoteSchema = createInsertSchema(notes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  version:true,deletedAt:true,
});

export const noteCommandReceipts=pgTable("note_command_receipts",{
  actorId:varchar("actor_id").notNull().references(()=>users.id),
  commandId:uuid("command_id").notNull(),noteId:integer("note_id").notNull().references(()=>notes.id),
  payloadHash:text("payload_hash").notNull(),result:jsonb("result").notNull(),
  createdAt:timestamp("created_at").notNull().defaultNow(),
},table=>[primaryKey({columns:[table.actorId,table.commandId]})]);

export type Note = typeof notes.$inferSelect;
export type InsertNote = z.infer<typeof insertNoteSchema>;

export const ENRICHMENT_JOB_TYPES = [
  "website_scrape",
  "ai_classify",
  "owner_lookup",
  "full_enrich",
] as const;

export const CAMPAIGN_STEP_TYPES = [
  "email",
  "sms",
  "wait",
  "ai_qualify",
] as const;

export const emailLogs = pgTable("email_logs", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  direction: text("direction").notNull().default("outbound"),
  from: text("from_address"),
  to: text("to_address"),
  subject: text("subject"),
  body: text("body"),
  snippet: text("snippet"),
  templateId: integer("template_id"),
  status: text("status").default("sent"),
  openedAt: timestamp("opened_at"),
  clickedAt: timestamp("clicked_at"),
  repliedAt: timestamp("replied_at"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("email_logs_created_at_idx").on(table.createdAt),
  index("email_logs_contact_id_idx").on(table.contactId),
]);

export const insertEmailLogSchema = createInsertSchema(emailLogs).omit({
  id: true,
  createdAt: true,
});

export type EmailLog = typeof emailLogs.$inferSelect;
export type InsertEmailLog = z.infer<typeof insertEmailLogSchema>;

export const callLogs = pgTable("call_logs", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  direction: text("direction").notNull().default("outbound"),
  duration: integer("duration"),
  outcome: text("outcome"),
  summary: text("summary"),
  aiSummary: text("ai_summary"),
  recordingUrl: text("recording_url"),
  callerName: text("caller_name"),
  nextSteps: text("next_steps"),
  sentiment: text("sentiment"),
  metadata: jsonb("metadata"),
  // Idempotency key for log-activity deduplication (UUIDv4, optional; unique when non-null)
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCallLogSchema = createInsertSchema(callLogs).omit({
  id: true,
  createdAt: true,
});

export type CallLog = typeof callLogs.$inferSelect;
export type InsertCallLog = z.infer<typeof insertCallLogSchema>;

export const stageAutomationRules = pgTable("stage_automation_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  pipeline: text("pipeline").notNull().default("sales"),
  fromStage: text("from_stage"),
  toStage: text("to_stage").notNull(),
  actions: jsonb("actions").notNull(),
  enabled: boolean("enabled").default(true),
  priority: integer("priority").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertStageAutomationRuleSchema = createInsertSchema(stageAutomationRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type StageAutomationRule = typeof stageAutomationRules.$inferSelect;
export type InsertStageAutomationRule = z.infer<typeof insertStageAutomationRuleSchema>;

export const STAGE_AUTOMATION_ACTIONS = [
  "create_task",
  "send_email",
  "send_sms",
  "send_notification",
  "update_contact_tags",
  "create_follow_up",
  "assign_owner",
  "send_packet",
  "update_deal_fields",
  "enroll_sequence",
  "log_activity",
] as const;

export const followUpSequences = pgTable("follow_up_sequences", {
  id: serial("id").primaryKey(),
  version:integer("version").notNull().default(1),
  retiredAt:timestamp("retired_at"),
  name: text("name").notNull(),
  description: text("description"),
  triggerType: text("trigger_type").notNull().default("manual"),
  triggerConfig: jsonb("trigger_config"),
  totalSteps: integer("total_steps").default(0),
  status: text("status").default("paused"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  sequenceFamily: text("sequence_family"),
  eligibleConsentTiers: text("eligible_consent_tiers").array(),
  channelsAllowed: text("channels_allowed").array(),
  offerRoutes: text("offer_routes").array(),
  lifecycleStagesAllowed: text("lifecycle_stages_allowed").array(),
});

export const insertFollowUpSequenceSchema = createInsertSchema(followUpSequences).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  version:true,retiredAt:true,
});
export const sequenceCommandReceipts=pgTable("sequence_command_receipts",{
  actorId:varchar("actor_id").notNull().references(()=>users.id),commandId:uuid("command_id").notNull(),
  sequenceId:integer("sequence_id").notNull().references(()=>followUpSequences.id),
  payloadHash:text("payload_hash").notNull(),result:jsonb("result").notNull(),
  createdAt:timestamp("created_at").notNull().defaultNow(),
},table=>[primaryKey({columns:[table.actorId,table.commandId]})]);

export type FollowUpSequence = typeof followUpSequences.$inferSelect;
export type InsertFollowUpSequence = z.infer<typeof insertFollowUpSequenceSchema>;

export const sequenceSteps = pgTable("sequence_steps", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id").references(() => followUpSequences.id),
  stepOrder: integer("step_order").notNull(),
  actionType: text("action_type").notNull(),
  delayDays: integer("delay_days").default(0),
  delayHours: integer("delay_hours").default(0),
  subject: text("subject"),
  body: text("body"),
  templateId: integer("template_id"),
  config: jsonb("config"),
  variantBSubject: text("variant_b_subject"),
  variantBBody: text("variant_b_body"),
  abTestConfig: jsonb("ab_test_config"),
  abTestResults: jsonb("ab_test_results"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSequenceStepSchema = createInsertSchema(sequenceSteps).omit({
  id: true,
  createdAt: true,
});

export type SequenceStep = typeof sequenceSteps.$inferSelect;
export type InsertSequenceStep = z.infer<typeof insertSequenceStepSchema>;

export interface AbTestConfig {
  splitRatio?: number;
  minSampleSize?: number;
  winnerCriteria?: "open_rate" | "click_rate" | "reply_rate";
}

export interface AbTestResults {
  variantASent: number;
  variantBSent: number;
  aOpens: number;
  bOpens: number;
  aClicks: number;
  bClicks: number;
  aReplies: number;
  bReplies: number;
  winnerSelected: string | null;
  winnerAt: string | null;
  startedAt: string | null;
  statisticallySignificant?: boolean;
}

export const sequenceEnrollments = pgTable("sequence_enrollments", {
  id: serial("id").primaryKey(),
  sequenceId: integer("sequence_id").references(() => followUpSequences.id),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  currentStep: integer("current_step").default(0),
  status: text("status").default("active"),
  nextActionAt: timestamp("next_action_at"),
  completedAt: timestamp("completed_at"),
  pausedAt: timestamp("paused_at"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("sequence_enrollments_contact_id_status_idx").on(table.contactId, table.status),
  uniqueIndex("idx_sequence_enrollments_active_unique").on(table.contactId, table.sequenceId).where(sql`status IN ('active', 'paused')`),
  index("seq_enrollments_status_next_action_idx").on(table.status, table.nextActionAt).where(sql`status = 'active'`),
]);

export const insertSequenceEnrollmentSchema = createInsertSchema(sequenceEnrollments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SequenceEnrollment = typeof sequenceEnrollments.$inferSelect;
export type InsertSequenceEnrollment = z.infer<typeof insertSequenceEnrollmentSchema>;

// ── Canonical Communication Events (Wave A3) ─────────────────────────────────
// Single normalized record for every inbound and outbound communication across
// all channels. Additive: existing channel-specific tables are not removed.
export const communicationEvents = pgTable("communication_events", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
  dealId: integer("deal_id").references(() => deals.id, { onDelete: "set null" }),
  direction: text("direction").notNull(), // 'inbound' | 'outbound'
  channel: text("channel").notNull(),     // 'email'|'sms'|'call'|'voicemail'|'chat'|'form'|'portal'|'rvm'
  provider: text("provider"),             // 'ghl'|'smtp'|'twilio'|'internal'|'manual'
  subject: text("subject"),
  body: text("body"),
  status: text("status").notNull().default("sent"),
  intentClassification: text("intent_classification"),
  intentConfidence: numeric("intent_confidence", { precision: 5, scale: 4 }),
  automationStopped: boolean("automation_stopped").notNull().default(false),
  automationStopReason: text("automation_stop_reason"),
  sentBy: text("sent_by").notNull().default("automation"),
  sequenceId: integer("sequence_id").references(() => followUpSequences.id, { onDelete: "set null" }),
  sequenceStepId: integer("sequence_step_id").references(() => sequenceSteps.id, { onDelete: "set null" }),
  externalMessageId: text("external_message_id"),
  ghlMessageId: text("ghl_message_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("comm_events_contact_id_created_at_idx").on(table.contactId, table.createdAt),
  index("comm_events_deal_id_created_at_idx").on(table.dealId, table.createdAt),
  index("comm_events_direction_channel_idx").on(table.direction, table.channel),
  index("comm_events_contact_id_direction_idx").on(table.contactId, table.direction),
  index("comm_events_status_idx").on(table.status),
]);

export const insertCommunicationEventSchema = createInsertSchema(communicationEvents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type CommunicationEvent = typeof communicationEvents.$inferSelect;
export type InsertCommunicationEvent = z.infer<typeof insertCommunicationEventSchema>;

// ── GHL Shadow Log (Wave B1) ──────────────────────────────────────────────────
// Captures what GHL inbound sync WOULD have written to Liberty when
// GHL_CRM_SYNC_MODE='shadow'. Allows admins to review CRM drift before
// disabling write-back entirely. Does NOT affect outbound sends.
export const ghlShadowLog = pgTable("ghl_shadow_log", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  syncFunction: text("sync_function").notNull(),
  ghlId: text("ghl_id"),
  field: text("field"),
  currentValue: jsonb("current_value"),
  ghlValue: jsonb("ghl_value"),
  wouldHaveWritten: boolean("would_have_written").notNull().default(true),
  reviewedAt: timestamp("reviewed_at"),
  reviewedBy: text("reviewed_by"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("ghl_shadow_log_entity_type_entity_id_idx").on(table.entityType, table.entityId),
  index("ghl_shadow_log_sync_function_idx").on(table.syncFunction),
  index("ghl_shadow_log_created_at_idx").on(table.createdAt),
]);

export type GhlShadowLog = typeof ghlShadowLog.$inferSelect;

export const SEQUENCE_STATUSES = [
  "active",
  "paused",
  "completed",
  "cancelled",
  "bounced",
] as const;

export const SEQUENCE_STEP_TYPES = [
  "email",
  "sms",
  "call",
  "call_reminder",
  "voicemail_drop",
  "task",
  "wait",
  "condition",
] as const;

export const CALL_OUTCOMES = [
  "Connected",
  "Voicemail",
  "No Answer",
  "Busy",
  "Wrong Number",
  "Callback Scheduled",
  "Not Interested",
  "Interested",
  "Appointment Set",
] as const;

export const CALL_SENTIMENTS = [
  "Positive",
  "Neutral",
  "Negative",
  "Mixed",
] as const;

export const EMAIL_DIRECTIONS = [
  "inbound",
  "outbound",
] as const;

export const CONTACT_SCORE_FACTORS = {
  emailOpened: 5,
  emailReplied: 15,
  callConnected: 20,
  formSubmitted: 25,
  meetingBooked: 30,
  proposalViewed: 10,
  websiteVisit: 3,
  daysSinceLastActivity: -1,
} as const;

export const sunbizEntities = pgTable("sunbiz_entities", {
  id: serial("id").primaryKey(),
  filingNumber: text("filing_number"),
  feiEinNumber: text("fei_ein_number"),
  entityName: text("entity_name").notNull(),
  dba: text("dba"),
  coverageKeys: text("coverage_keys").array().generatedAlwaysAs(sql.raw(coverageSourceKeys())),
  // Publish cannot faithfully round-trip these nested expressions as index
  // expressions. Stored generated keys preserve database-owned normalization
  // while the indexes below remain ordinary, publish-safe column indexes.
  contactIdentityNameKey: text("contact_identity_name_key").generatedAlwaysAs(sql`
    btrim(regexp_replace(
      regexp_replace(
        lower(regexp_replace(coalesce(entity_name, ''), '[^a-zA-Z0-9]+', ' ', 'g')),
        '\\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\\M', ' ', 'g'
      ),
      '\\s+', ' ', 'g'
    ))
  `),
  contactIdentityDbaKey: text("contact_identity_dba_key").generatedAlwaysAs(sql`
    btrim(regexp_replace(
      regexp_replace(
        lower(regexp_replace(coalesce(dba, ''), '[^a-zA-Z0-9]+', ' ', 'g')),
        '\\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\\M', ' ', 'g'
      ),
      '\\s+', ' ', 'g'
    ))
  `),
  entityType: text("entity_type"),
  filingDate: text("filing_date"),
  entityStatus: text("entity_status"),
  lastEvent: text("last_event"),
  lastEventDate: text("last_event_date"),
  principalAddress: text("principal_address"),
  principalCity: text("principal_city"),
  principalState: text("principal_state"),
  principalZip: text("principal_zip"),
  mailingAddress: text("mailing_address"),
  registeredAgentName: text("registered_agent_name"),
  registeredAgentAddress: text("registered_agent_address"),
  officers: jsonb("officers"),
  website: text("website"),
  email: text("email"),
  phone: text("phone"),
  ownerName: text("owner_name"),
  ownerEmail: text("owner_email"),
  ownerPhone: text("owner_phone"),
  vertical: text("vertical"),
  score: text("score").default("raw"),
  enrichmentStatus: text("enrichment_status").default("pending"),
  enrichmentData: jsonb("enrichment_data"),
  enrichedAt: timestamp("enriched_at"),
  aiSummary: text("ai_summary"),
  listId: integer("list_id").references(() => prospectLists.id),
  prospectId: integer("prospect_id").references(() => prospects.id),
  notes: text("notes"),
  tags: text("tags").array(),
  source: text("source").default("sunbiz"),
  searchQuery: text("search_query"),
  detailUrl: text("detail_url"),
  // Provenance: links each entity batch back to a specific import execution
  importExecutionId: uuid("import_execution_id").references(() => importExecutions.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("sunbiz_entities_source_fn_unique").on(table.source, table.filingNumber).where(sql`source IS NOT NULL AND filing_number IS NOT NULL`),
  index("sunbiz_entities_entity_name_idx").on(table.entityName),
  index("sunbiz_entities_retained_prospect_idx").on(table.prospectId).where(sql`prospect_id IS NOT NULL`),
  index("sunbiz_entities_enrichment_status_idx").on(table.enrichmentStatus),
  index("sunbiz_entities_list_id_idx").on(table.listId),
  index("sunbiz_entities_created_at_idx").on(table.createdAt),
  index("sunbiz_entities_contact_identity_name_key_idx").on(table.contactIdentityNameKey).where(sql`filing_number IS NOT NULL`),
  index("sunbiz_coverage_domain_key_idx").on(sql`(${table.coverageKeys}[1])`),
  index("sunbiz_coverage_phone_key_idx").on(sql`(${table.coverageKeys}[2])`),
  index("sunbiz_coverage_owner_phone_key_idx").on(sql`(${table.coverageKeys}[3])`),
  index("sunbiz_coverage_address_key_idx").on(sql`(${table.coverageKeys}[4])`),
  index("sunbiz_coverage_street_key_idx").on(sql`(${table.coverageKeys}[5])`),
  index("sunbiz_entities_contact_identity_dba_key_idx").on(table.contactIdentityDbaKey).where(sql`filing_number IS NOT NULL AND dba IS NOT NULL`),
  // Simple immutable-function expressions round-trip through Publish without
  // serializing nested regexp bodies. Queries retain the equivalent inline SQL,
  // so read availability never depends on native write authority.
  index("canonical_link_registry_name_lookup_idx").on(sql`crm_identity_name(${table.entityName})`)
    .where(sql`filing_number IS NOT NULL AND source IN ('sunbiz','cordata','corevt')`),
  index("canonical_link_registry_dba_lookup_idx").on(sql`crm_identity_name(${table.dba})`)
    .where(sql`filing_number IS NOT NULL AND dba IS NOT NULL AND source IN ('sunbiz','cordata','corevt')`),
]);

export const insertSunbizEntitySchema = createInsertSchema(sunbizEntities).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SunbizEntity = typeof sunbizEntities.$inferSelect;
export type InsertSunbizEntity = z.infer<typeof insertSunbizEntitySchema>;
export type UpdateSunbizEntityRequest = Partial<InsertSunbizEntity>;

export const systemSettings = pgTable("system_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: jsonb("value"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type SystemSetting = typeof systemSettings.$inferSelect;

export type UnderwritingNoteEntry = {
  note: string;
  author: string;
  authorId?: string | null;
  createdAt: string;
};

export const merchantApplications = pgTable("merchant_applications", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").references(() => users.id),
  contactId: integer("contact_id").references(() => contacts.id),
  companyId: integer("company_id").references(() => companies.id),
  dealId: integer("deal_id").references(() => deals.id),
  status: text("status").default("draft"),
  currentStep: integer("current_step").default(1),
  totalSteps: integer("total_steps").default(6),
  legalBusinessName: text("legal_business_name"),
  dba: text("dba"),
  ein: text("ein"),
  businessType: text("business_type"),
  businessStartDate: text("business_start_date"),
  businessAddress: text("business_address"),
  businessCity: text("business_city"),
  businessState: text("business_state"),
  businessZip: text("business_zip"),
  businessPhone: text("business_phone"),
  businessEmail: text("business_email"),
  website: text("website"),
  vertical: text("vertical"),
  ownerFirstName: text("owner_first_name"),
  ownerLastName: text("owner_last_name"),
  ownerEmail: text("owner_email"),
  ownerPhone: text("owner_phone"),
  ownerDob: text("owner_dob"),
  ownerSsn: text("owner_ssn"),
  ownerAddress: text("owner_address"),
  ownerCity: text("owner_city"),
  ownerState: text("owner_state"),
  ownerZip: text("owner_zip"),
  ownershipPercent: integer("ownership_percent"),
  additionalOwners: jsonb("additional_owners"),
  bankName: text("bank_name"),
  bankRoutingNumber: text("bank_routing_number"),
  bankAccountNumber: text("bank_account_number"),
  bankAccountType: text("bank_account_type"),
  estimatedMonthlyVolume: text("estimated_monthly_volume"),
  estimatedAvgTicket: text("estimated_avg_ticket"),
  highestTicket: text("highest_ticket"),
  currentProcessor: text("current_processor"),
  currentRate: text("current_rate"),
  acceptedCardTypes: text("accepted_card_types").array(),
  terminalNeeded: boolean("terminal_needed").default(false),
  terminalType: text("terminal_type"),
  terminalQuantity: integer("terminal_quantity").default(1),
  ecommerceNeeded: boolean("ecommerce_needed").default(false),
  preferredProgram: text("preferred_program"),
  referralSource: text("referral_source"),
  referralCode: text("referral_code"),
  esignStatus: text("esign_status").default("pending"),
  esignDocumentId: text("esign_document_id"),
  esignSigningUrl: text("esign_signing_url"),
  esignedAt: timestamp("esigned_at"),
  esignIp: text("esign_ip"),
  underwritingStatus: text("underwriting_status").default("pending"),
  underwritingNotes: text("underwriting_notes"),
  underwritingNotesLog: jsonb("underwriting_notes_log").$type<UnderwritingNoteEntry[]>().default(sql`'[]'::jsonb`),
  approvedAt: timestamp("approved_at"),
  declinedAt: timestamp("declined_at"),
  declineReason: text("decline_reason"),
  submittedAt: timestamp("submitted_at"),
  completedAt: timestamp("completed_at"),
  draftTokenHash: text("draft_token_hash"),
  // ── Protected-data (AES-256-GCM) envelope metadata ──────────────────────
  // Non-reversible fingerprints (keyed HMAC) for equality/dedup lookups only.
  einFingerprint: text("ein_fingerprint"),
  ssnFingerprint: text("ssn_fingerprint"),
  bankAccountFingerprint: text("bank_account_fingerprint"),
  // Masked, display-safe representations (never plaintext).
  einMask: text("ein_mask"),
  ssnMask: text("ssn_mask"),
  bankAccountMask: text("bank_account_mask"),
  bankRoutingMask: text("bank_routing_mask"),
  // Ciphertext scheme version applied to the protected fields on this row.
  protectedDataVersion: integer("protected_data_version"),
  // Per-field/nested protected-data metadata (which fields encrypted, scheme, etc.).
  protectedDataMetadata: jsonb("protected_data_metadata").$type<Record<string, unknown>>(),
  // Optional expiry for time-boxed retention of protected data.
  protectedDataExpiresAt: timestamp("protected_data_expires_at"),
  // Idempotency key for at-most-once protected-data write/submit operations.
  // Scoped per-application (combined with id) to avoid global uniqueness conflicts.
  protectedDataIdempotencyKey: text("protected_data_idempotency_key"),
  // ── Draft lifecycle ──────────────────────────────────────────────────────
  draftTokenExpiresAt: timestamp("draft_token_expires_at"),
  draftTokenRevokedAt: timestamp("draft_token_revoked_at"),
  // ── Optimistic-concurrency state version ────────────────────────────────
  stateVersion: integer("state_version").notNull().default(0),
  // ── Finalize idempotency (processor-side) ───────────────────────────────
  finalizeIdempotencyKey: text("finalize_idempotency_key"),
  finalizeAck: jsonb("finalize_ack").$type<Record<string, unknown>>(),
  // ── eSign capability ────────────────────────────────────────────────────
  esignCapabilityHash: text("esign_capability_hash"),
  esignCapabilityExpiresAt: timestamp("esign_capability_expires_at"),
  esignCapabilityRevokedAt: timestamp("esign_capability_revoked_at"),
  esignSendState: text("esign_send_state").notNull().default("idle"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  // UNIQUE partial fingerprint index for eligible finalized applications only.
  // Guarantees no two finalized applications share the same normalized EIN.
  // Legacy rows (fingerprint NULL) are excluded; they are never part of the dedup scope.
  uniqueIndex("merchant_applications_ein_fingerprint_unique_idx")
    .on(table.einFingerprint)
    .where(sql`ein_fingerprint IS NOT NULL AND status IN ('submitted', 'under_review', 'approved', 'declined', 'withdrawn')`),
  // Idempotency unique: scoped per-application (application_id + key).
  // The global uniqueIndex is removed; per-app uniqueness is enforced here.
  index("merchant_applications_protected_idempotency_idx")
    .on(table.id, table.protectedDataIdempotencyKey)
    .where(sql`protected_data_idempotency_key IS NOT NULL`),
  // eSign document index for fast lookups by external document ID.
  index("merchant_applications_esign_document_id_idx")
    .on(table.esignDocumentId)
    .where(sql`esign_document_id IS NOT NULL`),
]);

// ---------------------------------------------------------------------------
// Merchant Application Protected-Data Outbox
// Durable, at-least-once change log for protected-data envelope mutations.
// Consumed by downstream sync/audit; never stores plaintext — only envelope
// metadata, fingerprints, and masks.
// ---------------------------------------------------------------------------
export const merchantApplicationProtectedOutbox = pgTable("merchant_application_protected_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  applicationId: integer("application_id").notNull().references(() => merchantApplications.id),
  eventType: text("event_type").notNull(), // encrypted | rotated | expired | purged
  protectedDataVersion: integer("protected_data_version"),
  // Envelope-only payload: fingerprints, masks, changed field list — NO plaintext.
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  // Idempotency guard so re-processing the same logical event is a no-op.
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull().default("pending"), // pending | processing | delivered | failed
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  availableAt: timestamp("available_at").defaultNow(),
  lockedAt: timestamp("locked_at"),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("merchant_app_protected_outbox_idempotency_uidx").on(table.idempotencyKey),
  index("merchant_app_protected_outbox_dispatch_idx")
    .on(table.status, table.availableAt)
    .where(sql`status IN ('pending', 'failed')`),
  index("merchant_app_protected_outbox_application_idx").on(table.applicationId),
]);

export type MerchantApplicationProtectedOutbox = typeof merchantApplicationProtectedOutbox.$inferSelect;
export type InsertMerchantApplicationProtectedOutbox = typeof merchantApplicationProtectedOutbox.$inferInsert;

// ── Deal Boarding Outbox ────────────────────────────────────────────────────
// Durable outbox for processor_submit effects. Keyed per deal + idempotency
// key so replays are no-ops. No sensitive values in payload.
export const dealBoardingOutbox = pgTable("deal_boarding_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: integer("deal_id").notNull().references(() => deals.id),
  applicationId: integer("application_id"),
  eventType: text("event_type").notNull().default("processor_submit"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  idempotencyKey: text("idempotency_key").notNull(),
  processorName: text("processor_name"),
  status: text("status").notNull().default("pending"), // pending | processing | delivered | failed | dead_letter
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  availableAt: timestamp("available_at").defaultNow(),
  lockedAt: timestamp("locked_at"),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("deal_boarding_outbox_idempotency_uidx").on(table.idempotencyKey),
  index("deal_boarding_outbox_dispatch_idx")
    .on(table.status, table.availableAt)
    .where(sql`status IN ('pending', 'failed')`),
  index("deal_boarding_outbox_deal_idx").on(table.dealId),
]);

export type DealBoardingOutbox = typeof dealBoardingOutbox.$inferSelect;
export type InsertDealBoardingOutbox = typeof dealBoardingOutbox.$inferInsert;

export const insertMerchantApplicationSchema = createInsertSchema(merchantApplications).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type MerchantApplication = typeof merchantApplications.$inferSelect;
export type InsertMerchantApplication = z.infer<typeof insertMerchantApplicationSchema>;

export const APPLICATION_STATUSES = [
  "draft",
  "in_progress",
  "submitted",
  "under_review",
  "approved",
  "declined",
  "withdrawn",
] as const;

export const UNDERWRITING_STATUSES = [
  "pending",
  "documents_needed",
  "in_review",
  "approved",
  "conditionally_approved",
  "declined",
  "referred",
] as const;

export const BUSINESS_TYPES = [
  "Sole Proprietorship",
  "LLC",
  "Corporation",
  "Partnership",
  "Non-Profit",
  "Government",
] as const;

export const TERMINAL_TYPES = [
  "Clover Flex",
  "Clover Mini",
  "Clover Station",
  "Dejavoo Z11",
  "PAX A920",
  "Virtual Terminal Only",
  "Mobile Reader",
] as const;

export const merchantProfiles = pgTable("merchant_profiles", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  contactId: integer("contact_id").references(() => contacts.id),
  companyId: integer("company_id").references(() => companies.id),
  dealId: integer("deal_id").references(() => deals.id),
  applicationId: integer("application_id").references(() => merchantApplications.id),
  merchantMid: text("merchant_mid"),
  accountStatus: text("account_status").default("pending"),
  goLiveDate: timestamp("go_live_date"),
  currentMonthlyVolume: text("current_monthly_volume"),
  lastStatementDate: timestamp("last_statement_date"),
  nextStatementDate: timestamp("next_statement_date"),
  programType: text("program_type"),
  terminalInfo: jsonb("terminal_info"),
  referralCode: text("referral_code").unique(),
  referralCredits: text("referral_credits").default("0"),
  referralCount: integer("referral_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertMerchantProfileSchema = createInsertSchema(merchantProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type MerchantProfile = typeof merchantProfiles.$inferSelect;
export type InsertMerchantProfile = z.infer<typeof insertMerchantProfileSchema>;

export const equipmentOrders = pgTable("equipment_orders", {
  id: serial("id").primaryKey(),
  inboundRequestId: uuid("inbound_request_id").references((): AnyPgColumn => inboundRequests.id, { onDelete: "restrict" }),
  commandKey: text("command_key"),
  applicationId: integer("application_id").references(() => merchantApplications.id),
  dealId: integer("deal_id").references(() => deals.id),
  contactId: integer("contact_id").references(() => contacts.id),
  equipmentType: text("equipment_type").notNull(),
  quantity: integer("quantity").default(1),
  shippingAddress: text("shipping_address"),
  shippingCity: text("shipping_city"),
  shippingState: text("shipping_state"),
  shippingZip: text("shipping_zip"),
  trackingNumber: text("tracking_number"),
  status: text("status").default("pending"),
  orderedAt: timestamp("ordered_at"),
  fulfillmentDueAt: timestamp("fulfillment_due_at"),
  shippedAt: timestamp("shipped_at"),
  deliveredAt: timestamp("delivered_at"),
  notes: text("notes"),
  libertyCost: numeric("liberty_cost"),
  estimatedMonthlyGp: numeric("estimated_monthly_gp"),
  paybackMonths: numeric("payback_months"),
  approvalTier: text("approval_tier"),
  managerApproved: boolean("manager_approved").default(false),
  approvedAt: timestamp("approved_at"),
  approvedByUserId: varchar("approved_by_user_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("equipment_orders_command_key_uidx").on(table.commandKey).where(sql`command_key IS NOT NULL`),
  index("equipment_orders_inbound_request_idx").on(table.inboundRequestId),
]);

export const insertEquipmentOrderSchema = createInsertSchema(equipmentOrders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type EquipmentOrder = typeof equipmentOrders.$inferSelect;
export type InsertEquipmentOrder = z.infer<typeof insertEquipmentOrderSchema>;

export const equipmentModels = pgTable("equipment_models", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").default("Terminal"),
  description: text("description"),
  msrp: real("msrp").default(0).notNull(),
  libertyCost: real("liberty_cost").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertEquipmentModelSchema = createInsertSchema(equipmentModels).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type EquipmentModel = typeof equipmentModels.$inferSelect;
export type InsertEquipmentModel = z.infer<typeof insertEquipmentModelSchema>;

export const EQUIPMENT_STATUSES = [
  "pending",
  "ordered",
  "shipped",
  "delivered",
  "installed",
  "returned",
] as const;

export const agents = pgTable("agents", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").references(() => users.id),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  role: text("role").default("sales_rep"),
  managerId: integer("manager_id"),
  commissionSplitPercent: integer("commission_split_percent").default(50),
  status: text("status").default("active"),
  territory: text("territory"),
  hireDate: timestamp("hire_date"),
  vestingMonths: integer("vesting_months").default(3),
  totalDeals: integer("total_deals").default(0),
  totalRevenue: text("total_revenue").default("0"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAgentSchema = createInsertSchema(agents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Agent = typeof agents.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;

export const agentMerchants = pgTable("agent_merchants", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull().references(() => agents.id),
  dealId: integer("deal_id").notNull().references(() => deals.id),
  merchantName: text("merchant_name"),
  mid: text("mid"),
  assignedAt: timestamp("assigned_at").defaultNow(),
}, (table) => [
  index("agent_merchants_agent_id_idx").on(table.agentId),
  index("agent_merchants_mid_idx").on(table.mid),
  unique("agent_merchants_deal_id_unique").on(table.dealId),
]);

export const insertAgentMerchantSchema = createInsertSchema(agentMerchants).omit({
  id: true,
  assignedAt: true,
});

export type AgentMerchant = typeof agentMerchants.$inferSelect;
export type InsertAgentMerchant = z.infer<typeof insertAgentMerchantSchema>;

export const residualReports = pgTable("residual_reports", {
  id: serial("id").primaryKey(),
  month: text("month").notNull(),
  processor: text("processor"),
  totalMerchants: integer("total_merchants").default(0),
  totalVolume: text("total_volume").default("0"),
  totalTransactions: integer("total_transactions").default(0),
  totalRevenue: text("total_revenue").default("0"),
  totalCost: text("total_cost").default("0"),
  netRevenue: text("net_revenue").default("0"),
  avgRevenuePerMerchant: text("avg_revenue_per_merchant").default("0"),
  newMerchants: integer("new_merchants").default(0),
  lostMerchants: integer("lost_merchants").default(0),
  attritionRate: text("attrition_rate"),
  importedAt: timestamp("imported_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertResidualReportSchema = createInsertSchema(residualReports).omit({
  id: true,
  createdAt: true,
});

export type ResidualReport = typeof residualReports.$inferSelect;
export type InsertResidualReport = z.infer<typeof insertResidualReportSchema>;

export const merchantResiduals = pgTable("merchant_residuals", {
  id: serial("id").primaryKey(),
  reportId: integer("report_id").references(() => residualReports.id),
  importId: integer("import_id").references(() => residualImports.id, { onDelete: "set null" }),
  dealId: integer("deal_id").references(() => deals.id),
  contactId: integer("contact_id").references(() => contacts.id),
  merchantMid: text("merchant_mid"),
  merchantName: text("merchant_name"),
  month: text("month").notNull(),
  volume: text("volume").default("0"),
  transactions: integer("transactions"),
  revenue: text("revenue").default("0"),
  cost: text("cost"),
  netRevenue: text("net_revenue").default("0"),
  agentId: integer("agent_id").references(() => agents.id),
  agentCommission: text("agent_commission").default("0"),
  partnerCommission: text("partner_commission").default("0"),
  volumeChange: text("volume_change"),
  revenueChange: text("revenue_change"),
  flags: text("flags").array(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertMerchantResidualSchema = createInsertSchema(merchantResiduals).omit({
  id: true,
  createdAt: true,
});

export type MerchantResidual = typeof merchantResiduals.$inferSelect;
export type InsertMerchantResidual = z.infer<typeof insertMerchantResidualSchema>;

// ── Residual Import Reconciliation ────────────────────────────────────────────
export const residualImports = pgTable("residual_imports", {
  id: serial("id").primaryKey(),
  month: text("month").notNull(),
  fileName: text("file_name").notNull(),
  status: text("status").notNull().default("pending"),
  importedBy: text("imported_by"),
  totalRows: integer("total_rows").default(0),
  matchedRows: integer("matched_rows").default(0),
  unmatchedRows: integer("unmatched_rows").default(0),
  flaggedRows: integer("flagged_rows").default(0),
  totalGrossResidual: text("total_gross_residual").default("0"),
  totalNetResidual: text("total_net_residual").default("0"),
  totalVariance: text("total_variance").default("0"),
  varianceThresholdPct: real("variance_threshold_pct").default(5),
  varianceThresholdAmt: real("variance_threshold_amt").default(50),
  varianceThresholdAmtDecimal: numeric("variance_threshold_amt_decimal", { precision: 14, scale: 2 }),
  confirmedAt: timestamp("confirmed_at"),
  confirmedBy: text("confirmed_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertResidualImportSchema = createInsertSchema(residualImports).omit({
  id: true,
  createdAt: true,
});

export type ResidualImport = typeof residualImports.$inferSelect;
export type InsertResidualImport = z.infer<typeof insertResidualImportSchema>;

export const residualImportRows = pgTable("residual_import_rows", {
  id: serial("id").primaryKey(),
  importId: integer("import_id").notNull().references(() => residualImports.id, { onDelete: "cascade" }),
  mid: text("mid").notNull(),
  merchantName: text("merchant_name"),
  volume: text("volume").default("0"),
  grossResidual: text("gross_residual").default("0"),
  netResidual: text("net_residual").default("0"),
  expectedResidual: text("expected_residual").default("0"),
  variance: text("variance").default("0"),
  variancePct: text("variance_pct").default("0"),
  varianceStatus: text("variance_status").default("in_range"),
  isMatched: boolean("is_matched").default(false),
  matchedDealId: integer("matched_deal_id").references(() => deals.id),
  matchedProfileId: integer("matched_profile_id"),
  agentId: integer("agent_id").references(() => agents.id),
  agentName: text("agent_name"),
  transactions: integer("transactions"),
  processingCost: text("processing_cost"),
  rawData: jsonb("raw_data"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("residual_import_rows_import_id_idx").on(table.importId),
  index("residual_import_rows_mid_idx").on(table.mid),
]);

export const insertResidualImportRowSchema = createInsertSchema(residualImportRows).omit({
  id: true,
  createdAt: true,
});

export type ResidualImportRow = typeof residualImportRows.$inferSelect;
export type InsertResidualImportRow = z.infer<typeof insertResidualImportRowSchema>;

export const healthAlerts = pgTable("health_alerts", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id),
  contactId: integer("contact_id").references(() => contacts.id),
  alertType: text("alert_type").notNull(),
  severity: text("severity").default("warning"),
  title: text("title").notNull(),
  description: text("description"),
  metric: text("metric"),
  currentValue: text("current_value"),
  previousValue: text("previous_value"),
  threshold: text("threshold"),
  status: text("status").default("active"),
  acknowledgedAt: timestamp("acknowledged_at"),
  acknowledgedBy: text("acknowledged_by"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertHealthAlertSchema = createInsertSchema(healthAlerts).omit({
  id: true,
  createdAt: true,
});

export type HealthAlert = typeof healthAlerts.$inferSelect;
export type InsertHealthAlert = z.infer<typeof insertHealthAlertSchema>;

export const HEALTH_ALERT_TYPES = [
  "volume_decline",
  "chargeback_spike",
  "no_processing",
  "high_refund_rate",
  "compliance_issue",
  "terminal_offline",
  "funding_hold",
] as const;

export const ALERT_SEVERITIES = [
  "info",
  "warning",
  "critical",
  "urgent",
] as const;

export const BOARDING_STATUSES = [
  "not_submitted",
  "submitted",
  "under_review",
  "approved",
  "declined",
  "more_info_needed",
] as const;

export const midDailyStats = pgTable("mid_daily_stats", {
  id: serial("id").primaryKey(),
  mid: text("mid").notNull(),
  dealId: integer("deal_id").references(() => deals.id),
  contactId: integer("contact_id").references(() => contacts.id),
  date: text("date").notNull(),
  volume: real("volume").notNull(),
  /** Nullable — absent when provider does not supply count for this record. Never zero-filled. */
  txCount: integer("tx_count"),
  /** Nullable — derived from txCount; absent when txCount is absent. Never zero-filled. */
  avgTicket: real("avg_ticket"),
  /** Nullable — derived from fee/gross; absent when fee is not supplied. Never zero-filled. */
  effectiveRate: real("effective_rate"),
  /** Nullable — absent when provider does not supply chargeback data. Never zero-filled. */
  chargebackCount: integer("chargeback_count"),
  /** Nullable — absent when provider does not supply chargeback amount. Never zero-filled. */
  chargebackAmount: real("chargeback_amount"),
  /** Nullable — absent when provider does not supply refund count. Never zero-filled. */
  refundCount: integer("refund_count"),
  fetchedAt: timestamp("fetched_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("mid_daily_stats_mid_idx").on(table.mid),
  index("mid_daily_stats_date_idx").on(table.date),
  index("mid_daily_stats_deal_id_idx").on(table.dealId),
  uniqueIndex("mid_daily_stats_mid_date_unique").on(table.mid, table.date),
]);

export const insertMidDailyStatSchema = createInsertSchema(midDailyStats).omit({
  id: true,
  createdAt: true,
});

export type MidDailyStat = typeof midDailyStats.$inferSelect;
export type InsertMidDailyStat = z.infer<typeof insertMidDailyStatSchema>;

export const dealCompetitors = pgTable("deal_competitors", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id),
  competitorName: text("competitor_name").notNull(),
  competitorRate: text("competitor_rate"),
  competitorProgram: text("competitor_program"),
  result: text("result"),
  lossReason: text("loss_reason"),
  winFactor: text("win_factor"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertDealCompetitorSchema = createInsertSchema(dealCompetitors).omit({
  id: true,
  createdAt: true,
});

export type DealCompetitor = typeof dealCompetitors.$inferSelect;
export type InsertDealCompetitor = z.infer<typeof insertDealCompetitorSchema>;

export const WIN_LOSS_REASONS = [
  "Better Rate",
  "Better Service",
  "Equipment Offer",
  "Relationship",
  "Contract Terms",
  "Speed of Setup",
  "Technology/Integration",
  "Competitor Retention Offer",
  "No Decision",
  "Went with Bank",
  "Price Too High",
  "Other",
] as const;

export const partners = pgTable("partners", {
  id: serial("id").primaryKey(),
  companyName: text("company_name").notNull(),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  passwordHash: text("password_hash"),
  passwordResetToken: text("password_reset_token"),
  passwordResetExpiresAt: timestamp("password_reset_expires_at"),
  inviteToken: text("invite_token"),
  inviteTokenExpiresAt: timestamp("invite_token_expires_at"),
  partnerType: text("partner_type").default("referral"),
  affiliateCode: text("affiliate_code").unique(),
  commissionPercent: integer("commission_percent").default(10),
  status: text("status").default("pending"),
  totalReferrals: integer("total_referrals").default(0),
  totalConversions: integer("total_conversions").default(0),
  totalPayouts: text("total_payouts").default("0"),
  totalClicks: integer("total_clicks").default(0),
  agreementDate: timestamp("agreement_date"),
  paypalEmail: text("paypal_email"),
  website: text("website"),
  howHeard: text("how_heard"),
  notes: text("notes"),
  // Enhanced partner tracking (added in migration 0087)
  referralOwner: text("referral_owner"),
  commissionStatus: text("commission_status").default("pending"),
  lastContactAt: timestamp("last_contact_at"),
  partnerCategory: text("partner_category").default("referral"),
  referredCount: integer("referred_count").default(0),
  pipelineValue: text("pipeline_value").default("0"),
  nextFollowupTaskId: integer("next_followup_task_id"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const commissionTiers = pgTable("commission_tiers", {
  id: serial("id").primaryKey(),
  minReferrals: integer("min_referrals").notNull().default(1),
  maxReferrals: integer("max_referrals"),
  commissionAmount: text("commission_amount").notNull().default("100"),
  label: text("label"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCommissionTierSchema = createInsertSchema(commissionTiers).omit({
  id: true,
  createdAt: true,
});

export type CommissionTier = typeof commissionTiers.$inferSelect;
export type InsertCommissionTier = z.infer<typeof insertCommissionTierSchema>;

export const insertPartnerSchema = createInsertSchema(partners).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Partner = typeof partners.$inferSelect;
export type InsertPartner = z.infer<typeof insertPartnerSchema>;

export const referrals = pgTable("referrals", {
  id: serial("id").primaryKey(),
  partnerId: integer("partner_id").references(() => partners.id),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  referredName: text("referred_name"),
  referredEmail: text("referred_email"),
  referredPhone: text("referred_phone"),
  referredCompany: text("referred_company"),
  status: text("status").default("pending"),
  incentiveType: text("incentive_type").default("commission"),
  incentiveAmount: text("incentive_amount"),
  commissionAmount: text("commission_amount"),
  paidAt: timestamp("paid_at"),
  convertedAt: timestamp("converted_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertReferralSchema = createInsertSchema(referrals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Referral = typeof referrals.$inferSelect;
export type InsertReferral = z.infer<typeof insertReferralSchema>;

export const PARTNER_TYPES = [
  "referral",
  "affiliate",
  "iso_agent",
  "bank_partner",
  "technology",
  "association",
  "strategic",
] as const;

export const REFERRAL_STATUSES = [
  "pending",
  "contacted",
  "qualified",
  "converted",
  "lost",
  "paid",
] as const;

export const knowledgeBase = pgTable("knowledge_base", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tags: text("tags").array(),
  sortOrder: integer("sort_order").default(0),
  isPublished: boolean("is_published").default(true),
  viewCount: integer("view_count").default(0),
  helpfulCount: integer("helpful_count").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertKnowledgeBaseSchema = createInsertSchema(knowledgeBase).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type KnowledgeBaseArticle = typeof knowledgeBase.$inferSelect;
export type InsertKnowledgeBaseArticle = z.infer<typeof insertKnowledgeBaseSchema>;

export const KB_CATEGORIES = [
  "Getting Started",
  "Terminals & Equipment",
  "Processing & Transactions",
  "Chargebacks & Disputes",
  "Statements & Billing",
  "PCI Compliance",
  "Account Management",
  "Troubleshooting",
  "Sales Scripts",
] as const;

export const reviewRequests = pgTable("review_requests", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id),
  contactId: integer("contact_id").references(() => contacts.id),
  channel: text("channel").default("email"),
  status: text("status").default("pending"),
  sentAt: timestamp("sent_at"),
  respondedAt: timestamp("responded_at"),
  rating: integer("rating"),
  reviewText: text("review_text"),
  platform: text("platform"),
  reviewUrl: text("review_url"),
  googleClickedAt: timestamp("google_clicked_at"),
  trustpilotClickedAt: timestamp("trustpilot_clicked_at"),
  npsResponseId: integer("nps_response_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertReviewRequestSchema = createInsertSchema(reviewRequests).omit({
  id: true,
  createdAt: true,
});

export type ReviewRequest = typeof reviewRequests.$inferSelect;
export type InsertReviewRequest = z.infer<typeof insertReviewRequestSchema>;

export const REVIEW_PLATFORMS = [
  "Google",
  "Yelp",
  "BBB",
  "Trustpilot",
  "Internal",
] as const;

export const onboardingSteps = pgTable("onboarding_steps", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id),
  applicationId: integer("application_id").references(() => merchantApplications.id),
  stepName: text("step_name").notNull(),
  stepOrder: integer("step_order").notNull(),
  status: text("status").default("pending"),
  completedAt: timestamp("completed_at"),
  completedBy: text("completed_by"),
  notes: text("notes"),
  dueDate: timestamp("due_date"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertOnboardingStepSchema = createInsertSchema(onboardingSteps).omit({
  id: true,
  createdAt: true,
});

export type OnboardingStep = typeof onboardingSteps.$inferSelect;
export type InsertOnboardingStep = z.infer<typeof insertOnboardingStepSchema>;

export const ONBOARDING_STEP_NAMES = [
  "Application Submitted",
  "Documents Uploaded",
  "Underwriting Review",
  "Approved",
  "Agreement Signed",
  "Equipment Ordered",
  "Equipment Shipped",
  "Equipment Delivered",
  "Terminal Programmed",
  "First Batch Processed",
  "Go-Live Complete",
] as const;

export const consentSubjects = pgTable("consent_subjects", {
  id: serial("id").primaryKey(),
  subjectType: text("subject_type").notNull(),
  subjectRecordId: integer("subject_record_id").notNull(),
  canonicalKey: text("canonical_key").notNull(),
  normalizedEmail: text("normalized_email"),
  normalizedPhone: text("normalized_phone"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("consent_subjects_type_record_uidx").on(table.subjectType, table.subjectRecordId),
  index("consent_subjects_email_idx").on(table.normalizedEmail),
  index("consent_subjects_phone_idx").on(table.normalizedPhone),
]);

export const consentSubjectChannelStates = pgTable("consent_subject_channel_states", {
  id: serial("id").primaryKey(),
  subjectId: integer("subject_id").notNull().references(() => consentSubjects.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  purpose: text("purpose").notNull(),
  permissionState: text("permission_state").notNull().default("unknown"),
  restrictionReason: text("restriction_reason"),
  sourceEventId: integer("source_event_id"),
  effectiveAt: timestamp("effective_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  evidence: jsonb("evidence"),
}, (table) => [
  uniqueIndex("consent_subject_channel_purpose_uidx").on(table.subjectId, table.channel, table.purpose),
  index("consent_subject_channel_state_subject_idx").on(table.subjectId),
]);

export const consentSubjectGlobalSuppressions = pgTable("consent_subject_global_suppressions", {
  subjectId: integer("subject_id").primaryKey().references(() => consentSubjects.id, { onDelete: "cascade" }),
  isSuppressed: boolean("is_suppressed").notNull().default(false),
  restrictionReason: text("restriction_reason"),
  sourceEventId: integer("source_event_id"),
  effectiveAt: timestamp("effective_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const consentSubjectReachability = pgTable("consent_subject_reachability", {
  id: serial("id").primaryKey(),
  subjectId: integer("subject_id").notNull().references(() => consentSubjects.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  reachabilityState: text("reachability_state").notNull(),
  sourceEventId: integer("source_event_id"),
  observedAt: timestamp("observed_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  details: jsonb("details"),
}, (table) => [
  uniqueIndex("consent_subject_reachability_uidx").on(table.subjectId, table.channel),
]);

export const consentAuditLogs = pgTable("consent_audit_logs", {
  id: serial("id").primaryKey(),
  // Legacy rows may not resolve to a canonical subject. Only canonical_fact
  // rows are consumed by the reducer; legacy_trace rows remain historical.
  subjectId: integer("subject_id").references(() => consentSubjects.id),
  contactId: integer("contact_id").references(() => contacts.id),
  userId: text("user_id"),
  channel: text("channel").notNull(),
  action: text("action").notNull(),
  consented: boolean("consented").notNull(),
  consentType: text("consent_type").default("general_optin"),
  source: text("source"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  details: jsonb("details"),
  disclosureVersion: text("disclosure_version"),
  disclosureText: text("disclosure_text"),
  formId: text("form_id"),
  consentedPhone: text("consented_phone"),
  recordKind: text("record_kind").notNull().default("legacy_trace"),
  schemaVersion: integer("schema_version").notNull().default(1),
  eventNamespace: text("event_namespace"),
  eventKey: text("event_key"),
  purpose: text("purpose"),
  receiptAt: timestamp("receipt_at"),
  effectiveAt: timestamp("effective_at"),
  evidence: jsonb("evidence"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  uniqueIndex("consent_audit_canonical_event_uidx")
    .on(table.eventNamespace, table.eventKey)
    .where(sql`record_kind = 'canonical_fact' AND event_namespace IS NOT NULL AND event_key IS NOT NULL`),
  uniqueIndex("consent_audit_reachability_event_uidx")
    .on(table.eventNamespace, table.eventKey)
    .where(sql`record_kind = 'reachability_fact' AND event_namespace IS NOT NULL AND event_key IS NOT NULL`),
  index("consent_audit_subject_idx").on(table.subjectId, table.createdAt),
]);

export const insertConsentAuditLogSchema = createInsertSchema(consentAuditLogs).omit({
  id: true,
  createdAt: true,
});

export type ConsentAuditLog = typeof consentAuditLogs.$inferSelect;
export type InsertConsentAuditLog = z.infer<typeof insertConsentAuditLogSchema>;

// Task #695 — Voice/SMS/Ringless Go-Live Audit (Approval Gate, not activation).
// Append-only audit trail for channel approval-gate actions. This table is
// never used to enable/disable a channel — SMS_ENABLED, VOICE_AI_ENABLED, and
// RINGLESS_VM_ENABLED remain Replit Secrets requiring manual operator action.
// Canonical channel keys: "sms" | "voice_ai" | "ringless_vm" — never "voice",
// "ringless", or bare "call".
export const channelAuditLog = pgTable("channel_audit_log", {
  id: serial("id").primaryKey(),
  channel: text("channel").notNull(),
  action: text("action").notNull(), // checklist_viewed | enable_approved | disabled_recorded | test_batch_preview
  checklistSnapshot: jsonb("checklist_snapshot"),
  actorUserId: text("actor_user_id"),
  actorEmail: text("actor_email"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertChannelAuditLogSchema = createInsertSchema(channelAuditLog).omit({
  id: true,
  createdAt: true,
});

export type ChannelAuditLog = typeof channelAuditLog.$inferSelect;
export type InsertChannelAuditLog = z.infer<typeof insertChannelAuditLogSchema>;

export const calendarEvents = pgTable("calendar_events", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  allDay: boolean("all_day").default(false),
  type: text("type").default("meeting"),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  ownerId: text("owner_id"),
  location: text("location"),
  ghlEventId: text("ghl_event_id"),
  status: text("status").default("scheduled"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCalendarEventSchema = createInsertSchema(calendarEvents).omit({
  id: true,
  createdAt: true,
});

export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type InsertCalendarEvent = z.infer<typeof insertCalendarEventSchema>;

export const agentQuotas = pgTable("agent_quotas", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").references(() => agents.id),
  period: text("period").notNull(),
  periodStart: timestamp("period_start").notNull(),
  periodEnd: timestamp("period_end").notNull(),
  targetDeals: integer("target_deals").default(0),
  targetRevenue: text("target_revenue").default("0"),
  targetVolume: text("target_volume").default("0"),
  actualDeals: integer("actual_deals").default(0),
  actualRevenue: text("actual_revenue").default("0"),
  actualVolume: text("actual_volume").default("0"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertAgentQuotaSchema = createInsertSchema(agentQuotas).omit({
  id: true,
  createdAt: true,
});

export type AgentQuota = typeof agentQuotas.$inferSelect;
export type InsertAgentQuota = z.infer<typeof insertAgentQuotaSchema>;

export const dataDeleteRequests = pgTable("data_delete_requests", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  fullName: text("full_name").notNull(),
  requestType: text("request_type").notNull(),
  description: text("description"),
  status: text("status").default("pending"),
  processedBy: text("processed_by"),
  processedAt: timestamp("processed_at"),
  version:integer("version").notNull().default(1),
  subjectContactId:integer("subject_contact_id").references(()=>contacts.id),
  reviewEvidence:text("review_evidence"),
  retentionReason:text("retention_reason"),
  executionState:text("execution_state").notNull().default("not_executed"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertDataDeleteRequestSchema = createInsertSchema(dataDeleteRequests).omit({
  id: true,
  status:true,processedBy:true,processedAt:true,version:true,subjectContactId:true,
  reviewEvidence:true,retentionReason:true,executionState:true,
  createdAt: true,
});

export type DataDeleteRequest = typeof dataDeleteRequests.$inferSelect;
export type InsertDataDeleteRequest = z.infer<typeof insertDataDeleteRequestSchema>;

export const comments = pgTable("comments", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  parentId: integer("parent_id"),
  content: text("content").notNull(),
  authorId: text("author_id"),
  authorName: text("author_name"),
  mentions: jsonb("mentions"),
  pinned: boolean("pinned").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertCommentSchema = createInsertSchema(comments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Comment = typeof comments.$inferSelect;
export type InsertComment = z.infer<typeof insertCommentSchema>;

export const ticketComments = pgTable("ticket_comments", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").references(() => tickets.id),
  content: text("content").notNull(),
  authorId: text("author_id"),
  authorName: text("author_name"),
  isInternal: boolean("is_internal").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertTicketCommentSchema = createInsertSchema(ticketComments).omit({
  id: true,
  createdAt: true,
});

export type TicketComment = typeof ticketComments.$inferSelect;
export type InsertTicketComment = z.infer<typeof insertTicketCommentSchema>;

export const contactCompanies = pgTable("contact_companies", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id),
  companyId: integer("company_id").references(() => companies.id),
  role: text("role").default("Owner"),
  isPrimary: boolean("is_primary").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertContactCompanySchema = createInsertSchema(contactCompanies).omit({
  id: true,
  createdAt: true,
});

export type ContactCompany = typeof contactCompanies.$inferSelect;
export type InsertContactCompany = z.infer<typeof insertContactCompanySchema>;

export const pipelineStages = pgTable("pipeline_stages", {
  id: serial("id").primaryKey(),
  pipeline: text("pipeline").notNull(),
  stageName: text("stage_name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  color: text("color").default("#6366f1"),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPipelineStageSchema = createInsertSchema(pipelineStages).omit({
  id: true,
  createdAt: true,
});

export type PipelineStage = typeof pipelineStages.$inferSelect;
export type InsertPipelineStage = z.infer<typeof insertPipelineStageSchema>;

export const notificationPreferences = pgTable("notification_preferences", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  eventType: text("event_type").notNull(),
  enabled: boolean("enabled").default(true),
  emailEnabled: boolean("email_enabled").default(false),
  digestDaily: boolean("digest_daily").default(true),
  digestWeekly: boolean("digest_weekly").default(true),
});

export const insertNotificationPreferenceSchema = createInsertSchema(notificationPreferences).omit({
  id: true,
});

export type NotificationPreference = typeof notificationPreferences.$inferSelect;
export type InsertNotificationPreference = z.infer<typeof insertNotificationPreferenceSchema>;

export const savedFilters = pgTable("saved_filters", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull(),
  filters: jsonb("filters").notNull(),
  isDefault: boolean("is_default").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSavedFilterSchema = createInsertSchema(savedFilters).omit({
  id: true,
  createdAt: true,
});

export type SavedFilter = typeof savedFilters.$inferSelect;
export type InsertSavedFilter = z.infer<typeof insertSavedFilterSchema>;

export const NOTIFICATION_EVENT_TYPES = [
  "deal_created",
  "deal_stage_changed",
  "deal_closed_won",
  "ticket_created",
  "ticket_updated",
  "task_assigned",
  "task_due_soon",
  "sla_breach",
  "contact_created",
  "hot_lead",
  "sequence_completed",
  "mention",
  "comment_reply",
  "daily_digest",
  "weekly_digest",
  "channel_approved",
] as const;

export const CONTACT_COMPANY_ROLES = [
  "Owner",
  "Manager",
  "Authorized Signer",
  "Bookkeeper",
  "Other",
] as const;

export const csvImports = pgTable("csv_imports", {
  id: serial("id").primaryKey(),
  /** Durable one-to-one projection of the replay-safe import execution. */
  executionId: uuid("execution_id").references(() => importExecutions.id, { onDelete: "set null" }).unique(),
  fileName: text("file_name").notNull(),
  sourceFormat: text("source_format").default("custom"),
  totalRows: integer("total_rows").default(0),
  newRecords: integer("new_records").default(0),
  duplicatesSkipped: integer("duplicates_skipped").default(0),
  updatedRecords: integer("updated_records").default(0),
  invalidRows: integer("invalid_rows").default(0),
  skippedRows: integer("skipped_rows").default(0),
  errorsCount: integer("errors_count").default(0),
  verticalBreakdown: jsonb("vertical_breakdown"),
  importSource: text("import_source"),
  status: text("status").default("processing"),
  importedBy: text("imported_by"),
  dealsCreated: integer("deals_created").default(0),
  hotLeads: integer("hot_leads").default(0),
  warmLeads: integer("warm_leads").default(0),
  coldLeads: integer("cold_leads").default(0),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  processedRows: integer("processed_rows"),
  lastProgressAt: timestamp("last_progress_at"),
  staleReason: text("stale_reason"),
  optOutPreserved: integer("opt_out_preserved").default(0),
  optOutApplied: integer("opt_out_applied").default(0),
});

export const insertCsvImportSchema = createInsertSchema(csvImports).omit({
  id: true,
  createdAt: true,
});

export type CsvImport = typeof csvImports.$inferSelect;
export type InsertCsvImport = z.infer<typeof insertCsvImportSchema>;

export const generatedBlogPosts = pgTable("generated_blog_posts", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  excerpt: text("excerpt").notNull(),
  category: text("category").notNull(),
  author: text("author").notNull().default("Liberty Bancard Team"),
  authorId: integer("author_id"),
  readTime: text("read_time").notNull(),
  publishDate: text("publish_date").notNull(),
  publishedISO: text("published_iso").notNull(),
  modifiedISO: text("modified_iso").notNull(),
  keywords: text("keywords").notNull(),
  metaDescription: text("meta_description").notNull(),
  content: jsonb("content").notNull(),
  faqs: jsonb("faqs"),
  status: text("status").notNull().default("draft"),
  scheduledAt: timestamp("scheduled_at"),
  publishedAt: timestamp("published_at"),
  createdAt: timestamp("created_at").defaultNow(),
  createdBy: integer("created_by"),
  pillar: text("pillar"),
  cluster: text("cluster"),
  seoTitle: text("seo_title"),
  ogImage: text("og_image"),
  internalLinks: jsonb("internal_links"),
  reviewerNotes: text("reviewer_notes"),
});

export const insertGeneratedBlogPostSchema = createInsertSchema(generatedBlogPosts).omit({
  id: true,
  createdAt: true,
});

export type GeneratedBlogPost = typeof generatedBlogPosts.$inferSelect;
export type InsertGeneratedBlogPost = z.infer<typeof insertGeneratedBlogPostSchema>;

export const contentAuthors = pgTable("content_authors", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  title: text("title").notNull(),
  bio: text("bio").notNull(),
  longBio: text("long_bio"),
  avatarUrl: text("avatar_url"),
  linkedinUrl: text("linkedin_url"),
  twitterUrl: text("twitter_url"),
  websiteUrl: text("website_url"),
  expertise: text("expertise").array(),
  email: text("email"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertContentAuthorSchema = createInsertSchema(contentAuthors).omit({ id: true, createdAt: true });
export type ContentAuthor = typeof contentAuthors.$inferSelect;
export type InsertContentAuthor = z.infer<typeof insertContentAuthorSchema>;

export const socialPosts = pgTable("social_posts", {
  id: serial("id").primaryKey(),
  platform: text("platform").notNull().default("linkedin"),
  body: text("body").notNull(),
  hashtags: text("hashtags").array(),
  linkUrl: text("link_url"),
  imageUrl: text("image_url"),
  authorId: integer("author_id"),
  authorName: text("author_name"),
  status: text("status").notNull().default("draft"),
  scheduledAt: timestamp("scheduled_at"),
  publishedAt: timestamp("published_at"),
  externalPostId: text("external_post_id"),
  externalPostUrl: text("external_post_url"),
  pillar: text("pillar"),
  cluster: text("cluster"),
  reviewerNotes: text("reviewer_notes"),
  createdAt: timestamp("created_at").defaultNow(),
  createdBy: integer("created_by"),
});

export const insertSocialPostSchema = createInsertSchema(socialPosts).omit({ id: true, createdAt: true });
export type SocialPost = typeof socialPosts.$inferSelect;
export type InsertSocialPost = z.infer<typeof insertSocialPostSchema>;

export const SDR_PIPELINE_STAGES = [
  "DISCOVERED", "ENRICHING", "ENRICHED", "DEDUPED", "CLASSIFIED", "QUALIFIED",
  "OUTREACH_EMAIL", "OUTREACH_SMS", "OUTREACH_CHAT", "OUTREACH_CALL",
  "ENGAGED", "MEETING_SET", "STATEMENT_REQUESTED", "STATEMENT_RECEIVED",
  "ANALYSIS_READY", "PROPOSAL_SENT", "NEGOTIATION", "APPLICATION_STARTED",
  "UNDERWRITING", "CLOSED_WON", "BOARDED", "TERMINAL_SHIPPED", "NURTURE", "DEAD",
  "CONVERTED",
] as const;

export const SDR_STAGES = SDR_PIPELINE_STAGES;

export const SDR_PRIORITY_BUCKETS = ["A", "B", "C", "nurture"] as const;

export const GHL_OPPORTUNITY_STAGES = [
  "New Prospect", "Qualified", "Engaged", "Meeting Set",
  "Statement Requested", "Proposal Sent", "Won", "Lost",
] as const;

export const GHL_CUSTOM_FIELDS = [
  "lb_merchant_id", "lb_current_stage", "lb_fit_score", "lb_revenue_score",
  "lb_reachability_score", "lb_priority_score", "lb_vertical", "lb_best_channel",
  "lb_statement_status", "lb_proposal_status", "lb_last_ai_outcome", "lb_owner_type",
] as const;

export const GHL_TAGS = [
  "LB-AI-SDR", "LB-AUTO", "LB-MEDSPA", "LB-DENTAL", "LB-BOOKING-READY",
  "LB-STATEMENT-PENDING", "LB-PROPOSAL-SENT", "LB-HUMAN-HANDOFF", "LB-DO-NOT-AUTO",
] as const;

export const businesses = pgTable("businesses", {
  id: serial("id").primaryKey(),
  canonicalName: text("canonical_name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  coverageKeys: text("coverage_keys").array().$type<Array<string | null>>().generatedAlwaysAs(sql.raw(coverageBusinessKeys())),
  websiteDomain: text("website_domain"),
  mainPhone: text("main_phone"),
  mainEmail: text("main_email"),
  streetAddress: text("street_address"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country").default("US"),
  latitude: real("latitude"),
  longitude: real("longitude"),
  industryPrimary: text("industry_primary"),
  industrySecondary: text("industry_secondary"),
  vertical: text("vertical"),
  effectiveVerticalId: text("effective_vertical_id"),
  effectiveVerticalStatus: text("effective_vertical_status"),
  subVertical: text("sub_vertical"),
  googlePlaceId: text("google_place_id"),
  facebookUrl: text("facebook_url"),
  instagramUrl: text("instagram_url"),
  yelpUrl: text("yelp_url"),
  isMultiLocation: boolean("is_multi_location").default(false),
  locationCountEstimate: integer("location_count_estimate").default(1),
  reviewCount: integer("review_count"),
  rating: real("rating"),
  status: text("status").default("new"),
  // BT-06 mutable commercial root; CRO-02 only observes it in shadow.
  recordClass: text("record_class").notNull().default("unknown"),
  lastSourceType: text("last_source_type"),
  lastEnrichedAt: timestamp("last_enriched_at"),
  doNotVisit: boolean("do_not_visit").notNull().default(false),
  // MI-05: free enrichment pipeline columns (in DB via migration 0250).
  freeEnrichmentStatus: text("free_enrichment_status"),
  freeEnrichmentAttemptCount: integer("free_enrichment_attempt_count").notNull().default(0),
  freeEnrichmentLastAttemptAt: timestamp("free_enrichment_last_attempt_at"),
  freeEnrichmentCompletedAt: timestamp("free_enrichment_completed_at"),
  freeEnrichmentLastErrorCode: text("free_enrichment_last_error_code"),
  freeEnrichmentEvidence: jsonb("free_enrichment_evidence"),
  // MI-06: email discovery pipeline columns (in DB via migration 0255).
  emailDiscoveryStatus: text("email_discovery_status"),
  emailValidationUpdatedAt: timestamp("email_validation_updated_at"),
  emailSelectedCandidateHash: text("email_selected_candidate_hash"),
  emailOutreachCatchAllApprovedAt: timestamp("email_outreach_catch_all_approved_at"),
  emailOutreachApprovedBy: text("email_outreach_approved_by"),
  emailOutreachApprovedCandidateHash: text("email_outreach_approved_candidate_hash"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("businesses_normalized_name_city_state_idx").on(table.normalizedName, table.city, table.state),
  index("businesses_coverage_name_key_idx").on(sql`(${table.coverageKeys}[1])`),
  index("businesses_coverage_normalized_name_key_idx").on(sql`(${table.coverageKeys}[2])`),
  index("businesses_coverage_domain_key_idx").on(sql`(${table.coverageKeys}[3])`),
  index("businesses_coverage_count_domain_key_idx").on(sql`(${table.coverageKeys}[4])`).where(sql`record_class='canonical'`),
  index("businesses_coverage_phone_key_idx").on(sql`(${table.coverageKeys}[5])`),
  index("businesses_coverage_address_key_idx").on(sql`(${table.coverageKeys}[6])`),
  index("businesses_coverage_street_key_idx").on(sql`(${table.coverageKeys}[7])`),
  index("businesses_website_domain_idx").on(table.websiteDomain),
  index("businesses_main_phone_idx").on(table.mainPhone),
  index("businesses_google_place_id_idx").on(table.googlePlaceId),
  index("canonical_link_business_name_lookup_idx").on(sql`crm_identity_name(${table.canonicalName})`)
    .where(sql`record_class='canonical'`),
  index("canonical_link_business_domain_lookup_idx").on(sql`crm_identity_domain(${table.websiteDomain})`)
    .where(sql`record_class='canonical'`),
  // Matches migration 0240. Declared here (not just in the migration file)
  // so Publish's schema diff can actually apply it to production — Publish
  // diffs shared/schema.ts against live production, it does not execute
  // migrations/*.sql directly.
  check("businesses_record_class_check", sql`record_class IN ('production', 'test', 'demo', 'synthetic', 'unknown', 'canonical')`),
]);

export const insertBusinessSchema = createInsertSchema(businesses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type Business = typeof businesses.$inferSelect;
export type InsertBusiness = z.infer<typeof insertBusinessSchema>;
export type UpdateBusinessRequest = Partial<InsertBusiness>;

// ── MI-06: cro03c_email_winner_selections ─────────────────────────────────────
// Immutable winner record: one row per (business_id, generation_id).
// Superseded by newer generation — state updated to 'superseded', never deleted.
export const cro03cEmailWinnerSelections = pgTable("cro03c_email_winner_selections", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: integer("business_id").references(() => businesses.id).notNull(),
  generationId: uuid("generation_id").notNull(),
  candidateEvidenceId: uuid("candidate_evidence_id").notNull(),
  policyVersion: integer("policy_version").notNull().default(1),
  source: text("source").notNull(),
  subjectType: text("subject_type").notNull(),
  confidence: integer("confidence").notNull(),
  normalizedValueHash: text("normalized_value_hash").notNull(),
  state: text("state").notNull().default("selected"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type Cro03cEmailWinnerSelection = typeof cro03cEmailWinnerSelections.$inferSelect;

// ── MI-06: business_validation_intents ────────────────────────────────────────
// Tracks ZeroBounce validation requests for business email candidates.
// approval_required=TRUE: medium-confidence; operator must approve before claim.
export const businessValidationIntents = pgTable("business_validation_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: integer("business_id").references(() => businesses.id).notNull(),
  winnerSelectionId: uuid("winner_selection_id").notNull(),
  candidateEvidenceId: uuid("candidate_evidence_id").notNull(),
  normalizedEmailTokenHash: text("normalized_email_token_hash").notNull(),
  purpose: text("purpose").notNull().default("cro03c_business_email"),
  state: text("state").notNull().default("pending"),
  approvalRequired: boolean("approval_required").notNull().default(false),
  disposition: text("disposition"),
  apolloMatchConfidence: text("apollo_match_confidence"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at").defaultNow(),
  terminalCode: text("terminal_code"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export type BusinessValidationIntent = typeof businessValidationIntents.$inferSelect;

// ── MI-06: cro03c_business_validation_authorizations ─────────────────────────
// Idempotency/audit for the business validation authorization path.
// Parallel to cro03c_validation_authorizations (contact path).
export const cro03cBusinessValidationAuthorizations = pgTable("cro03c_business_validation_authorizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessValidationIntentId: uuid("business_validation_intent_id").notNull(),
  commandId: uuid("command_id").notNull(),
  runId: uuid("run_id").notNull(),
  generationId: uuid("generation_id").notNull(),
  winnerSelectionId: uuid("winner_selection_id").notNull(),
  activationRevision: integer("activation_revision").notNull(),
  businessId: integer("business_id").notNull(),
  normalizedEmailHash: text("normalized_email_hash").notNull(),
  runtimeAttestationId: uuid("runtime_attestation_id").notNull(),
  expectedProviderControlRevision: integer("expected_provider_control_revision").notNull(),
  unitCap: integer("unit_cap").notNull(),
  costCapMicros: bigint("cost_cap_micros", { mode: "number" }).notNull(),
  authorizedAt: timestamp("authorized_at").defaultNow(),
});

export type Cro03cBusinessValidationAuthorization = typeof cro03cBusinessValidationAuthorizations.$inferSelect;

export const businessAliases = pgTable("business_aliases", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").references(() => businesses.id).notNull(),
  aliasName: text("alias_name").notNull(),
  aliasType: text("alias_type").default("imported"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertBusinessAliasSchema = createInsertSchema(businessAliases).omit({
  id: true,
  createdAt: true,
});

export type BusinessAlias = typeof businessAliases.$inferSelect;
export type InsertBusinessAlias = z.infer<typeof insertBusinessAliasSchema>;

export const businessLocations = pgTable("business_locations", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").references(() => businesses.id).notNull(),
  locationName: text("location_name"),
  streetAddress: text("street_address"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  phone: text("phone"),
  email: text("email"),
  websiteUrl: text("website_url"),
  googlePlaceId: text("google_place_id"),
  rating: real("rating"),
  reviewCount: integer("review_count"),
  isPrimary: boolean("is_primary").default(false),
  countyFips: text("county_fips"),
  licenseSourceKey: text("license_source_key"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertBusinessLocationSchema = createInsertSchema(businessLocations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type BusinessLocation = typeof businessLocations.$inferSelect;
export type InsertBusinessLocation = z.infer<typeof insertBusinessLocationSchema>;

// ── MI-03: canonical_source_links ─────────────────────────────────────────────
// Governed source identifier store linking a businesses row to its authoritative
// source identifiers per registry namespace. Cross-registry comparisons are prohibited.
export const canonicalSourceLinks = pgTable("canonical_source_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: integer("business_id").references(() => businesses.id).notNull(),
  sourceSystem: text("source_system").notNull(),
  sourceType: text("source_type").notNull(),
  stableKey: text("stable_key").notNull(),
  registryId: text("registry_id"),
  rawEvidence: jsonb("raw_evidence"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("canonical_source_links_namespace_key_unique").on(table.sourceSystem, table.sourceType, table.stableKey),
  index("canonical_source_links_business_id_idx").on(table.businessId),
  index("canonical_source_links_last_confirmed_at_idx").on(table.lastConfirmedAt),
]);

export type CanonicalSourceLink = typeof canonicalSourceLinks.$inferSelect;
export type InsertCanonicalSourceLink = typeof canonicalSourceLinks.$inferInsert;

// ── #1956 Step 2: Sunbiz→canonical-business bootstrap idempotency claims ──────
// A durable claim keyed on the stable Sunbiz source identity (filing_number).
// Exactly one claim row can ever exist per filing_number (DB-enforced unique
// index), so retried/resumed bootstrap batches can never double-materialize a
// business for the same Sunbiz entity even if name/domain/phone evidence would
// have missed the collision. The claim is inserted BEFORE any organization
// resolution/creation is attempted, and updated afterward with the outcome.
export const sunbizBootstrapClaims = pgTable("sunbiz_bootstrap_claims", {
  id: serial("id").primaryKey(),
  filingNumber: text("filing_number").notNull(),
  sunbizEntityId: integer("sunbiz_entity_id").references(() => sunbizEntities.id),
  status: text("status").notNull().default("claimed"), // claimed | created | matched_existing | deferred_collision | failed | dead_letter
  businessId: integer("business_id").references(() => businesses.id),
  deferredReasonCode: text("deferred_reason_code"),
  // Task #2002 full-backfill: count of 'failed' resolutions for this filing.
  // Once it reaches SUNBIZ_BACKFILL_MAX_RETRIES the claim is moved to the
  // terminal 'dead_letter' status instead of staying retryable 'failed'.
  retryCount: integer("retry_count").notNull().default(0),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("sunbiz_bootstrap_claims_filing_number_unique").on(table.filingNumber),
  index("sunbiz_bootstrap_claims_status_idx").on(table.status),
]);

export type SunbizBootstrapClaim = typeof sunbizBootstrapClaims.$inferSelect;
export type InsertSunbizBootstrapClaim = typeof sunbizBootstrapClaims.$inferInsert;

// ── Task 2002: append-only ledger of per-attempt bootstrap outcomes ───────────
// Best-effort write after each filing_number's outcome is determined in a
// runSunbizBootstrapBatch call. Never authoritative for state (sunbiz_bootstrap_claims
// remains that); this is history/audit only. Carries no raw PII fields.
export const sunbizBootstrapLedgerEvents = pgTable("sunbiz_bootstrap_ledger_events", {
  id: serial("id").primaryKey(),
  filingNumber: text("filing_number").notNull(),
  runId: text("run_id").notNull(),
  attemptNumber: integer("attempt_number").notNull().default(1),
  outcome: text("outcome").notNull(),
  deferredReasonCode: text("deferred_reason_code"),
  businessId: integer("business_id"),
  actor: text("actor").notNull().default("system"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sunbiz_bootstrap_ledger_events_filing_number_idx").on(table.filingNumber),
  index("sunbiz_bootstrap_ledger_events_run_id_idx").on(table.runId),
]);

export type SunbizBootstrapLedgerEvent = typeof sunbizBootstrapLedgerEvents.$inferSelect;
export type InsertSunbizBootstrapLedgerEvent = typeof sunbizBootstrapLedgerEvents.$inferInsert;

// ── MI-03: canonical_conflict_evidence ────────────────────────────────────────
// Append-only conflict log written by projectBusinessOnly() when resolveOrganization()
// returns AMBIGUOUS_ORGANIZATION_MATCH. Admin resolution UI belongs to MI-07.
export const canonicalConflictEvidence = pgTable("canonical_conflict_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessIdA: integer("business_id_a").references(() => businesses.id).notNull(),
  businessIdB: integer("business_id_b").references(() => businesses.id),
  conflictType: text("conflict_type").notNull(),
  field: text("field"),
  evidencePayload: jsonb("evidence_payload"),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  acknowledgedBy: text("acknowledged_by"),
}, (table) => [
  index("canonical_conflict_evidence_status_idx").on(table.status),
  index("canonical_conflict_evidence_business_a_idx").on(table.businessIdA),
  index("canonical_conflict_evidence_created_at_idx").on(table.createdAt),
]);

export type CanonicalConflictEvidence = typeof canonicalConflictEvidence.$inferSelect;
export type InsertCanonicalConflictEvidence = typeof canonicalConflictEvidence.$inferInsert;

export const leadSources = pgTable("lead_sources", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").references(() => businesses.id),
  contactId: integer("contact_id").references(() => contacts.id),
  sourceType: text("source_type").notNull(),
  sourceLabel: text("source_label"),
  sourceExternalId: text("source_external_id"),
  sourceUrl: text("source_url"),
  campaignTag: text("campaign_tag"),
  importBatchId: text("import_batch_id"),
  discoveredAt: timestamp("discovered_at").defaultNow(),
});

export const insertLeadSourceSchema = createInsertSchema(leadSources).omit({
  id: true,
});

export type LeadSource = typeof leadSources.$inferSelect;
export type InsertLeadSource = z.infer<typeof insertLeadSourceSchema>;

export const enrichmentRuns = pgTable("enrichment_runs", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").references(() => businesses.id),
  contactId: integer("contact_id").references(() => contacts.id),
  provider: text("provider").notNull(),
  jobType: text("job_type").notNull(),
  status: text("status").default("queued"),
  inputPayload: jsonb("input_payload"),
  outputPayload: jsonb("output_payload"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
});

export const insertEnrichmentRunSchema = createInsertSchema(enrichmentRuns).omit({
  id: true,
});

export type EnrichmentRun = typeof enrichmentRuns.$inferSelect;
export type InsertEnrichmentRun = z.infer<typeof insertEnrichmentRunSchema>;

export const BUSINESS_STATUSES = ["new", "active", "suppressed", "customer", "archived"] as const;
export const ALIAS_TYPES = ["imported", "directory", "manual", "enrichment"] as const;
export const LEAD_SOURCE_TYPES = ["outscraper", "apify_google", "apify_yelp", "serper", "seo", "affiliate", "chat_widget", "manual_upload", "ghl_form", "sunbiz", "csv_import"] as const;
export const ENRICHMENT_PROVIDERS = ["serper", "hunter", "apollo", "builtwith", "manual", "internal"] as const;
export const ENRICHMENT_JOB_TYPES_V2 = ["website_lookup", "email_lookup", "phone_validation", "processor_detection", "ad_detection"] as const;

export const sdrMerchants = pgTable("sdr_merchants", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").references(() => businesses.id),
  businessName: text("business_name").notNull(),
  legalName: text("legal_name"),
  website: text("website"),
  domain: text("domain"),
  mainPhone: text("main_phone"),
  mainEmail: text("main_email"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  vertical: text("vertical"),
  subvertical: text("subvertical"),
  source: text("source"),
  sourceRef: text("source_ref"),
  ghlContactId: text("ghl_contact_id"),
  ghlOpportunityId: text("ghl_opportunity_id"),
  existingCustomerFlag: boolean("existing_customer_flag").default(false),
  doNotContactFlag: boolean("do_not_contact_flag").default(false),
  ownerFirstName: text("owner_first_name"),
  ownerLastName: text("owner_last_name"),
  formationDate: date("formation_date"),
  yearsInBusiness: integer("years_in_business"),
  registrySource: text("registry_source"),
  licenseNumber: text("license_number"),
  bbbAccredited: boolean("bbb_accredited").default(false),
  sourceCount: integer("source_count").default(1),
  sourcedVia: text("sourced_via"),
  ownerEnrichmentStatus: text("owner_enrichment_status").default("pending"),
  // Vertical provenance — separate fields for coarse vertical and fine subvertical.
  // verticalSource/verticalConfidence describe the coarse `vertical` field.
  // subverticalSource/subverticalConfidence describe the `subvertical` field.
  // Resolver (991B-1) must always write coarse + fine together.
  // manualVerticalOverride: NULL=unknown, false=evaluated/not-overridden, true=confirmed operator override.
  verticalSource: text("vertical_source"),
  verticalConfidence: integer("vertical_confidence"),
  subverticalSource: text("subvertical_source"),
  subverticalConfidence: integer("subvertical_confidence"),
  manualVerticalOverride: boolean("manual_vertical_override"),
  // ── Serper zero-yield cooldown state (#1599, migration 0141) ─────────────
  // Written ONLY by serper-enrichment outcome recording + admin manual requeue.
  // Provider/control failures never touch attempts or next_eligible_at.
  lastSerperCheckedAt: timestamp("last_serper_checked_at", { withTimezone: true }),
  serperNoResultAttempts: integer("serper_no_result_attempts").notNull().default(0),
  serperNextEligibleAt: timestamp("serper_next_eligible_at", { withTimezone: true }),
  serperLastOutcome: text("serper_last_outcome"),
  serperLastReasonCode: text("serper_last_reason_code"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("sdr_merchants_ghl_contact_id_idx").on(table.ghlContactId),
  index("sdr_merchants_serper_eligibility_idx").on(table.serperNextEligibleAt, table.doNotContactFlag),
  check("sdr_merchants_vertical_confidence_range", sql`vertical_confidence IS NULL OR (vertical_confidence BETWEEN 0 AND 100)`),
  check("sdr_merchants_subvertical_confidence_range", sql`subvertical_confidence IS NULL OR (subvertical_confidence BETWEEN 0 AND 100)`),
]);

export const insertSdrMerchantSchema = createInsertSchema(sdrMerchants).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  // Vertical provenance — server-assigned; clients cannot forge vertical authority.
  verticalSource: true,
  verticalConfidence: true,
  subverticalSource: true,
  subverticalConfidence: true,
  manualVerticalOverride: true,
});

export type SdrMerchant = typeof sdrMerchants.$inferSelect;
export type InsertSdrMerchant = z.infer<typeof insertSdrMerchantSchema>;

export const registryImportLog = pgTable("registry_import_log", {
  id: serial("id").primaryKey(),
  importId: text("import_id").notNull(),
  source: text("source").notNull(),
  state: text("state").notNull(),
  rawRow: jsonb("raw_row").notNull(),
  matchedMerchantId: integer("matched_merchant_id").references(() => sdrMerchants.id),
  status: text("status").notNull().default("unmatched"),
  matchConfidence: integer("match_confidence"),
  matchBasis: jsonb("match_basis"),
  contradictions: jsonb("contradictions"),
  runnerUpMerchantId: integer("runner_up_merchant_id").references(() => sdrMerchants.id),
  runnerUpConfidence: integer("runner_up_confidence"),
  matchAlgorithmVersion: text("match_algorithm_version"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("registry_import_log_import_id_idx").on(table.importId),
  index("registry_import_log_status_idx").on(table.status),
]);

export const insertRegistryImportLogSchema = createInsertSchema(registryImportLog).omit({
  id: true,
  createdAt: true,
});

export type RegistryImportLog = typeof registryImportLog.$inferSelect;
export type InsertRegistryImportLog = z.infer<typeof insertRegistryImportLogSchema>;

export const sdrMerchantContacts = pgTable("sdr_merchant_contacts", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").references(() => sdrMerchants.id),
  contactName: text("contact_name"),
  title: text("title"),
  email: text("email"),
  mobile: text("mobile"),
  directPhone: text("direct_phone"),
  roleGuess: text("role_guess"),
  emailConfidence: integer("email_confidence").default(0),
  primaryContactFlag: boolean("primary_contact_flag").default(false),
  consentSms: boolean("consent_sms").default(false),
  consentEmail: boolean("consent_email").default(false),
  consentCall: boolean("consent_call").default(false),
  consentSource: text("consent_source"),
  consentAt: timestamp("consent_at"),
  timezone: text("timezone"),
  bestContactChannel: text("best_contact_channel"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSdrMerchantContactSchema = createInsertSchema(sdrMerchantContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SdrMerchantContact = typeof sdrMerchantContacts.$inferSelect;
export type InsertSdrMerchantContact = z.infer<typeof insertSdrMerchantContactSchema>;

export const sdrLeadState = pgTable("sdr_lead_state", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").references(() => sdrMerchants.id).notNull().unique(),
  businessId: integer("business_id").references(() => businesses.id),
  contactId: integer("contact_id").references(() => contacts.id),
  currentStage: text("current_stage").notNull().default("DISCOVERED"),
  stage: text("stage").notNull().default("DISCOVERED"),
  substage: text("substage"),
  statusReason: text("status_reason"),
  qualificationTier: text("qualification_tier"),
  companyName: text("company_name"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  vertical: text("vertical"),
  city: text("city"),
  state: text("state"),
  fitScore: integer("fit_score").default(0),
  revenueScore: integer("revenue_score").default(0),
  reachabilityScore: integer("reachability_score").default(0),
  processorScore: integer("processor_score").default(0),
  growthScore: integer("growth_score").default(0),
  priorityScore: integer("priority_score").default(0),
  priorityBucket: text("priority_bucket").default("C"),
  scoreBreakdown: jsonb("score_breakdown"),
  lastScoredAt: timestamp("last_scored_at"),
  boardingProbability: real("boarding_probability"),
  nextAction: text("next_action"),
  nextActionType: text("next_action_type"),
  nextActionPayload: jsonb("next_action_payload"),
  nextActionAt: timestamp("next_action_at"),
  assignedTo: text("assigned_to"),
  ownerType: text("owner_type").default("ai"),
  proposalId: text("proposal_id"),
  meetingId: text("meeting_id"),
  emailAttempts: integer("email_attempts").default(0),
  smsAttempts: integer("sms_attempts").default(0),
  callAttempts: integer("call_attempts").default(0),
  lastEmailAt: timestamp("last_email_at"),
  lastSmsAt: timestamp("last_sms_at"),
  lastCallAt: timestamp("last_call_at"),
  lastReplyAt: timestamp("last_reply_at"),
  lastTouchAt: timestamp("last_touch_at"),
  // Unknown is fail-closed. An address or import source is never affirmative evidence.
  consentEmail: boolean("consent_email").default(false),
  consentSms: boolean("consent_sms").default(false),
  consentCall: boolean("consent_call").default(false),
  optedOutEmail: boolean("opted_out_email").default(false),
  optedOutSms: boolean("opted_out_sms").default(false),
  ghlContactId: text("ghl_contact_id"),
  enrichmentData: jsonb("enrichment_data"),
  ownerName: text("owner_name"),
  ownerEmail: text("owner_email"),
  ownerPhone: text("owner_phone"),
  locationCount: integer("location_count").default(1),
  estimatedTicketSize: text("estimated_ticket_size"),
  estimatedVolume: text("estimated_volume"),
  serviceType: text("service_type"),
  hasBookingSystem: boolean("has_booking_system").default(false),
  hasEcommerce: boolean("has_ecommerce").default(false),
  billingHints: text("billing_hints"),
  websiteQuality: text("website_quality"),
  businessMaturity: text("business_maturity"),
  contactQuality: text("contact_quality"),
  decisionReason: text("decision_reason"),
  pausedUntil: timestamp("paused_until"),
  sourceType: text("source_type").default("import"),
  sourceId: text("source_id"),
  statementUploadToken: text("statement_upload_token"),
  statementRequestedAt: timestamp("statement_requested_at"),
  statementReminderCount: integer("statement_reminder_count").default(0),
  proposalTrackingId: text("proposal_tracking_id"),
  proposalViewedAt: timestamp("proposal_viewed_at"),
  proposalClickedAt: timestamp("proposal_clicked_at"),
  proposalResendCount: integer("proposal_resend_count").default(0),
  assignedUserId: text("assigned_user_id"),
  assignedOwnerType: text("assigned_owner_type").default("ai"),
  humanHandoffAt: timestamp("human_handoff_at"),
  humanHandoffNote: text("human_handoff_note"),
  noShowCount: integer("no_show_count").default(0),
  dealId: integer("deal_id"),
  // Vertical provenance — resolved projection from authority tables (contacts/sdrMerchants).
  // Lead state does NOT own override authority; it reflects what the resolver decided.
  // verticalResolutionReason explains which source won and why.
  verticalSource: text("vertical_source"),
  verticalConfidence: integer("vertical_confidence"),
  verticalResolutionReason: text("vertical_resolution_reason"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("sdr_lead_state_stage_idx").on(table.stage),
  index("sdr_lead_state_priority_bucket_idx").on(table.priorityBucket),
  index("sdr_lead_state_merchant_id_idx").on(table.merchantId),
  index("sdr_lead_state_contact_id_idx").on(table.contactId),
  index("sdr_lead_state_next_action_at_idx").on(table.nextActionAt),
  index("sdr_lead_state_stage_updated_at_idx").on(table.stage, table.updatedAt),
  index("sdr_lead_state_current_stage_updated_at_idx").on(table.currentStage, table.updatedAt),
  check("sdr_lead_state_vertical_confidence_range", sql`vertical_confidence IS NULL OR (vertical_confidence BETWEEN 0 AND 100)`),
]);

export const insertSdrLeadStateSchema = createInsertSchema(sdrLeadState).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  // Vertical provenance — server-assigned; clients cannot forge vertical resolution.
  verticalSource: true,
  verticalConfidence: true,
  verticalResolutionReason: true,
});

export type SdrLeadState = typeof sdrLeadState.$inferSelect;
export type InsertSdrLeadState = z.infer<typeof insertSdrLeadStateSchema>;
export type UpdateSdrLeadState = Partial<InsertSdrLeadState>;

export const sdrLeadEvents = pgTable("sdr_lead_events", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").references(() => sdrMerchants.id),
  contactId: integer("contact_id").references(() => sdrMerchantContacts.id),
  leadStateId: integer("lead_state_id").references(() => sdrLeadState.id),
  eventType: text("event_type").notNull(),
  fromStage: text("from_stage"),
  toStage: text("to_stage"),
  actionType: text("action_type"),
  channel: text("channel"),
  actorType: text("actor_type"),
  eventAt: timestamp("event_at").defaultNow(),
  payloadJson: jsonb("payload_json"),
  decisionReason: text("decision_reason"),
  metadata: jsonb("metadata"),
  modelVersion: text("model_version"),
  complianceResult: text("compliance_result"),
  ghlRefId: text("ghl_ref_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("sdr_lead_events_event_type_created_at_idx").on(table.eventType, table.createdAt),
  index("sdr_lead_events_created_at_idx").on(table.createdAt),
]);

export const insertSdrLeadEventSchema = createInsertSchema(sdrLeadEvents).omit({
  id: true,
  createdAt: true,
});

export type SdrLeadEvent = typeof sdrLeadEvents.$inferSelect;
export type InsertSdrLeadEvent = z.infer<typeof insertSdrLeadEventSchema>;

export const sdrChannelAttempts = pgTable("sdr_channel_attempts", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").references(() => sdrMerchants.id),
  leadStateId: integer("lead_state_id").references(() => sdrLeadState.id),
  channel: text("channel").notNull(),
  attemptNo: integer("attempt_no").default(1),
  attemptNumber: integer("attempt_number").notNull().default(1),
  status: text("status").default("sent"),
  templateId: text("template_id"),
  templateKey: text("template_key"),
  ghlMessageId: text("ghl_message_id"),
  subject: text("subject"),
  body: text("body"),
  error: text("error"),
  sentAt: timestamp("sent_at").defaultNow(),
  deliveredAt: timestamp("delivered_at"),
  openedAt: timestamp("opened_at"),
  clickedAt: timestamp("clicked_at"),
  repliedAt: timestamp("replied_at"),
  outcome: text("outcome"),
  cost: real("cost"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("sdr_channel_attempts_merchant_id_channel_idx").on(table.merchantId, table.channel),
]);

export const insertSdrChannelAttemptSchema = createInsertSchema(sdrChannelAttempts).omit({
  id: true,
  createdAt: true,
});

export type SdrChannelAttempt = typeof sdrChannelAttempts.$inferSelect;
export type InsertSdrChannelAttempt = z.infer<typeof insertSdrChannelAttemptSchema>;

export const sdrComplianceState = pgTable("sdr_compliance_state", {
  id: serial("id").primaryKey(),
  merchantId: integer("merchant_id").references(() => sdrMerchants.id).notNull().unique(),
  smsAllowed: boolean("sms_allowed").default(true),
  emailAllowed: boolean("email_allowed").default(true),
  callAllowed: boolean("call_allowed").default(true),
  quietHoursBlock: boolean("quiet_hours_block").default(false),
  dncBlock: boolean("dnc_block").default(false),
  complaintBlock: boolean("complaint_block").default(false),
  litigationBlock: boolean("litigation_block").default(false),
  consentSource: text("consent_source"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSdrComplianceStateSchema = createInsertSchema(sdrComplianceState).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SdrComplianceState = typeof sdrComplianceState.$inferSelect;
export type InsertSdrComplianceState = z.infer<typeof insertSdrComplianceStateSchema>;

export const WARMUP_STATUSES = ["warming", "warm", "paused", "disabled"] as const;

export const MAILBOX_TYPES = ["google_workspace", "microsoft_365", "smtp", "other"] as const;

export const sendingIdentities = pgTable("sending_identities", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  domain: text("domain").notNull(),
  emailAddress: text("email_address").notNull(),
  mailboxType: text("mailbox_type").default("google_workspace"),
  provider: text("provider"),
  ghlLocationId: text("ghl_location_id"),
  isActive: boolean("is_active").default(true),
  warmupStatus: text("warmup_status").default("warming"),
  warmupStartedAt: timestamp("warmup_started_at"),
  dailyLimit: integer("daily_limit").default(30),
  sentToday: integer("sent_today").default(0),
  bouncesToday: integer("bounces_today").default(0),
  complaintsToday: integer("complaints_today").default(0),
  healthScore: real("health_score").default(100),
  verticalAssignment: text("vertical_assignment"),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSendingIdentitySchema = createInsertSchema(sendingIdentities).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type SendingIdentity = typeof sendingIdentities.$inferSelect;
export type InsertSendingIdentity = z.infer<typeof insertSendingIdentitySchema>;

export const identityPerformanceDaily = pgTable("identity_performance_daily", {
  id: serial("id").primaryKey(),
  sendingIdentityId: integer("sending_identity_id").references(() => sendingIdentities.id).notNull(),
  date: text("date").notNull(),
  emailsSent: integer("emails_sent").default(0),
  delivered: integer("delivered").default(0),
  bounced: integer("bounced").default(0),
  opened: integer("opened").default(0),
  replied: integer("replied").default(0),
  complaints: integer("complaints").default(0),
  meetingsBooked: integer("meetings_booked").default(0),
  positiveReplies: integer("positive_replies").default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertIdentityPerformanceDailySchema = createInsertSchema(identityPerformanceDaily).omit({
  id: true,
  createdAt: true,
});

export type IdentityPerformanceDaily = typeof identityPerformanceDaily.$inferSelect;
export type InsertIdentityPerformanceDaily = z.infer<typeof insertIdentityPerformanceDailySchema>;

export const domainBusinessLog = pgTable("domain_business_log", {
  id: serial("id").primaryKey(),
  domain: text("domain").notNull(),
  businessId: integer("business_id").notNull(),
  sentAt: timestamp("sent_at").defaultNow(),
});

export const leadDiscoveryJobs = pgTable("lead_discovery_jobs", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("pending"),
  triggerType: text("trigger_type").notNull().default("manual"),
  searchVerticals: text("search_verticals").array(),
  searchMetros: text("search_metros").array(),
  dataSources: text("data_sources").array(),
  rawFound: integer("raw_found").default(0),
  newInserted: integer("new_inserted").default(0),
  duplicatesSkipped: integer("duplicates_skipped").default(0),
  errorsCount: integer("errors_count").default(0),
  enrichmentQueued: integer("enrichment_queued").default(0),
  costEstimate: real("cost_estimate").default(0),
  errorLog: text("error_log"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertLeadDiscoveryJobSchema = createInsertSchema(leadDiscoveryJobs).omit({
  id: true,
  createdAt: true,
});

export type LeadDiscoveryJob = typeof leadDiscoveryJobs.$inferSelect;
export type InsertLeadDiscoveryJob = z.infer<typeof insertLeadDiscoveryJobSchema>;

export const leadDiscoveryResults = pgTable("lead_discovery_results", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").references(() => leadDiscoveryJobs.id).notNull(),
  source: text("source").notNull(),
  vertical: text("vertical"),
  metro: text("metro"),
  businessName: text("business_name").notNull(),
  phone: text("phone"),
  email: text("email"),
  website: text("website"),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  rating: real("rating"),
  reviewCount: integer("review_count"),
  placeId: text("place_id"),
  rawData: jsonb("raw_data"),
  status: text("status").notNull().default("new"),
  merchantId: integer("merchant_id"),
  dedupReason: text("dedup_reason"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertLeadDiscoveryResultSchema = createInsertSchema(leadDiscoveryResults).omit({
  id: true,
  createdAt: true,
});

export type LeadDiscoveryResult = typeof leadDiscoveryResults.$inferSelect;
export type InsertLeadDiscoveryResult = z.infer<typeof insertLeadDiscoveryResultSchema>;

export const processorSignals = pgTable("processor_signals", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").references(() => businesses.id).notNull(),
  signalType: text("signal_type").notNull(),
  vendorName: text("vendor_name").notNull(),
  detectionMethod: text("detection_method").notNull(),
  confidenceScore: real("confidence_score").default(0),
  evidence: text("evidence"),
  detectedAt: timestamp("detected_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("processor_signals_business_id_idx").on(table.businessId),
  index("processor_signals_vendor_name_idx").on(table.vendorName),
]);

export const insertProcessorSignalSchema = createInsertSchema(processorSignals).omit({
  id: true,
  createdAt: true,
});

export type ProcessorSignal = typeof processorSignals.$inferSelect;
export type InsertProcessorSignal = z.infer<typeof insertProcessorSignalSchema>;

export type ProcessorEvidence = {
  vendor: string | null;
  confidence: number | null;
  source: "processorSignals" | "enrichmentData" | "none";
  detectedAt: string | null;
};

export const adSignals = pgTable("ad_signals", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").references(() => businesses.id).notNull(),
  platform: text("platform").notNull(),
  isRunningAds: boolean("is_running_ads").default(false),
  confidenceScore: real("confidence_score").default(0),
  adCountEstimate: integer("ad_count_estimate").default(0),
  lastSeenAt: timestamp("last_seen_at"),
  evidence: text("evidence"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("ad_signals_business_id_idx").on(table.businessId),
  index("ad_signals_platform_idx").on(table.platform),
]);

export const insertAdSignalSchema = createInsertSchema(adSignals).omit({
  id: true,
  createdAt: true,
});

export type AdSignal = typeof adSignals.$inferSelect;
export type InsertAdSignal = z.infer<typeof insertAdSignalSchema>;

export const PROCESSOR_SIGNAL_TYPES = [
  "processor",
  "pos",
  "booking_platform",
  "ecommerce_platform",
] as const;

export const DETECTION_METHODS = [
  "script",
  "html_text",
  "serper",
  "manual",
  "api",
] as const;

export const AD_PLATFORMS = [
  "facebook",
  "google",
  "instagram",
  "unknown",
] as const;

export const SWITCHABLE_PROCESSORS = [
  "Square",
  "Stripe",
  "Toast",
  "Clover",
  "PayPal",
  "Shopify",
] as const;

export const dailyFunnelMetrics = pgTable("daily_funnel_metrics", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(),
  vertical: text("vertical"),
  state: text("state"),
  sourceType: text("source_type"),
  leadsFound: integer("leads_found").default(0),
  leadsEnriched: integer("leads_enriched").default(0),
  hotCreated: integer("hot_created").default(0),
  warmCreated: integer("warm_created").default(0),
  emailsSent: integer("emails_sent").default(0),
  smsSent: integer("sms_sent").default(0),
  callsMade: integer("calls_made").default(0),
  replies: integer("replies").default(0),
  positiveReplies: integer("positive_replies").default(0),
  meetingsBooked: integer("meetings_booked").default(0),
  statementsReceived: integer("statements_received").default(0),
  proposalsSent: integer("proposals_sent").default(0),
  proposalsViewed: integer("proposals_viewed").default(0),
  appsStarted: integer("apps_started").default(0),
  appsCompleted: integer("apps_completed").default(0),
  closedWon: integer("closed_won").default(0),
  closedLost: integer("closed_lost").default(0),
  revenue: text("revenue"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("daily_funnel_metrics_date_idx").on(table.date),
  index("daily_funnel_metrics_date_vertical_idx").on(table.date, table.vertical),
]);

export const insertDailyFunnelMetricsSchema = createInsertSchema(dailyFunnelMetrics).omit({
  id: true,
  createdAt: true,
});

export type DailyFunnelMetrics = typeof dailyFunnelMetrics.$inferSelect;
export type InsertDailyFunnelMetrics = z.infer<typeof insertDailyFunnelMetricsSchema>;

export const ghlSyncStatus = pgTable("ghl_sync_status", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  lastSyncAt: timestamp("last_sync_at"),
  lastSyncDirection: text("last_sync_direction"),
  syncedCount: integer("synced_count").default(0),
  errorCount: integer("error_count").default(0),
  lastError: text("last_error"),
  localCount: integer("local_count").default(0),
  ghlCount: integer("ghl_count").default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("ghl_sync_status_entity_type_idx").on(table.entityType),
]);

export type GhlSyncStatusRecord = typeof ghlSyncStatus.$inferSelect;

export const syncConflicts = pgTable("sync_conflicts", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id).notNull(),
  fieldName: text("field_name").notNull(),
  internalValue: text("internal_value"),
  ghlValue: text("ghl_value"),
  internalUpdatedAt: timestamp("internal_updated_at"),
  ghlUpdatedAt: timestamp("ghl_updated_at"),
  resolution: text("resolution").default("pending").notNull(),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("sync_conflicts_contact_id_idx").on(table.contactId),
  index("sync_conflicts_resolution_idx").on(table.resolution),
  index("sync_conflicts_created_at_idx").on(table.createdAt),
]);

export const insertSyncConflictSchema = createInsertSchema(syncConflicts).omit({
  id: true,
  createdAt: true,
});

export type SyncConflict = typeof syncConflicts.$inferSelect;
export type InsertSyncConflict = z.infer<typeof insertSyncConflictSchema>;

export const ghlWorkflowMappings = pgTable("ghl_workflow_mappings", {
  id: serial("id").primaryKey(),
  sequenceName: text("sequence_name").notNull(),
  ghlWorkflowId: text("ghl_workflow_id"),
  category: text("category"),
  description: text("description"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("ghl_workflow_mappings_sequence_name_idx").on(table.sequenceName),
]);

export const insertGhlWorkflowMappingSchema = createInsertSchema(ghlWorkflowMappings).omit({
  id: true,
  updatedAt: true,
});

export type GhlWorkflowMapping = typeof ghlWorkflowMappings.$inferSelect;
export type InsertGhlWorkflowMapping = z.infer<typeof insertGhlWorkflowMappingSchema>;

export const chargebacks = pgTable("chargebacks", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  transactionDate: timestamp("transaction_date").notNull(),
  amount: real("amount").notNull(),
  cardBrand: text("card_brand").notNull(),
  reasonCode: text("reason_code").notNull(),
  reasonDescription: text("reason_description"),
  status: text("status").notNull().default("New"),
  responseDeadline: timestamp("response_deadline"),
  evidenceFiles: jsonb("evidence_files").$type<{ name: string; url?: string; storageKey?: string; mimeType?: string; fileSize?: number; uploadedAt: string }[]>().default([]),
  respondedAt: timestamp("responded_at"),
  outcome: text("outcome"),
  notes: text("notes"),
  aiEvidencePacket: jsonb("ai_evidence_packet").$type<{
    rebuttalletter: string;
    evidenceChecklist: { item: string; status: "included" | "missing" | "partial"; notes?: string }[];
    winLikelihood: { estimate: string; rationale: string };
    reasonCodeContext: string;
    generatedAt: string;
    finalizedAt?: string;
    editedRebuttal?: string;
    merchantProfile?: {
      merchantName: string;
      address?: string;
      city?: string;
      state?: string;
      website?: string;
      vertical?: string;
      mid?: string;
    };
    auditTrail?: {
      systemPrompt: string;
      userPrompt: string;
      rawModelOutput: string;
      model: string;
      promptTokens?: number;
      completionTokens?: number;
      generatedByUserId?: string;
      generatedByRole?: string;
    };
    finalizationTrail?: {
      finalizedByUserId?: string;
      finalizedByRole?: string;
      hadEdits: boolean;
      finalizedAt: string;
    };
  } | null>().default(null),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("chargebacks_contact_id_idx").on(table.contactId),
  index("chargebacks_deal_id_idx").on(table.dealId),
  index("chargebacks_status_idx").on(table.status),
  index("chargebacks_response_deadline_idx").on(table.responseDeadline),
  index("chargebacks_created_at_idx").on(table.createdAt),
]);

export const insertChargebackSchema = createInsertSchema(chargebacks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  aiEvidencePacket: z.custom<NonNullable<typeof chargebacks.$inferInsert.aiEvidencePacket>>().nullable().optional(),
});

export type Chargeback = typeof chargebacks.$inferSelect;
export type InsertChargeback = z.infer<typeof insertChargebackSchema>;
export type UpdateChargebackRequest = Partial<InsertChargeback>;

export const CHARGEBACK_STATUSES = ["New", "Under Review", "Responded", "Won", "Lost"] as const;
export const CHARGEBACK_CARD_BRANDS = ["Visa", "Mastercard", "Amex", "Discover"] as const;

export const CHARGEBACK_DEADLINE_DAYS: Record<string, number> = {
  Visa: 30,
  Mastercard: 45,
  Amex: 20,
  Discover: 30,
};

export const GHL_PIPELINE_STAGE_MAP: Record<string, string> = {
  "New Lead": "new_lead",
  "Statement Received": "statement_received",
  "Review In Progress": "review_in_progress",
  "Call Booked": "call_booked",
  "Proposal Sent": "proposal_sent",
  "Negotiation / Follow-Up": "negotiation",
  "Verbal Commit": "verbal_commit",
  "Nurture / Not Now": "nurture",
  "Closed Won": "won",
  "Closed Lost": "lost",
  "Contract Sent": "contract_sent",
  "Application Started": "application_started",
  "Underwriting Submitted": "underwriting_submitted",
  "Approved": "approved",
  "Terminal Ordered": "terminal_ordered",
  "Go-Live Scheduled": "go_live_scheduled",
  "Live (First Batch)": "live_first_batch",
  "Active (7 Days)": "active_7_days",
  "Active (30 Days)": "active_30_days",
};

export const GHL_PIPELINE_STAGE_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(GHL_PIPELINE_STAGE_MAP).map(([k, v]) => [v, k])
);

export const ALLOWED_SENDING_DOMAINS = [
  "libertypayments.co",
  "getlibertyprocessing.com",
  "libertybancard.com",
  "libertybancardconsulting.com",
] as const;

export const ACTIVE_DEAL_STAGES = [
  "New Lead",
  "Statement Received",
  "Review In Progress",
  "Call Booked",
  "Proposal Sent",
  "Negotiation / Follow-Up",
  "Verbal Commit",
  "Contract Sent",
  "Application Started",
  "Underwriting Submitted",
  "Approved",
  "Terminal Ordered",
  "Go-Live Scheduled",
] as const;

export const CLOSED_DEAL_STAGES = [
  "Closed Won",
  "Closed Lost",
  "Nurture / Not Now",
  "Live (First Batch)",
  "Active (7 Days)",
  "Active (30 Days)",
] as const;

// ── Live Chat ─────────────────────────────────────────────────────────────────
export const liveChats = pgTable("live_chats", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull().unique(),
  visitorName: text("visitor_name"),
  visitorEmail: text("visitor_email"),
  pageUrl: text("page_url"),
  status: text("status").notNull().default("active"), // active | closed | offline_captured
  contactId: integer("contact_id").references(() => contacts.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
  closedAt: timestamp("closed_at"),
}, (table) => [
  index("live_chats_session_id_idx").on(table.sessionId),
  index("live_chats_status_idx").on(table.status),
]);

export const liveChatMessages = pgTable("live_chat_messages", {
  id: serial("id").primaryKey(),
  chatId: integer("chat_id").notNull().references(() => liveChats.id, { onDelete: "cascade" }),
  senderType: text("sender_type").notNull(), // visitor | agent
  senderName: text("sender_name"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("live_chat_messages_chat_id_idx").on(table.chatId),
]);

export const insertLiveChatSchema = createInsertSchema(liveChats).omit({
  id: true,
  createdAt: true,
  lastMessageAt: true,
  closedAt: true,
});

export const insertLiveChatMessageSchema = createInsertSchema(liveChatMessages).omit({
  id: true,
  createdAt: true,
});

export type LiveChat = typeof liveChats.$inferSelect;
export type InsertLiveChat = z.infer<typeof insertLiveChatSchema>;
export type LiveChatMessage = typeof liveChatMessages.$inferSelect;
export type InsertLiveChatMessage = z.infer<typeof insertLiveChatMessageSchema>;

// ── NPS Responses ─────────────────────────────────────────────────────────────
export const npsResponses = pgTable("nps_responses", {
  id: serial("id").primaryKey(),
  token: text("token").notNull().unique(),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  merchantProfileId: integer("merchant_profile_id").references(() => merchantProfiles.id),
  dayTrigger: integer("day_trigger").notNull(),
  score: integer("score"),
  comment: text("comment"),
  submittedAt: timestamp("submitted_at"),
  emailSentAt: timestamp("email_sent_at"),
  sendAttemptedAt: timestamp("send_attempted_at"),
  reviewRequestQueued: boolean("review_request_queued").default(false),
  healthAlertCreated: boolean("health_alert_created").default(false),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("nps_responses_token_idx").on(table.token),
  index("nps_responses_contact_id_idx").on(table.contactId),
]);

export const insertNpsResponseSchema = createInsertSchema(npsResponses).omit({
  id: true,
  createdAt: true,
});

export type NpsResponse = typeof npsResponses.$inferSelect;
export type InsertNpsResponse = z.infer<typeof insertNpsResponseSchema>;

// ── Merchant Referrals ────────────────────────────────────────────────────────
export const merchantReferrals = pgTable("merchant_referrals", {
  id: serial("id").primaryKey(),
  referrerProfileId: integer("referrer_profile_id").references(() => merchantProfiles.id),
  referredEmail: text("referred_email").notNull(),
  referredName: text("referred_name"),
  referredCompany: text("referred_company"),
  referralCode: text("referral_code").notNull(),
  status: text("status").default("pending"),
  creditAmount: text("credit_amount").default("0"),
  creditPaidAt: timestamp("credit_paid_at"),
  referredContactId: integer("referred_contact_id").references(() => contacts.id),
  referredDealId: integer("referred_deal_id").references(() => deals.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("merchant_referrals_referrer_idx").on(table.referrerProfileId),
  index("merchant_referrals_code_idx").on(table.referralCode),
]);

export const insertMerchantReferralSchema = createInsertSchema(merchantReferrals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type MerchantReferral = typeof merchantReferrals.$inferSelect;
export type InsertMerchantReferral = z.infer<typeof insertMerchantReferralSchema>;

export const MERCHANT_REFERRAL_STATUSES = [
  "pending",
  "signed_up",
  "activated",
  "credited",
  "expired",
] as const;

// ── AI Roleplay Sessions ──────────────────────────────────────────────────────
export const roleplaySessions = pgTable("roleplay_sessions", {
  id: serial("id").primaryKey(),
  userId: varchar("user_id").references(() => users.id),
  scenario: text("scenario").notNull(),
  persona: text("persona").notNull(),
  difficulty: text("difficulty").default("standard"),
  status: text("status").default("active"),
  totalExchanges: integer("total_exchanges").default(0),
  overallScore: integer("overall_score"),
  coachingSummary: text("coaching_summary"),
  strengths: text("strengths").array(),
  gaps: text("gaps").array(),
  suggestedPhrasing: text("suggested_phrasing").array(),
  createdAt: timestamp("created_at").defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertRoleplaySessionSchema = createInsertSchema(roleplaySessions).omit({
  id: true,
  createdAt: true,
});

export type RoleplaySession = typeof roleplaySessions.$inferSelect;
export type InsertRoleplaySession = z.infer<typeof insertRoleplaySessionSchema>;

export const roleplayExchanges = pgTable("roleplay_exchanges", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => roleplaySessions.id),
  repMessage: text("rep_message").notNull(),
  merchantReply: text("merchant_reply").notNull(),
  toneScore: integer("tone_score"),
  clarityScore: integer("clarity_score"),
  objectionAddressed: boolean("objection_addressed"),
  feedback: text("feedback"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("roleplay_exchanges_session_id_idx").on(table.sessionId),
]);

export const insertRoleplayExchangeSchema = createInsertSchema(roleplayExchanges).omit({
  id: true,
  createdAt: true,
});

export type RoleplayExchange = typeof roleplayExchanges.$inferSelect;
export type InsertRoleplayExchange = z.infer<typeof insertRoleplayExchangeSchema>;

// ── Leaderboard Settings ──────────────────────────────────────────────────────
export const leaderboardSettings = pgTable("leaderboard_settings", {
  id: serial("id").primaryKey(),
  showDeals: boolean("show_deals").default(true),
  showRevenue: boolean("show_revenue").default(true),
  showProposals: boolean("show_proposals").default(true),
  showCallsMade: boolean("show_calls_made").default(true),
  showResponseRate: boolean("show_response_rate").default(false),
  visibleToAgents: boolean("visible_to_agents").default(true),
  monthlyDealGoal: integer("monthly_deal_goal").default(10),
  monthlyRevenueGoal: text("monthly_revenue_goal").default("50000"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type LeaderboardSettings = typeof leaderboardSettings.$inferSelect;

// ── Retention Campaign Configs ────────────────────────────────────────────────
export const retentionCampaignConfigs = pgTable("retention_campaign_configs", {
  id: serial("id").primaryKey(),
  alertType: text("alert_type").notNull(),
  campaignName: text("campaign_name").notNull(),
  enabled: boolean("enabled").default(true),
  suggestedMessage: text("suggested_message"),
  taskPriority: text("task_priority").default("high"),
  taskDueDays: integer("task_due_days").default(1),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertRetentionCampaignConfigSchema = createInsertSchema(retentionCampaignConfigs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type RetentionCampaignConfig = typeof retentionCampaignConfigs.$inferSelect;
export type InsertRetentionCampaignConfig = z.infer<typeof insertRetentionCampaignConfigSchema>;

// ── Virtual Terminal Transactions ─────────────────────────────────────────────
export const virtualTerminalTransactions = pgTable("virtual_terminal_transactions", {
  id: serial("id").primaryKey(),
  gatewayTransactionId: text("gateway_transaction_id"),
  authCode: text("auth_code"),
  status: text("status").notNull().default("pending"),
  amount: text("amount").notNull(),
  refundedAmount: text("refunded_amount").default("0"),
  cardType: text("card_type"),
  lastFour: text("last_four"),
  cardholderName: text("cardholder_name"),
  billingZip: text("billing_zip"),
  memo: text("memo"),
  responseCode: text("response_code"),
  responseText: text("response_text"),
  processedBy: text("processed_by"),
  refundedBy: text("refunded_by"),
  refundedAt: timestamp("refunded_at"),
  rawResponse: jsonb("raw_response"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("vt_transactions_status_idx").on(table.status),
  index("vt_transactions_created_at_idx").on(table.createdAt),
  index("vt_transactions_processed_by_idx").on(table.processedBy),
]);

export const insertVirtualTerminalTransactionSchema = createInsertSchema(virtualTerminalTransactions).omit({
  id: true,
  createdAt: true,
});

export type VirtualTerminalTransaction = typeof virtualTerminalTransactions.$inferSelect;
export type InsertVirtualTerminalTransaction = z.infer<typeof insertVirtualTerminalTransactionSchema>;

// ── Sub-ISO White-Label Partner Organizations ─────────────────────────────────
export const partnerOrganizations = pgTable("partner_organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  primaryColor: text("primary_color").default("#2563eb"),
  tagline: text("tagline"),
  commissionRate: real("commission_rate").default(10),
  status: text("status").default("active"),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("partner_orgs_slug_idx").on(table.slug),
]);

export const insertPartnerOrgSchema = createInsertSchema(partnerOrganizations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type PartnerOrganization = typeof partnerOrganizations.$inferSelect;
export type InsertPartnerOrganization = z.infer<typeof insertPartnerOrgSchema>;

// ── Co-Branded Proposals ───────────────────────────────────────────────────────
export const coBrandedProposals = pgTable("co_branded_proposals", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id),
  contactId: integer("contact_id").references(() => contacts.id),
  partnerOrgId: integer("partner_org_id").references(() => partnerOrganizations.id),
  token: text("token").notNull().unique(),
  status: text("status").default("draft"),
  pricingPlan: text("pricing_plan"),
  proposalData: jsonb("proposal_data"),
  merchantName: text("merchant_name"),
  merchantMonthlyVolume: text("merchant_monthly_volume"),
  merchantEffectiveRate: text("merchant_effective_rate"),
  merchantEmail: text("merchant_email"),
  customMessage: text("custom_message"),
  deliveredAt: timestamp("delivered_at"),
  viewedAt: timestamp("viewed_at"),
  viewCount: integer("view_count").default(0),
  acceptedAt: timestamp("accepted_at"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("co_branded_proposals_partner_org_id_idx").on(table.partnerOrgId),
  index("co_branded_proposals_deal_id_idx").on(table.dealId),
  index("co_branded_proposals_token_idx").on(table.token),
]);

export const insertCoBrandedProposalSchema = createInsertSchema(coBrandedProposals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type CoBrandedProposal = typeof coBrandedProposals.$inferSelect;
export type InsertCoBrandedProposal = z.infer<typeof insertCoBrandedProposalSchema>;

export const partnerOrgUsers = pgTable("partner_org_users", {
  id: serial("id").primaryKey(),
  partnerOrgId: integer("partner_org_id").references(() => partnerOrganizations.id).notNull(),
  email: text("email").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").default(""),
  passwordHash: text("password_hash"),
  role: text("role").default("member"),
  status: text("status").default("active"),
  // Incremented on credential recovery; cookie sessions carry and must match it.
  sessionVersion: integer("session_version").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  uniqueIndex("partner_org_users_email_org_idx").on(table.email, table.partnerOrgId),
]);

export const insertPartnerOrgUserSchema = createInsertSchema(partnerOrgUsers).omit({
  id: true,
  createdAt: true,
});

export type PartnerOrgUser = typeof partnerOrgUsers.$inferSelect;
export type InsertPartnerOrgUser = z.infer<typeof insertPartnerOrgUserSchema>;

export const TESTIMONIAL_SUBMISSION_STATUSES = ["pending", "approved", "rejected"] as const;

export const testimonialSubmissions = pgTable("testimonial_submissions", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  businessName: text("business_name"),
  email: text("email").notNull(),
  phone: text("phone"),
  industry: text("industry"),
  videoLink: text("video_link"),
  savingsAmount: text("savings_amount"),
  story: text("story").notNull(),
  status: text("status").default("pending").notNull(),
  publish: boolean("publish").default(false).notNull(),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at"),
  reviewNotes: text("review_notes"),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("testimonial_submissions_status_idx").on(table.status),
  index("testimonial_submissions_created_at_idx").on(table.createdAt),
]);

export const insertTestimonialSubmissionSchema = createInsertSchema(testimonialSubmissions).omit({
  id: true,
  createdAt: true,
  reviewedAt: true,
});

export type TestimonialSubmission = typeof testimonialSubmissions.$inferSelect;
export type InsertTestimonialSubmission = z.infer<typeof insertTestimonialSubmissionSchema>;

// ── Background Job Orchestration Ledger ──────────────────────────────────────
export const backgroundJobs = pgTable("background_jobs", {
  id: serial("id").primaryKey(),
  jobName: text("job_name").notNull().unique(),
  status: text("status").notNull().default("idle"),
  lastStartedAt: timestamp("last_started_at"),
  lastFinishedAt: timestamp("last_finished_at"),
  lastError: text("last_error"),
  runCount: integer("run_count").notNull().default(0),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
  /** Fencing token set on each acquireJobLock(); releaseJobLock() validates it. */
  lockToken: text("lock_token"),
}, (table) => [
  index("background_jobs_job_name_idx").on(table.jobName),
  index("background_jobs_status_idx").on(table.status),
]);

export const insertBackgroundJobSchema = createInsertSchema(backgroundJobs).omit({
  id: true,
  updatedAt: true,
});

export type BackgroundJob = typeof backgroundJobs.$inferSelect;
export type InsertBackgroundJob = z.infer<typeof insertBackgroundJobSchema>;

export const AI_TRIGGER_TYPES = [
  "enrichment",
  "proposal",
  "reply",
  "reply-classify",
  "advisor",
  "advisor-chat",
  "blueprint",
  "outbound-copy",
  "statement-analysis",
  "ticket-classification",
  "ticket-classify",
  "website-quality",
  "insights",
  "email-compose",
  "compose-email",
  "nightly-discovery",
  "content-generation",
  "social-generation",
  "training-generation",
  "auto-reply",
  "chargeback-copilot",
  "credential_error",
  // System / infrastructure triggers
  "executive-briefing",
  "executive-coaching",
  "offer-routing",
  "sales-prep",
  "sequence-analysis",
  "system-health",
  "ghl-reply",
  "knowledge-embedding",
] as const;

export type AiTriggerType = typeof AI_TRIGGER_TYPES[number];

export const aiAuditLogs = pgTable("ai_audit_logs", {
  id: serial("id").primaryKey(),
  triggerType: text("trigger_type").notNull(),
  actorType: text("actor_type").notNull().default("system"),
  actorId: text("actor_id"),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens").default(0),
  completionTokens: integer("completion_tokens").default(0),
  costCents: real("cost_cents").default(0),
  responseSummary: text("response_summary"),
  error: text("error"),
  durationMs: integer("duration_ms"),
  promptHash: text("prompt_hash"),
  confidenceScore: real("confidence_score"),
  flagged: boolean("flagged").default(false),
  rawPrompt: text("raw_prompt"),
  rawResponse: text("raw_response"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("ai_audit_logs_trigger_type_idx").on(table.triggerType),
  index("ai_audit_logs_created_at_idx").on(table.createdAt),
  index("ai_audit_logs_flagged_idx").on(table.flagged),
]);

export const insertAiAuditLogSchema = createInsertSchema(aiAuditLogs).omit({
  id: true,
  createdAt: true,
});

export type AiAuditLog = typeof aiAuditLogs.$inferSelect;
export type InsertAiAuditLog = z.infer<typeof insertAiAuditLogSchema>;

export const reviewQueue = pgTable("review_queue", {
  id: serial("id").primaryKey(),
  sourceType: text("source_type").notNull().$type<"rfi" | "quiz" | "dead_letter_job" | "ai_output">(),
  sourceId: integer("source_id").notNull(),
  status: text("status").notNull().default("pending").$type<"pending" | "approved">(),
  checklistState: jsonb("checklist_state").$type<Record<string, boolean>>().default({}),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  ghlWorkflowId: text("ghl_workflow_id"),
  notes: text("notes"),
  metadata: jsonb("metadata").$type<Record<string, any>>(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("review_queue_status_idx").on(table.status),
  index("review_queue_source_type_idx").on(table.sourceType),
  index("review_queue_created_at_idx").on(table.createdAt),
]);

export const insertReviewQueueSchema = createInsertSchema(reviewQueue).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  sourceType: z.enum(["rfi", "quiz", "dead_letter_job", "ai_output"]),
  status: z.enum(["pending", "approved"]).optional(),
});

export type ReviewQueueItem = typeof reviewQueue.$inferSelect;
export type InsertReviewQueueItem = z.infer<typeof insertReviewQueueSchema>;

export const REVIEW_CHECKLIST_ITEMS = [
  { key: "verify_identity", label: "Verify contact identity" },
  { key: "confirm_business", label: "Confirm business type and volume" },
  { key: "review_data", label: "Review submitted data for completeness" },
  { key: "check_duplicate", label: "Check for duplicate contact" },
  { key: "confirm_lead_source", label: "Confirm lead source / UTM" },
  { key: "internal_notes", label: "Internal notes added" },
] as const;

// ── Churn Risk & Health Scoring ───────────────────────────────────────────────

export const CHURN_RISK_TIERS = ["Low", "Medium", "High", "Critical"] as const;
export type ChurnRiskTier = typeof CHURN_RISK_TIERS[number];

export const churnScoreWeights = pgTable("churn_score_weights", {
  id: serial("id").primaryKey(),
  signalKey: text("signal_key").notNull().unique(),
  label: text("label").notNull(),
  weight: real("weight").notNull().default(1.0),
  description: text("description"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertChurnScoreWeightsSchema = createInsertSchema(churnScoreWeights).omit({
  id: true,
  updatedAt: true,
});

export type ChurnScoreWeight = typeof churnScoreWeights.$inferSelect;
export type InsertChurnScoreWeight = z.infer<typeof insertChurnScoreWeightsSchema>;

export const merchantHealthScores = pgTable("merchant_health_scores", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id).notNull(),
  churnScore: real("churn_score").notNull().default(0),
  riskTier: text("risk_tier").notNull().default("Low"),
  volumeTrendScore: real("volume_trend_score").default(0),
  chargebackTrendScore: real("chargeback_trend_score").default(0),
  ticketVelocityScore: real("ticket_velocity_score").default(0),
  npsScore: real("nps_score").default(0),
  portalActivityScore: real("portal_activity_score").default(0),
  outreachResponseScore: real("outreach_response_score").default(0),
  overrideScore: real("override_score"),
  overrideNote: text("override_note"),
  overriddenAt: timestamp("overridden_at"),
  overriddenBy: text("overridden_by"),
  retentionCampaignTriggered: boolean("retention_campaign_triggered").default(false),
  agentNotified: boolean("agent_notified").default(false),
  computedAt: timestamp("computed_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("merchant_health_scores_contact_id_idx").on(table.contactId),
  index("merchant_health_scores_risk_tier_idx").on(table.riskTier),
  index("merchant_health_scores_computed_at_idx").on(table.computedAt),
]);

export const insertMerchantHealthScoreSchema = createInsertSchema(merchantHealthScores).omit({
  id: true,
  createdAt: true,
});

export type MerchantHealthScore = typeof merchantHealthScores.$inferSelect;
export type InsertMerchantHealthScore = z.infer<typeof insertMerchantHealthScoreSchema>;

// ── Entity Relationship Knowledge Graph ───────────────────────────────────────

export const ENTITY_RELATIONSHIP_TYPES = [
  "same_ein",
  "same_bank",
  "same_phone",
  "same_owner",
  "same_address",
  "iso_agent",
  "company_member",
  "manual",
] as const;

export type EntityRelationshipType = typeof ENTITY_RELATIONSHIP_TYPES[number];

export const ENTITY_TYPES = [
  "contact",
  "company",
  "deal",
  "mid",
  "iso_partner",
  "user",
  "partner",
] as const;

export type EntityType = typeof ENTITY_TYPES[number];

export const entityRelationships = pgTable("entity_relationships", {
  id: serial("id").primaryKey(),
  sourceEntityType: text("source_entity_type").notNull().$type<EntityType>(),
  sourceEntityId: integer("source_entity_id").notNull(),
  targetEntityType: text("target_entity_type").notNull().$type<EntityType>(),
  targetEntityId: integer("target_entity_id").notNull(),
  relationshipType: text("relationship_type").notNull().$type<EntityRelationshipType>(),
  confidence: real("confidence").notNull().default(1.0),
  source: text("source").notNull().default("system"),
  riskFlag: boolean("risk_flag").default(false),
  riskReason: text("risk_reason"),
  note: text("note"),
  dismissedAt: timestamp("dismissed_at"),
  dismissedBy: text("dismissed_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("entity_relationships_source_idx").on(table.sourceEntityType, table.sourceEntityId),
  index("entity_relationships_target_idx").on(table.targetEntityType, table.targetEntityId),
  index("entity_relationships_type_idx").on(table.relationshipType),
  index("entity_relationships_risk_flag_idx").on(table.riskFlag),
  uniqueIndex("entity_relationships_unique_idx").on(
    table.sourceEntityType,
    table.sourceEntityId,
    table.targetEntityType,
    table.targetEntityId,
    table.relationshipType,
  ),
]);

export const insertEntityRelationshipSchema = createInsertSchema(entityRelationships).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  sourceEntityType: z.enum(ENTITY_TYPES),
  targetEntityType: z.enum(ENTITY_TYPES),
  relationshipType: z.enum(ENTITY_RELATIONSHIP_TYPES),
});

export type EntityRelationship = typeof entityRelationships.$inferSelect;
export type InsertEntityRelationship = z.infer<typeof insertEntityRelationshipSchema>;

export const ONBOARDING_CHECKLIST_ITEM_KEYS = [
  "voided_check",
  "government_id",
  "signed_agreement",
  "bank_letter",
  "business_license",
] as const;

// ---------------------------------------------------------------------------
// Merchant Onboarding Workflow Stages (10-stage pipeline tracker)
// Separate from onboarding_checklist_items (document tracking)
// ---------------------------------------------------------------------------
export const MERCHANT_ONBOARDING_STAGE_KEYS = [
  "application_started",
  "docs_requested",
  "docs_received",
  "underwriting",
  "approved",
  "equipment_terminal",
  "training",
  "go_live",
  "first_batch_processed",
  "support_handoff",
] as const;

export type MerchantOnboardingStageKey = typeof MERCHANT_ONBOARDING_STAGE_KEYS[number];

export const MERCHANT_ONBOARDING_STAGE_LABELS: Record<MerchantOnboardingStageKey, string> = {
  application_started: "Application Started",
  docs_requested: "Docs Requested",
  docs_received: "Docs Received",
  underwriting: "Underwriting",
  approved: "Approved",
  equipment_terminal: "Equipment / Terminal",
  training: "Training",
  go_live: "Go-Live",
  first_batch_processed: "First Batch Processed",
  support_handoff: "Support Handoff",
};

export const MERCHANT_ONBOARDING_STAGE_STATUSES = [
  "pending",
  "in_progress",
  "complete",
  "blocked",
] as const;

export type MerchantOnboardingStageStatus = typeof MERCHANT_ONBOARDING_STAGE_STATUSES[number];

export const merchantOnboardingStages = pgTable("merchant_onboarding_stages", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id).notNull(),
  stageKey: text("stage_key").notNull(),
  status: text("status").notNull().default("pending"),
  owner: text("owner"),
  dueDate: timestamp("due_date"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  equipmentOrderRef: text("equipment_order_ref"),
  ghlStageSyncedAt: timestamp("ghl_stage_synced_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("merchant_onboarding_stages_deal_id_idx").on(table.dealId),
  uniqueIndex("merchant_onboarding_stages_deal_key_unique").on(table.dealId, table.stageKey),
]);

export const insertMerchantOnboardingStageSchema = createInsertSchema(merchantOnboardingStages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type MerchantOnboardingStage = typeof merchantOnboardingStages.$inferSelect;
export type InsertMerchantOnboardingStage = z.infer<typeof insertMerchantOnboardingStageSchema>;

export type OnboardingChecklistItemKey = typeof ONBOARDING_CHECKLIST_ITEM_KEYS[number];

export const ONBOARDING_CHECKLIST_ITEM_LABELS: Record<OnboardingChecklistItemKey, string> = {
  voided_check: "Voided Check",
  government_id: "Government-Issued ID",
  signed_agreement: "Signed Merchant Agreement",
  bank_letter: "Bank Letter",
  business_license: "Business License",
};

export const ONBOARDING_CHECKLIST_ITEM_STATUSES = [
  "not_requested",
  "requested",
  "received",
  "approved",
  "rejected",
] as const;

export type OnboardingChecklistItemStatus = typeof ONBOARDING_CHECKLIST_ITEM_STATUSES[number];

export const onboardingChecklistItems = pgTable("onboarding_checklist_items", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id).notNull(),
  itemKey: text("item_key").notNull(),
  status: text("status").default("not_requested"),
  documentId: integer("document_id").references(() => documents.id),
  notes: text("notes"),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("checklist_deal_id_idx").on(table.dealId),
  uniqueIndex("checklist_deal_item_unique_idx").on(table.dealId, table.itemKey),
]);

export const insertOnboardingChecklistItemSchema = createInsertSchema(onboardingChecklistItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type OnboardingChecklistItem = typeof onboardingChecklistItems.$inferSelect;
export type InsertOnboardingChecklistItem = z.infer<typeof insertOnboardingChecklistItemSchema>;

export const rateReviewRequests = pgTable("rate_review_requests", {
  id: serial("id").primaryKey(),
  // The statement-upload command is the request occurrence authority for
  // portal submissions.  This unique link makes a retry/recovery unable to
  // create a second review for the same claimed command.
  statementUploadCommandId: uuid("statement_upload_command_id").references(() => statementUploadCommands.id),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  documentId: integer("document_id").references(() => documents.id),
  status: text("status").default("requested"),
  analysisResult: jsonb("analysis_result"),
  isOptimalPricing: boolean("is_optimal_pricing"),
  requestNotes: text("request_notes"),
  repViewedAt: timestamp("rep_viewed_at"),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: text("resolved_by"),
  resolution: text("resolution"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("rate_review_requests_statement_command_uidx")
    .on(table.statementUploadCommandId)
    .where(sql`statement_upload_command_id IS NOT NULL`),
  index("rate_review_requests_contact_id_idx").on(table.contactId),
  index("rate_review_requests_status_idx").on(table.status),
  index("rate_review_requests_created_at_idx").on(table.createdAt),
]);

export const insertRateReviewRequestSchema = createInsertSchema(rateReviewRequests).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type RateReviewRequest = typeof rateReviewRequests.$inferSelect;
export type InsertRateReviewRequest = z.infer<typeof insertRateReviewRequestSchema>;

export const toolClickEvents = pgTable("tool_click_events", {
  id: serial("id").primaryKey(),
  toolId: text("tool_id").notNull(),
  toolTitle: text("tool_title"),
  source: text("source").default("sales-tools-hub"),
  userId: text("user_id"),
  sessionId: text("session_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("tool_click_events_tool_id_idx").on(table.toolId),
  index("tool_click_events_created_at_idx").on(table.createdAt),
]);

export const insertToolClickEventSchema = createInsertSchema(toolClickEvents).omit({
  id: true,
  createdAt: true,
});

export type ToolClickEvent = typeof toolClickEvents.$inferSelect;
export type InsertToolClickEvent = z.infer<typeof insertToolClickEventSchema>;

// ─── Statement Proposals ─────────────────────────────────────────────────────
// Dedicated proposal draft entity created at upload time (step 10 of the
// statement upload chain). Overwritten when AI analysis completes.
export const statementProposals = pgTable("statement_proposals", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id),
  contactId: integer("contact_id").references(() => contacts.id),
  status: text("status").default("draft"),
  merchantName: text("merchant_name"),
  source: text("source"),
  statementFileName: text("statement_file_name"),
  plans: jsonb("plans"),
  savingsEstimate: text("savings_estimate"),
  effectiveRate: text("effective_rate"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("statement_proposals_deal_id_uidx").on(table.dealId).where(sql`deal_id IS NOT NULL`),
  index("statement_proposals_contact_id_idx").on(table.contactId),
]);

export const insertStatementProposalSchema = createInsertSchema(statementProposals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type StatementProposal = typeof statementProposals.$inferSelect;
export type InsertStatementProposal = z.infer<typeof insertStatementProposalSchema>;

// ─── Statement Upload Commands ────────────────────────────────────────────────
// Durable idempotency table for statement-upload operations.
// Each row represents one attempt identified by (operation_scope, request_id).
// The same (operation_scope, request_id) pair is only ever inserted once;
// subsequent calls with the same pair are treated as replays when the
// request_fingerprint also matches, or as conflicts when it differs.
export const statementUploadCommands = pgTable("statement_upload_commands", {
  id:                 uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  // Idempotency key supplied by the caller (UUIDv4 format required).
  requestId:          text("request_id").notNull(),
  // SHA-256 hex of canonical request fields + file buffer.
  requestFingerprint: text("request_fingerprint").notNull(),
  // Fixed logical operation namespace ("statement_upload").
  operationScope:     text("operation_scope").notNull(),
  // Authorized caller scope – e.g. "user:<userId>" or token-derived scope.
  ownerScope:          text("owner_scope").notNull(),
  // Logical source of the upload, e.g. "web", "api", "ghl-webhook".
  source:             text("source"),
  // Optional FK hints (nullable – not all uploads are tied to all entities).
  contactId:          integer("contact_id").references(() => contacts.id),
  dealId:             integer("deal_id").references(() => deals.id),
  documentId:         integer("document_id").references(() => documents.id),
  // Lifecycle state machine.
  status:             text("status").notNull().default("in_progress"),
  // BT-06: captured exactly once at claim time; immutable for event reporting.
  recordClassAtEvent: text("record_class_at_event").notNull().default("unknown"),
  // ^ allowed: "in_progress" | "succeeded" | "recoverable_failed"
  // Opaque JSON checkpoint written by the upload chain for crash-recovery.
  checkpoint:         jsonb("checkpoint"),
  // Opaque JSON context written at command creation (original request params).
  context:            jsonb("context"),
  // Final JSON result written on success.
  result:             jsonb("result"),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt:        timestamp("completed_at", { withTimezone: true }),
  leaseToken:         uuid("lease_token"),
  leaseExpiresAt:     timestamp("lease_expires_at", { withTimezone: true }),
  heartbeatAt:        timestamp("heartbeat_at", { withTimezone: true }),
  attemptCount:       integer("attempt_count").notNull().default(0),
  terminalCode:       text("terminal_code"),
}, (table) => [
  // Primary idempotency constraint: one row per operation/request pair.
  uniqueIndex("suc_scope_request_id_uidx").on(table.operationScope, table.requestId),
  // Fast lookup by request_id alone (cross-scope conflict detection).
  index("suc_request_id_idx").on(table.requestId),
  // Fast lookup by contact for dashboard queries.
  index("suc_contact_id_idx").on(table.contactId),
  // Fast lookup by deal.
  index("suc_deal_id_idx").on(table.dealId),
]);

export const insertStatementUploadCommandSchema = createInsertSchema(statementUploadCommands).omit({
  id: true,
  recordClassAtEvent: true,
  createdAt: true,
  updatedAt: true,
  completedAt: true,
});

export type StatementUploadCommand = typeof statementUploadCommands.$inferSelect;
export type InsertStatementUploadCommand = z.infer<typeof insertStatementUploadCommandSchema>;

// ─── CRO-05A Inbound Revenue Operations ─────────────────────────────────────
// These tables are the request-occurrence authority. They deliberately store
// hashes and references instead of raw intake payloads or protected bytes.
export const protectedObjects = pgTable("protected_objects", {
  id: uuid("id").primaryKey().defaultRandom(),
  objectRef: uuid("object_ref").notNull().defaultRandom(),
  encryptedBytes: bytea("encrypted_bytes").notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  mimeType: text("mime_type").notNull(),
  fileName: text("file_name").notNull(),
  tenantScope: text("tenant_scope").notNull().default("default"),
  environmentScope: text("environment_scope").notNull(),
  validationState: text("validation_state").notNull().default("validated"),
  retentionState: text("retention_state").notNull().default("active"),
  legalHold: boolean("legal_hold").notNull().default(false),
  uploadCompleteAt: timestamp("upload_complete_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("protected_objects_object_ref_uidx").on(table.objectRef),
  index("protected_objects_retention_idx").on(table.retentionState, table.legalHold),
  check("protected_objects_validation_state_chk", sql`validation_state IN ('pending', 'validated', 'rejected')`),
  check("protected_objects_retention_state_chk", sql`retention_state IN ('active', 'expired', 'deleted')`),
  check("protected_objects_size_chk", sql`size_bytes >= 0`),
]);

export type ProtectedObject = typeof protectedObjects.$inferSelect;

export const inboundRequests = pgTable("inbound_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull(),
  occurrenceKey: text("occurrence_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  sourceCategory: text("source_category").notNull(),
  sourceType: text("source_type").notNull(),
  sourceClass: text("source_class").notNull(),
  callerScope: text("caller_scope").notNull(),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  sourceReceivedAt: timestamp("source_received_at", { withTimezone: true }).notNull().defaultNow(),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  ticketId: integer("ticket_id").references(() => tickets.id),
  // Store the externally usable opaque reference, not the protected_objects
  // row primary key. object_ref is unique and remains a database-enforced link.
  protectedObjectRef: uuid("protected_object_ref").references(() => protectedObjects.objectRef),
  consentEvidenceRefs: jsonb("consent_evidence_refs"),
  attributionRefs: jsonb("attribution_refs"),
  manifestVersion: text("manifest_version").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  lifecycleState: text("lifecycle_state").notNull().default("claimed"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  terminalReason: text("terminal_reason"),
  reconciliationState: text("reconciliation_state").notNull().default("not_required"),
  assignmentStatus: text("assignment_status").notNull().default("pending"),
  assignedTo: text("assigned_to"),
  slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("inbound_requests_idempotency_uidx").on(table.idempotencyKey),
  uniqueIndex("inbound_requests_occurrence_uidx").on(table.sourceCategory, table.sourceType, table.occurrenceKey),
  index("inbound_requests_operator_idx").on(table.sourceClass, table.lifecycleState, table.createdAt),
  index("inbound_requests_contact_idx").on(table.contactId, table.createdAt),
  check("inbound_requests_lifecycle_state_chk", sql`lifecycle_state IN ('claimed', 'processing', 'accepted', 'completed', 'failed', 'cancelled', 'review_required')`),
  check("inbound_requests_reconciliation_state_chk", sql`reconciliation_state IN ('not_required', 'pending', 'reconciled', 'orphaned')`),
  check("inbound_requests_assignment_status_chk", sql`assignment_status IN ('pending', 'assigned', 'unassigned_policy_missing', 'review_required', 'preserved')`),
]);

export const inboundRequestEffects = pgTable("inbound_request_effects", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id").notNull().references(() => inboundRequests.id, { onDelete: "cascade" }),
  effectKey: text("effect_key").notNull(),
  effectType: text("effect_type").notNull(),
  state: text("state").notNull().default("held"),
  required: boolean("required").notNull().default(false),
  externalSideEffect: boolean("external_side_effect").notNull().default(false),
  prerequisites: jsonb("prerequisites"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  providerReceipt: text("provider_receipt"),
  terminalReason: text("terminal_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("inbound_request_effects_key_uidx").on(table.requestId, table.effectKey),
  index("inbound_request_effects_state_idx").on(table.state, table.nextAttemptAt),
  check("inbound_request_effects_state_chk", sql`state IN ('held', 'ready', 'attempting', 'sent', 'failed', 'suppressed')`),
]);

export const inboundAssignmentDecisions = pgTable("inbound_assignment_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id").notNull().references(() => inboundRequests.id, { onDelete: "cascade" }),
  decisionOrdinal: integer("decision_ordinal").notNull().default(0),
  status: text("status").notNull(),
  assignedTo: text("assigned_to"),
  reasonCode: text("reason_code").notNull(),
  policyVersion: text("policy_version").notNull(),
  policyHash: text("policy_hash").notNull(),
  territory: text("territory"),
  capacitySnapshot: jsonb("capacity_snapshot"),
  serviceHoursSnapshot: jsonb("service_hours_snapshot"),
  actorType: text("actor_type").notNull(),
  actorId: text("actor_id"),
  priorAssignee: text("prior_assignee"),
  fence: integer("fence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("inbound_assignment_decisions_ordinal_uidx").on(table.requestId, table.decisionOrdinal),
  index("inbound_assignment_decisions_request_idx").on(table.requestId, table.createdAt),
]);

export const inboundRequestWorkLinks = pgTable("inbound_request_work_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  requestId: uuid("request_id").notNull().references(() => inboundRequests.id, { onDelete: "cascade" }),
  workType: text("work_type").notNull(),
  taskId: integer("task_id").references(() => tasks.id),
  ticketId: integer("ticket_id").references(() => tickets.id),
  commandKey: text("command_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("inbound_request_work_links_request_type_uidx").on(table.requestId, table.workType),
  uniqueIndex("inbound_request_work_links_command_uidx").on(table.commandKey),
  check("inbound_request_work_links_target_chk", sql`(work_type = 'task' AND task_id IS NOT NULL AND ticket_id IS NULL) OR (work_type = 'ticket' AND ticket_id IS NOT NULL AND task_id IS NULL)`),
]);

export const insertInboundRequestSchema = createInsertSchema(inboundRequests).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InboundRequest = typeof inboundRequests.$inferSelect;
export type InsertInboundRequest = z.infer<typeof insertInboundRequestSchema>;
export type InboundRequestEffect = typeof inboundRequestEffects.$inferSelect;
export type InboundAssignmentDecision = typeof inboundAssignmentDecisions.$inferSelect;
export type InboundRequestWorkLink = typeof inboundRequestWorkLinks.$inferSelect;

// ─── Underwriting Rules Engine ───────────────────────────────────────────────
export const underwritingRules = pgTable("underwriting_rules", {
  id: serial("id").primaryKey(),
  minMonthlyVolume: numeric("min_monthly_volume").default("5000"),
  maxMonthlyVolume: numeric("max_monthly_volume").default("500000"),
  effectiveRateCeiling: numeric("effective_rate_ceiling").default("3.5"),
  chargebackRateLimit: numeric("chargeback_rate_limit").default("1.0"),
  chargebackRateHardLimit: numeric("chargeback_rate_hard_limit").default("2.0"),
  volumeHardDeviationPct: numeric("volume_hard_deviation_pct").default("50"),
  allowedProcessors: text("allowed_processors").array(),
  blockedProcessors: text("blocked_processors").array(),
  autoApproveEnabled: boolean("auto_approve_enabled").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUnderwritingRulesSchema = createInsertSchema(underwritingRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type UnderwritingRules = typeof underwritingRules.$inferSelect;
export type InsertUnderwritingRules = z.infer<typeof insertUnderwritingRulesSchema>;

export const underwritingDecisions = pgTable("underwriting_decisions", {
  id: serial("id").primaryKey(),
  dealId: integer("deal_id").references(() => deals.id),
  decision: text("decision").notNull(),
  score: integer("score").notNull().default(0),
  reasons: text("reasons").array(),
  rulesSnapshot: jsonb("rules_snapshot"),
  decidedAt: timestamp("decided_at").defaultNow(),
  overriddenBy: text("overridden_by"),
  overriddenAt: timestamp("overridden_at"),
  overrideAction: text("override_action"),
  overrideNote: text("override_note"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("underwriting_decisions_deal_id_idx").on(table.dealId),
  index("underwriting_decisions_decision_idx").on(table.decision),
  index("underwriting_decisions_created_at_idx").on(table.createdAt),
]);

export const insertUnderwritingDecisionSchema = createInsertSchema(underwritingDecisions).omit({
  id: true,
  createdAt: true,
});

export type UnderwritingDecision = typeof underwritingDecisions.$inferSelect;
export type InsertUnderwritingDecision = z.infer<typeof insertUnderwritingDecisionSchema>;

// ─── Underwriting Conditions (#1403) ─────────────────────────────────────────
export const underwritingConditions = pgTable("underwriting_conditions", {
  id:              serial("id").primaryKey(),
  dealId:          integer("deal_id").notNull().references(() => deals.id, { onDelete: "cascade" }),
  decisionId:      integer("decision_id").references(() => underwritingDecisions.id),
  conditionType:   text("condition_type").notNull(),
  description:     text("description").notNull(),
  status:          text("status").notNull().default("pending"),
  merchantVisible: boolean("merchant_visible").notNull().default(true),
  dueDate:         timestamp("due_date"),
  submittedAt:     timestamp("submitted_at"),
  approvedAt:      timestamp("approved_at"),
  waivedAt:        timestamp("waived_at"),
  waivedReason:    text("waived_reason"),
  documentId:      integer("document_id"),
  notes:           text("notes"),
  createdBy:       integer("created_by"),
  updatedBy:       integer("updated_by"),
  createdAt:       timestamp("created_at").notNull().defaultNow(),
  updatedAt:       timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("idx_uw_conditions_deal_id").on(t.dealId),
  index("idx_uw_conditions_status").on(t.dealId, t.status),
]);

export const insertUnderwritingConditionSchema = createInsertSchema(underwritingConditions).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type UnderwritingCondition = typeof underwritingConditions.$inferSelect;
export type InsertUnderwritingCondition = z.infer<typeof insertUnderwritingConditionSchema>;

// ─── Push Subscriptions ──────────────────────────────────────────────────────
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  endpoint: text("endpoint").notNull(),
  auth: text("auth").notNull(),
  p256dh: text("p256dh").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("push_subscriptions_user_id_idx").on(table.userId),
  uniqueIndex("push_subscriptions_endpoint_idx").on(table.endpoint),
]);

export const insertPushSubscriptionSchema = createInsertSchema(pushSubscriptions).omit({
  id: true,
  createdAt: true,
});

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type InsertPushSubscription = z.infer<typeof insertPushSubscriptionSchema>;

// ─── Bot Contexts (GHL AI Bot Management) ────────────────────────────────────
export const botContexts = pgTable("bot_contexts", {
  id: serial("id").primaryKey(),
  contextId: text("context_id").notNull(),
  name: text("name").notNull(),
  systemPrompt: text("system_prompt").notNull(),
  faqItems: jsonb("faq_items").default([]),
  active: boolean("active").default(true),
  autoReplyEnabled: boolean("auto_reply_enabled").default(false),
  autoReplyDelaySeconds: integer("auto_reply_delay_seconds").default(180),
  confidenceThreshold: integer("confidence_threshold").default(60),
  channel: text("channel").default("all"),
  verticalKey: text("vertical_key"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("bot_contexts_context_id_idx").on(table.contextId),
]);

export const insertBotContextSchema = createInsertSchema(botContexts).omit({ id: true, createdAt: true, updatedAt: true });
export type BotContextRecord = typeof botContexts.$inferSelect;
export type InsertBotContextRecord = z.infer<typeof insertBotContextSchema>;

// ─── Handoff Rules ────────────────────────────────────────────────────────────
export const handoffRules = pgTable("handoff_rules", {
  id: serial("id").primaryKey(),
  pattern: text("pattern").notNull(),
  type: text("type").notNull(),
  active: boolean("active").default(true),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertHandoffRuleSchema = createInsertSchema(handoffRules).omit({ id: true, createdAt: true });
export type HandoffRule = typeof handoffRules.$inferSelect;
export type InsertHandoffRule = z.infer<typeof insertHandoffRuleSchema>;

// ─── Analytics Events ─────────────────────────────────────────────────────────
export const analyticsEvents = pgTable("analytics_events", {
  id: serial("id").primaryKey(),
  eventName: text("event_name").notNull(),
  eventId: text("event_id"),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
  sessionId: text("session_id"),
  visitorId: text("visitor_id"),
  bookingTrackingId: text("booking_tracking_id"),
  contactId: integer("contact_id"),
  dealId: integer("deal_id"),
  sequenceId: integer("sequence_id"),
  pagePath: text("page_path"),
  landingPage: text("landing_page"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  gclidPresent: boolean("gclid_present"),
  fbclidPresent: boolean("fbclid_present"),
  msclkidPresent: boolean("msclkid_present"),
  offerRoute: text("offer_route"),
  vertical: text("vertical"),
  consentTier: text("consent_tier"),
  lifecycleStage: text("lifecycle_stage"),
  sourceCategory: text("source_category"),
  formId: text("form_id"),
  channel: text("channel"),
  blockReason: text("block_reason"),
  dealStage: text("deal_stage"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("analytics_events_event_name_idx").on(table.eventName),
  index("analytics_events_occurred_at_idx").on(table.occurredAt),
  index("analytics_events_contact_id_idx").on(table.contactId),
  index("analytics_events_utm_source_campaign_idx").on(table.utmSource, table.utmCampaign),
  index("analytics_events_page_path_idx").on(table.pagePath),
  index("analytics_events_booking_tracking_id_idx").on(table.bookingTrackingId),
  uniqueIndex("analytics_events_event_id_idx").on(table.eventId),
]);

export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;
export const insertAnalyticsEventSchema = createInsertSchema(analyticsEvents).omit({ id: true, createdAt: true });
export type InsertAnalyticsEvent = z.infer<typeof insertAnalyticsEventSchema>;

// ─── Statement Requests ───────────────────────────────────────────────────────
export const statementRequests = pgTable("statement_requests", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id).notNull(),
  dealId: integer("deal_id").references(() => deals.id),
  sdrLeadStateId: integer("sdr_lead_state_id").references(() => sdrLeadState.id),
  status: text("status").notNull().default("requested"),
  uploadToken: text("upload_token").notNull(),
  uploadUrl: text("upload_url").notNull(),
  requestedAt: timestamp("requested_at").notNull(),
  uploadedAt: timestamp("uploaded_at"),
  reviewedAt: timestamp("reviewed_at"),
  abandonedAt: timestamp("abandoned_at"),
  lastReminderTaskAt: timestamp("last_reminder_task_at"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("statement_requests_upload_token_idx").on(table.uploadToken),
  index("statement_requests_contact_id_idx").on(table.contactId),
  index("statement_requests_status_idx").on(table.status),
]);

export const insertStatementRequestSchema = createInsertSchema(statementRequests).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type StatementRequest = typeof statementRequests.$inferSelect;
export type InsertStatementRequest = z.infer<typeof insertStatementRequestSchema>;

// ─── Contact AI Cache ─────────────────────────────────────────────────────────
export const contactAiCache = pgTable("contact_ai_cache", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").references(() => contacts.id).notNull(),
  cacheKey: text("cache_key").notNull(),
  output: jsonb("output").notNull(),
  model: text("model"),
  generatedAt: timestamp("generated_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("contact_ai_cache_contact_key_idx").on(table.contactId, table.cacheKey),
  index("contact_ai_cache_contact_id_idx").on(table.contactId),
]);

export const insertContactAiCacheSchema = createInsertSchema(contactAiCache).omit({
  id: true,
  createdAt: true,
});

export type ContactAiCache = typeof contactAiCache.$inferSelect;
export type InsertContactAiCache = z.infer<typeof insertContactAiCacheSchema>;

// ─── Outbound Send Counters (Task #792 — Global Kill Switch & Daily Caps) ─────
export const outboundSendCounters = pgTable("outbound_send_counters", {
  id: serial("id").primaryKey(),
  date: date("date").notNull(),
  channel: text("channel").notNull(),
  scope: text("scope").notNull(),
  count: integer("count").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("outbound_send_counters_date_channel_scope_uidx").on(table.date, table.channel, table.scope),
  index("outbound_send_counters_date_idx").on(table.date),
]);

export const insertOutboundSendCounterSchema = createInsertSchema(outboundSendCounters).omit({
  id: true,
});

export type OutboundSendCounter = typeof outboundSendCounters.$inferSelect;
export type InsertOutboundSendCounter = z.infer<typeof insertOutboundSendCounterSchema>;

// ─── Promotional Enrollment Jobs ──────────────────────────────────────────────
export const promotionalEnrollmentJobs = pgTable("promotional_enrollment_jobs", {
  id: serial("id").primaryKey(),
  sourceEventId: text("source_event_id").notNull().unique(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  triggerType: text("trigger_type").notNull(),
  formType: text("form_type"),
  status: text("status").notNull().default("pending"),
  reasonCodes: text("reason_codes").array(),
  enrollmentIds: integer("enrollment_ids").array(),
  attempts: integer("attempts").notNull().default(0),
  jobId: text("job_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
}, (table) => [
  index("promotional_enrollment_jobs_contact_id_idx").on(table.contactId),
  index("promotional_enrollment_jobs_status_idx").on(table.status),
]);

export const insertPromotionalEnrollmentJobSchema = createInsertSchema(promotionalEnrollmentJobs).omit({
  id: true,
  createdAt: true,
});

export type PromotionalEnrollmentJob = typeof promotionalEnrollmentJobs.$inferSelect;
export type InsertPromotionalEnrollmentJob = z.infer<typeof insertPromotionalEnrollmentJobSchema>;

export type PromotionalEnrollmentJobStatus =
  | "pending"
  | "processing"
  | "enrolled"
  | "blocked"
  | "no_matching_sequence"
  | "already_enrolled"
  | "failed"
  | "deferred_queue_unavailable";

export type PromotionalEligibilityReason =
  | "contact_not_found"
  | "dnc"
  | "existing_opt_out"
  | "existing_opt_out_preserved_on_resubmission"
  | "no_usable_channel"
  | "invalid_email_format"
  | "disposable_email_domain"
  | "email_status_blocked"
  | "eligible";

// ─── Per-Contact Lead Scoring Jobs ────────────────────────────────────────────
export const contactLeadScoringJobs = pgTable("contact_lead_scoring_jobs", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  requestedGeneration: integer("requested_generation").notNull().default(1),
  processedGeneration: integer("processed_generation").notNull().default(0),
  status: text("status").notNull(),
  triggerSources: text("trigger_sources").array(),
  inputVersionSnapshot: timestamp("input_version_snapshot", { withTimezone: true }),
  enqueueAttempts: integer("enqueue_attempts").notNull().default(0),
  executionAttempts: integer("execution_attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("contact_lead_scoring_jobs_contact_id_idx").on(table.contactId),
  index("contact_lead_scoring_jobs_status_idx").on(table.status),
]);

export const insertContactLeadScoringJobSchema = createInsertSchema(contactLeadScoringJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ContactLeadScoringJob = typeof contactLeadScoringJobs.$inferSelect;
export type InsertContactLeadScoringJob = z.infer<typeof insertContactLeadScoringJobSchema>;

export type ContactLeadScoringJobStatus =
  | "pending_enqueue"
  | "queued"
  | "processing"
  | "completed"
  | "contact_not_found"
  | "failed_terminal"
  | "deferred_queue_unavailable";

// ─── System Audit Runs ────────────────────────────────────────────────────────
export const systemAuditRuns = pgTable("system_audit_runs", {
  id: serial("id").primaryKey(),
  ranAt: timestamp("ran_at", { withTimezone: true }).defaultNow().notNull(),
  overallScore: integer("overall_score"),
  probeResults: jsonb("probe_results"),
  claudeNarrative: text("claude_narrative"),
  slackStatus: text("slack_status").notNull().default("skipped"),
  triggeredBy: text("triggered_by").notNull().default("schedule"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("system_audit_runs_ran_at_idx").on(table.ranAt),
  index("system_audit_runs_triggered_idx").on(table.triggeredBy),
]);

export const insertSystemAuditRunSchema = createInsertSchema(systemAuditRuns).omit({
  id: true,
  createdAt: true,
});

export type SystemAuditRun = typeof systemAuditRuns.$inferSelect;
export type InsertSystemAuditRun = z.infer<typeof insertSystemAuditRunSchema>;

// AI Assistant tables (migration 0084)
export * from "./schema-ai-assistant";

// ---------------------------------------------------------------------------
// Master Lead Database — staged import pipeline (migration 0087)
// Rows land here first (status=staged) before any CRM enrollment/outbound.
// ---------------------------------------------------------------------------
export const masterLeadBatches = pgTable("master_lead_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  batchName: text("batch_name").notNull(),
  sheetId: text("sheet_id"),
  sheetName: text("sheet_name"),
  tabName: text("tab_name"),
  sourceMethod: text("source_method").notNull().default("csv_upload"), // sheets_api | csv_upload
  totalRows: integer("total_rows").default(0),
  stagedCount: integer("staged_count").default(0),
  duplicateCount: integer("duplicate_count").default(0),
  suppressedCount: integer("suppressed_count").default(0),
  invalidCount: integer("invalid_count").default(0),
  promotedCount: integer("promoted_count").default(0),
  readyCount: integer("ready_count").default(0),
  status: text("status").notNull().default("processing"), // processing | completed | failed
  errorMessage: text("error_message"),
  importedBy: text("imported_by"),
  importedAt: timestamp("imported_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type MasterLeadBatch = typeof masterLeadBatches.$inferSelect;
export type InsertMasterLeadBatch = typeof masterLeadBatches.$inferInsert;

// ---------------------------------------------------------------------------
// Inbox Items — ownership / routing metadata for AI inbox entries
// ---------------------------------------------------------------------------
export const inboxItems = pgTable("inbox_items", {
  id: serial("id").primaryKey(),
  // Provider item ID only. The public route key is namespace::sourceItemId.
  sourceItemId: text("source_item_id").notNull(),
  sourceItemType: text("source_item_type").notNull().default("email"), // email|sms|ghl_chat|statement
  // Immutable, server-observed identity/content. The namespace binds provider
  // account/location separately from the provider item ID.
  sourceNamespace: text("source_namespace").default("legacy"),
  providerConversationId: text("provider_conversation_id"),
  sourceBody: text("source_body"),
  sourceReceivedAt: timestamp("source_received_at"),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  ownerId: text("owner_id"),
  ownerName: text("owner_name"),
  department: text("department").default("sales"), // sales|support|onboarding|accounts
  status: text("status").default("new"), // new|in_progress|waiting|resolved|escalated
  priority: text("priority").default("normal"), // low|normal|high|urgent
  slaDueAt: timestamp("sla_due_at"),
  nextAction: text("next_action"),
  escalationPath: text("escalation_path"),
  notes: text("notes"),
  version:integer("version").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("inbox_items_source_identity_uidx").on(sql`COALESCE(${table.sourceNamespace}, 'legacy')`, table.sourceItemId),
  index("inbox_items_status_idx").on(table.status),
  index("inbox_items_contact_id_idx").on(table.contactId),
  index("inbox_items_sla_due_at_idx").on(table.slaDueAt),
]);

export const insertInboxItemSchema = createInsertSchema(inboxItems).omit({ id: true, version:true,createdAt: true, updatedAt: true });
export const inboxActionReceipts=pgTable("inbox_action_receipts",{
  id:uuid("id").primaryKey().defaultRandom(),
  itemId:integer("item_id").notNull().references(()=>inboxItems.id),
  actorId:varchar("actor_id").notNull().references(()=>users.id),
  commandId:uuid("command_id").notNull(),
  payloadHash:text("payload_hash").notNull(),
  result:jsonb("result").notNull(),
  createdAt:timestamp("created_at").notNull().defaultNow(),
},table=>[uniqueIndex("inbox_action_receipts_actor_command_uidx").on(table.actorId,table.commandId)]);
export type InboxItemRow = typeof inboxItems.$inferSelect;
export type InsertInboxItem = z.infer<typeof insertInboxItemSchema>;

// ---------------------------------------------------------------------------
// Statement Reviews — analyst workflow for processing statement reviews
// ---------------------------------------------------------------------------
export const statementReviews = pgTable("statement_reviews", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").references(() => documents.id),
  contactId: integer("contact_id").references(() => contacts.id),
  dealId: integer("deal_id").references(() => deals.id),
  status: text("status").default("received"), // received|in_review|ai_analyzed|reviewed|follow_up_sent|complete
  analystId: text("analyst_id"),
  analystName: text("analyst_name"),
  aiSummary: jsonb("ai_summary"),
  analystNotes: text("analyst_notes"),
  savingsEstimateOverride: text("savings_estimate_override"),
  // Server-derived evidence used for every human-entered savings figure.
  savingsEvidence: jsonb("savings_evidence"),
  followUpDraft: text("follow_up_draft"),
  followUpSentAt: timestamp("follow_up_sent_at"),
  reviewedAt: timestamp("reviewed_at"),
  version: integer("version").notNull().default(0),
  createCommandKey: text("create_command_key"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("statement_reviews_contact_id_idx").on(table.contactId),
  index("statement_reviews_status_idx").on(table.status),
  index("statement_reviews_document_id_idx").on(table.documentId),
  uniqueIndex("statement_reviews_document_identity_uidx").on(table.documentId).where(sql`document_id IS NOT NULL`),
  uniqueIndex("statement_reviews_create_command_key_uidx").on(table.createCommandKey).where(sql`create_command_key IS NOT NULL`),
]);

export const insertStatementReviewSchema = createInsertSchema(statementReviews).omit({ id: true, createdAt: true, updatedAt: true });
export type StatementReview = typeof statementReviews.$inferSelect;
export type InsertStatementReview = z.infer<typeof insertStatementReviewSchema>;

export const masterLeads = pgTable("master_leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  importBatchId: uuid("import_batch_id").references(() => masterLeadBatches.id),
  // Lifecycle status pipeline (text field — not an enum so values can be added without migrations):
  //   staged | imported | duplicate | suppressed | needs_website_check | needs_mx_verification
  //   | ready_for_internal_test | ready_for_controlled_cohort | enrolled | paused
  //   | bounced | unsubscribed | client_customer
  status: text("status").notNull().default("staged"),

  // Source columns (verbatim from sheet / CSV)
  company: text("company"),
  normalizedCompany: text("normalized_company"),
  domain: text("domain"),
  email: text("email"),
  emailType: text("email_type"),
  phone: text("phone"),
  normalizedPhone: text("normalized_phone"),
  contactName: text("contact_name"),
  contactTitle: text("contact_title"),
  vertical: text("vertical"),
  qualityScore: real("quality_score"),
  fitTier: text("fit_tier"),
  outreachReadiness: text("outreach_readiness"),
  readinessReason: text("readiness_reason"),
  source: text("source"),
  sourcePath: text("source_path"),
  sourceModifiedDate: text("source_modified_date"),

  // Address / location (from backfill or enrichment)
  address: text("address"),
  city: text("city"),
  state: text("state"),
  website: text("website"),

  // Channel status flags (set during validation / suppression check)
  emailValid: boolean("email_valid"),   // null=unchecked, true=valid, false=invalid
  phoneValid: boolean("phone_valid"),   // null=unchecked, true=valid, false=invalid
  smsEligible: boolean("sms_eligible"), // false until GHL_PHONE_NUMBER_ID + A2P_REGISTRATION_ID set

  // Provenance
  sheetId: text("sheet_id"),
  sheetName: text("sheet_name"),
  tabName: text("tab_name"),
  rowNumber: integer("row_number"),

  // Dedup / suppression metadata
  canonicalLeadId: uuid("canonical_lead_id"),
  duplicateOfId: uuid("duplicate_of_id").references((): any => masterLeads.id),
  suppressionReason: text("suppression_reason"),

  // Promotion tracking (ready_for_internal_test → ready_for_controlled_cohort requires admin click)
  promotedAt: timestamp("promoted_at"),
  promotedBy: text("promoted_by"),

  // Admin notes
  notes: text("notes"),

  importedAt: timestamp("imported_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),

  // ── MI-07: Pipeline columns (added in migration 0257) ──────────────────────
  // Discriminator: 'manual_import' (default) | 'cro03_pipeline' | 'sfp_pipeline'
  // (Task #2001: 'sfp_pipeline' rows are written by stageForCampaign() and are
  // structurally excluded from the MI-07 cro03_pipeline promotion path — see
  // server/services/master-leads/pipeline-promotion.ts.)
  pipelineOrigin: text("pipeline_origin").notNull().default("manual_import"),
  // FK to businesses.id — set only for cro03_pipeline rows
  canonicalBusinessId: integer("canonical_business_id"),
  // FK to cro03c_generations.id (UUID) — set only for cro03_pipeline rows
  cro03GenerationId: uuid("cro03_generation_id"),
  // MI-09: originating pilot run for governed pipeline rows. Manual imports and
  // backfills intentionally leave this NULL.
  pilotRunId: uuid("pilot_run_id"),
  // SHA-256 hex hash of normalised email — used for dedup; never plaintext
  emailTokenHash: text("email_token_hash"),
  // County FIPS from business_locations
  countyFips: text("county_fips"),
  // Masked email display (e.g. j***@example.com) for pipeline rows
  maskedEmail: text("masked_email"),
  // Timestamp when pipeline row was suppressed by admin
  suppressedAt: timestamp("suppressed_at", { withTimezone: true }),
  // FK to contacts.id after successful pipeline promotion
  promotedContactId: integer("promoted_contact_id"),
  // Updated timestamp for pipeline mutations
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (table) => [
  index("master_leads_batch_id_idx").on(table.importBatchId),
  index("master_leads_domain_idx").on(table.domain),
  index("master_leads_email_idx").on(table.email),
  index("master_leads_status_idx").on(table.status),
  index("master_leads_status_source_idx").on(table.status, table.source),
  index("master_leads_vertical_idx").on(table.vertical),
  index("master_leads_fit_tier_idx").on(table.fitTier),
  index("master_leads_promoted_at_idx").on(table.promotedAt),
  index("master_leads_pipeline_origin_idx").on(table.pipelineOrigin),
  index("master_leads_canonical_business_id_idx").on(table.canonicalBusinessId),
  index("master_leads_pilot_run_id_idx").on(table.pilotRunId),
  uniqueIndex("master_leads_sfp_business_email_uidx")
    .on(table.canonicalBusinessId, table.emailTokenHash)
    .where(sql`pipeline_origin = 'sfp_pipeline' AND canonical_business_id IS NOT NULL AND email_token_hash IS NOT NULL`),
]);

export type MasterLead = typeof masterLeads.$inferSelect;
export type InsertMasterLead = typeof masterLeads.$inferInsert;

// ── MI-07: master_lead_staging_intents ───────────────────────────────────────
// Durable outbox — one row per (canonical_business_id, cro03_generation_id).
// Written atomically by writeBusinessValidationResult() when provider_valid.
// Consumed by master-lead-stager.worker.ts BullMQ worker.
export const masterLeadStagingIntents = pgTable("master_lead_staging_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  canonicalBusinessId: integer("canonical_business_id").references(() => businesses.id).notNull(),
  cro03GenerationId: uuid("cro03_generation_id").notNull(),
  status: text("status").notNull().default("pending"), // pending | consumed | failed
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("master_lead_staging_intents_status_idx").on(table.status),
  index("master_lead_staging_intents_business_idx").on(table.canonicalBusinessId),
]);

export type MasterLeadStagingIntent = typeof masterLeadStagingIntents.$inferSelect;
export type InsertMasterLeadStagingIntent = typeof masterLeadStagingIntents.$inferInsert;

// ── MI-07: master_lead_staging_receipts ──────────────────────────────────────
// One receipt per (cro03_generation_id, canonical_business_id).
// Source of truth for disposition — generation totals derived from here.
export const masterLeadStagingReceipts = pgTable("master_lead_staging_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  cro03GenerationId: uuid("cro03_generation_id").notNull(),
  canonicalBusinessId: integer("canonical_business_id").references(() => businesses.id).notNull(),
  masterLeadId: uuid("master_lead_id"), // NULL for duplicate/suppressed
  // MI-09: originating pilot run, resolved from the CRO-03C generation.
  pilotRunId: uuid("pilot_run_id"),
  disposition: text("disposition").notNull(), // staged | duplicate | suppressed | failed
  suppressionReason: text("suppression_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("master_lead_staging_receipts_gen_biz_uidx").on(table.cro03GenerationId, table.canonicalBusinessId),
  index("master_lead_staging_receipts_generation_idx").on(table.cro03GenerationId),
  index("master_lead_staging_receipts_master_lead_idx").on(table.masterLeadId),
  index("master_lead_staging_receipts_pilot_run_idx").on(table.pilotRunId),
]);

export type MasterLeadStagingReceipt = typeof masterLeadStagingReceipts.$inferSelect;
export type InsertMasterLeadStagingReceipt = typeof masterLeadStagingReceipts.$inferInsert;

// ── MI-07: master_lead_generation_batches ────────────────────────────────────
// Per-generation totals computed from receipts at reconciliation time.
export const masterLeadGenerationBatches = pgTable("master_lead_generation_batches", {
  id: serial("id").primaryKey(),
  cro03GenerationId: uuid("cro03_generation_id").notNull().unique(),
  totalSubmitted: integer("total_submitted").notNull().default(0),
  stagedCount: integer("staged_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  suppressedCount: integer("suppressed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("master_lead_generation_batches_generation_idx").on(table.cro03GenerationId),
]);

export type MasterLeadGenerationBatch = typeof masterLeadGenerationBatches.$inferSelect;
export type InsertMasterLeadGenerationBatch = typeof masterLeadGenerationBatches.$inferInsert;

// ── Agent Payout Ledger ────────────────────────────────────────────────────────
export const agentPayouts = pgTable("agent_payouts", {
  id: serial("id").primaryKey(),
  agentUserId: varchar("agent_user_id").references(() => users.id).notNull(),
  // partnerUserId is kept for future use when partner org members have platform user accounts.
  // For now, use partnerOrgId to identify the partner organization that earned partnerShare.
  partnerUserId: varchar("partner_user_id").references(() => users.id),
  // Links to the partner organization responsible for this period's partnerShare.
  // Resolved at generation time via merchantResiduals.dealId -> deals.partnerOrgId.
  partnerOrgId: integer("partner_org_id").references(() => partnerOrganizations.id),
  periodMonth: text("period_month").notNull(),
  grossResidual: text("gross_residual").notNull().default("0"),
  agentShare: text("agent_share").notNull().default("0"),
  partnerShare: text("partner_share").notNull().default("0"),
  status: text("status").notNull().default("pending"), // pending | approved | paid
  paidAt: timestamp("paid_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  // Partial unique indexes: one row per (agent, month) when no partner,
  // one row per (agent, month, partnerOrg) when a partner is present.
  // (The old single unique constraint on (agentUserId, periodMonth) was dropped in migration 0101.)
  index("agent_payouts_agent_user_id_idx").on(table.agentUserId),
  index("agent_payouts_status_idx").on(table.status),
  index("agent_payouts_partner_org_idx").on(table.partnerOrgId),
]);

export const insertAgentPayoutSchema = createInsertSchema(agentPayouts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type AgentPayout = typeof agentPayouts.$inferSelect;
export type InsertAgentPayout = z.infer<typeof insertAgentPayoutSchema>;

// ---------------------------------------------------------------------------
// Executive Weekly Snapshots — weekly KPI roll-up with AI narratives
// ---------------------------------------------------------------------------
export const executiveWeeklySnapshots = pgTable("executive_weekly_snapshots", {
  id: serial("id").primaryKey(),
  weekStart: text("week_start").notNull().unique(),
  closedWonRevenue: numeric("closed_won_revenue", { precision: 14, scale: 2 }).default("0"),
  grossProfit: numeric("gross_profit", { precision: 14, scale: 2 }).default("0"),
  netProfit: numeric("net_profit", { precision: 14, scale: 2 }).default("0"),
  grossMarginPct: numeric("gross_margin_pct", { precision: 6, scale: 2 }).default("0"),
  netMarginPct: numeric("net_margin_pct", { precision: 6, scale: 2 }).default("0"),
  pipelineValue: numeric("pipeline_value", { precision: 14, scale: 2 }).default("0"),
  newDealsClosed: integer("new_deals_closed").default(0),
  proposalsSent: integer("proposals_sent").default(0),
  statementsReceived: integer("statements_received").default(0),
  meetingsBooked: integer("meetings_booked").default(0),
  outreachAttempts: integer("outreach_attempts").default(0),
  perRepBreakdown: jsonb("per_rep_breakdown"),
  goalsVsActuals: jsonb("goals_vs_actuals"),
  gptBriefing: text("gpt_briefing"),
  claudeCoaching: jsonb("claude_coaching"),
  generatedAt: timestamp("generated_at"),
  trigger: text("trigger").default("schedule"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("exec_snapshots_week_start_idx").on(table.weekStart),
]);

export const insertExecutiveWeeklySnapshotSchema = createInsertSchema(executiveWeeklySnapshots).omit({
  id: true,
  createdAt: true,
});
export type ExecutiveWeeklySnapshot = typeof executiveWeeklySnapshots.$inferSelect;

export type InsertExecutiveWeeklySnapshot = z.infer<typeof insertExecutiveWeeklySnapshotSchema>;
export const executiveGoals = pgTable("executive_goals", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  value: numeric("value", { precision: 14, scale: 2 }).notNull(),
  periodType: text("period_type").notNull().default("weekly"),
  setBy: text("set_by"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("executive_goals_key_period_idx").on(table.key, table.periodType),
]);

export const insertExecutiveGoalSchema = createInsertSchema(executiveGoals).omit({ id: true });
export type ExecutiveGoal = typeof executiveGoals.$inferSelect;

// ---------------------------------------------------------------------------
// Automation Registry — one row per BullMQ queue / scheduled automation.
// Allows operators to see status, last-run metrics, and kill-switch each one.
// ---------------------------------------------------------------------------
export const automationRegistry = pgTable("automation_registry", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  title: text("title"),
  triggerDescription: text("trigger_description"),
  status: text("status").notNull().default("active"),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),
  lastRunRecordsAffected: integer("last_run_records_affected"),
  lastRunErrors: integer("last_run_errors"),
  killSwitchEnabled: boolean("kill_switch_enabled").notNull().default(false),
  owner: text("owner"),
  version: text("version"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAutomationRegistrySchema = createInsertSchema(automationRegistry).omit({
  id: true,
  updatedAt: true,
});

export type AutomationRegistry = typeof automationRegistry.$inferSelect;
export type InsertAutomationRegistry = z.infer<typeof insertAutomationRegistrySchema>;

// ---------------------------------------------------------------------------
// Contact NBA — Next Best Action Engine
// One active recommendation per contact (UPSERT on contact_id).
// ---------------------------------------------------------------------------
export const contactNba = pgTable("contact_nba", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),

  actionType: text("action_type").notNull(),
  channel: text("channel"),
  ownerRole: text("owner_role"),

  dueAt: timestamp("due_at"),
  urgency: text("urgency").notNull().default("normal"),
  expiresAt: timestamp("expires_at"),

  reasonCode: text("reason_code").notNull(),
  explanation: text("explanation"),
  confidence: integer("confidence"),
  ruleVersion: text("rule_version"),
  modelVersion: text("model_version"),
  evidence: jsonb("evidence"),

  opportunityValueCents: integer("opportunity_value_cents"),
  automationEligible: boolean("automation_eligible").notNull().default(false),
  humanRequired: boolean("human_required").notNull().default(false),

  status: text("status").notNull().default("OPEN"),
  generatedAt: timestamp("generated_at").defaultNow(),
  executedAt: timestamp("executed_at"),
  dismissedAt: timestamp("dismissed_at"),
  dismissedBy: text("dismissed_by"),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("contact_nba_contact_id_unique").on(table.contactId),
  index("contact_nba_status_urgency_idx").on(table.status, table.urgency),
  index("contact_nba_due_at_idx").on(table.dueAt),
]);

export const insertContactNbaSchema = createInsertSchema(contactNba).omit({ id: true, generatedAt: true, updatedAt: true });
export type ContactNba = typeof contactNba.$inferSelect;
export type InsertContactNba = z.infer<typeof insertContactNbaSchema>;

// ---------------------------------------------------------------------------
// NBA Recommendation History — audit trail of superseded recommendations
// ---------------------------------------------------------------------------
export const nbaRecommendationHistory = pgTable("nba_recommendation_history", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),

  actionType: text("action_type").notNull(),
  channel: text("channel"),
  ownerRole: text("owner_role"),
  dueAt: timestamp("due_at"),
  urgency: text("urgency").notNull(),
  expiresAt: timestamp("expires_at"),
  reasonCode: text("reason_code").notNull(),
  explanation: text("explanation"),
  confidence: integer("confidence"),
  ruleVersion: text("rule_version"),
  modelVersion: text("model_version"),
  evidence: jsonb("evidence"),
  opportunityValueCents: integer("opportunity_value_cents"),
  automationEligible: boolean("automation_eligible").notNull().default(false),
  humanRequired: boolean("human_required").notNull().default(false),
  status: text("status").notNull(),
  generatedAt: timestamp("generated_at").notNull(),
  executedAt: timestamp("executed_at"),
  dismissedAt: timestamp("dismissed_at"),
  dismissedBy: text("dismissed_by"),

  supersededAt: timestamp("superseded_at").defaultNow(),
  supersededReason: text("superseded_reason"),
}, (table) => [
  index("nba_history_contact_id_idx").on(table.contactId),
  index("nba_history_generated_at_idx").on(table.generatedAt),
]);

export type NbaRecommendationHistory = typeof nbaRecommendationHistory.$inferSelect;

// ─── Merchant MID Registry (#1404) ───────────────────────────────────────────
export const merchantMids = pgTable("merchant_mids", {
  id:               serial("id").primaryKey(),
  contactId:        integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  dealId:           integer("deal_id").references(() => deals.id),
  mid:              text("mid").notNull(),
  tids:             text("tids").array().notNull().default(sql`'{}'::text[]`),
  processorName:    text("processor_name").notNull().default("payarc"),
  status:           text("status").notNull().default("assigned"),
  monthlyVolumeCap: numeric("monthly_volume_cap"),
  assignedAt:       timestamp("assigned_at").notNull().defaultNow(),
  activatedAt:      timestamp("activated_at"),
  suspendedAt:      timestamp("suspended_at"),
  closedAt:         timestamp("closed_at"),
  suspensionReason: text("suspension_reason"),
  notes:            text("notes"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
  updatedAt:        timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_merchant_mids_mid").on(t.mid),
  index("idx_merchant_mids_contact_id").on(t.contactId),
  index("idx_merchant_mids_deal_id").on(t.dealId),
]);

export const insertMerchantMidSchema = createInsertSchema(merchantMids).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type MerchantMid = typeof merchantMids.$inferSelect;
export type InsertMerchantMid = z.infer<typeof insertMerchantMidSchema>;

// ─── Processor Activation Snapshots (REV-05A) ────────────────────────────────
// Transport is fail-closed until a row with status='owner_confirmed' or higher
// exists. Owner must confirm program, entitlements, and authorized endpoints.
export const processorActivationSnapshots = pgTable("processor_activation_snapshots", {
  id:                    serial("id").primaryKey(),
  processorName:         text("processor_name").notNull(),
  processorProgram:      text("processor_program").notNull(),  // 'traditional' | 'payfac'
  sandboxEntitlement:    boolean("sandbox_entitlement").notNull().default(false),
  productionEntitlement: boolean("production_entitlement").notNull().default(false),
  authorizedBaseUrl:     text("authorized_base_url"),
  supportedOperations:   jsonb("supported_operations").notNull().default(sql`'[]'::jsonb`),
  ownerConfirmedAt:      timestamp("owner_confirmed_at", { withTimezone: true }),
  ownerConfirmedBy:      text("owner_confirmed_by"),
  status:                text("status").notNull().default("pending"),
  // pending | owner_confirmed | sandbox_verified | production_authorized | expired_or_drifted | held
  notes:                 text("notes"),
  createdAt:             timestamp("created_at").notNull().defaultNow(),
  updatedAt:             timestamp("updated_at").notNull().defaultNow(),
});
export type ProcessorActivationSnapshot = typeof processorActivationSnapshots.$inferSelect;

// ─── Merchant MID Access Receipts (REV-05A) ───────────────────────────────────
// Every full-MID read from a role-authorized endpoint writes a receipt here.
// Public/list/search/task/notification/log/audit/metric responses must omit or mask.
export const merchantMidAccessReceipts = pgTable("merchant_mid_access_receipts", {
  id:         serial("id").primaryKey(),
  midId:      integer("mid_id").notNull(),
  contactId:  integer("contact_id"),
  userId:     text("user_id"),
  endpoint:   text("endpoint").notNull(),
  purpose:    text("purpose").notNull().default("manual_lookup"),
  accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
});
export type MerchantMidAccessReceipt = typeof merchantMidAccessReceipts.$inferSelect;

// ─── Equipment Shipments (#1404) ─────────────────────────────────────────────
export const equipmentShipments = pgTable("equipment_shipments", {
  id:                serial("id").primaryKey(),
  contactId:         integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  dealId:            integer("deal_id").references(() => deals.id),
  equipmentOrderId:  integer("equipment_order_id"),
  deviceType:        text("device_type"),
  serialNumber:      text("serial_number"),
  carrier:           text("carrier"),
  trackingNumber:    text("tracking_number"),
  status:            text("status").notNull().default("pending"),
  shippedAt:         timestamp("shipped_at"),
  estimatedDelivery: timestamp("estimated_delivery"),
  deliveredAt:       timestamp("delivered_at"),
  notes:             text("notes"),
  createdAt:         timestamp("created_at").notNull().defaultNow(),
  updatedAt:         timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("idx_equipment_shipments_contact_id").on(t.contactId),
  index("idx_equipment_shipments_deal_id").on(t.dealId),
]);

export const insertEquipmentShipmentSchema = createInsertSchema(equipmentShipments).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type EquipmentShipment = typeof equipmentShipments.$inferSelect;
export type InsertEquipmentShipment = z.infer<typeof insertEquipmentShipmentSchema>;

// ─── Save Cases (#1407) ──────────────────────────────────────────────────────
export const saveCases = pgTable("save_cases", {
  id:                   serial("id").primaryKey(),
  contactId:            integer("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  dealId:               integer("deal_id").references(() => deals.id),
  healthAlertId:        integer("health_alert_id").references(() => healthAlerts.id),
  churnScore:           integer("churn_score"),
  riskTier:             text("risk_tier").notNull(),
  triggerSignals:       jsonb("trigger_signals").notNull().default(sql`'[]'::jsonb`),
  status:               text("status").notNull().default("open"),
  assignedTo:           text("assigned_to"),
  outcome:              text("outcome"),
  outcomeNotes:         text("outcome_notes"),
  playbookDay:          integer("playbook_day").notNull().default(0),
  escalationLevel:      integer("escalation_level").notNull().default(0),
  day2EmailSent:        boolean("day2_email_sent").notNull().default(false),
  day5ManagerNotified:  boolean("day5_manager_notified").notNull().default(false),
  day10ExecNotified:    boolean("day10_exec_notified").notNull().default(false),
  lastActivityAt:       timestamp("last_activity_at"),
  resolvedAt:           timestamp("resolved_at"),
  createdAt:            timestamp("created_at").notNull().defaultNow(),
  updatedAt:            timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("idx_save_cases_contact_id").on(t.contactId),
  index("idx_save_cases_status").on(t.status),
]);

export const insertSaveCaseSchema = createInsertSchema(saveCases).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type SaveCase = typeof saveCases.$inferSelect;
export type InsertSaveCase = z.infer<typeof insertSaveCaseSchema>;

// ─── Entity Memory (#1408) ────────────────────────────────────────────────────
export const entityMemory = pgTable("entity_memory", {
  id:            serial("id").primaryKey(),
  entityType:    text("entity_type").notNull(),
  entityId:      integer("entity_id").notNull(),
  factKey:       text("fact_key").notNull(),
  factValue:     jsonb("fact_value").notNull(),
  source:        text("source").notNull().default("system"),
  confidence:    real("confidence"),
  sourceEventId: integer("source_event_id"),
  version:       integer("version").notNull().default(1),
  lastUpdatedAt: timestamp("last_updated_at").notNull().defaultNow(),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_entity_memory_upsert").on(t.entityType, t.entityId, t.factKey),
  index("idx_entity_memory_entity").on(t.entityType, t.entityId),
]);
export type EntityMemory = typeof entityMemory.$inferSelect;

// ─── AI Decision Log (#1408) ──────────────────────────────────────────────────
export const aiDecisionLog = pgTable("ai_decision_log", {
  id:             serial("id").primaryKey(),
  decisionType:   text("decision_type").notNull(),
  contactId:      integer("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  dealId:         integer("deal_id").references(() => deals.id, { onDelete: "set null" }),
  model:          text("model"),
  promptKey:      text("prompt_key"),
  promptVersion:  text("prompt_version"),
  inputSummary:   jsonb("input_summary").notNull().default(sql`'{}'::jsonb`),
  decisionOutput: jsonb("decision_output").notNull().default(sql`'{}'::jsonb`),
  confidence:     real("confidence"),
  confidenceTier: text("confidence_tier"),
  wasOverridden:  boolean("was_overridden").notNull().default(false),
  overrideReason: text("override_reason"),
  outcome:        text("outcome"),
  tokensUsed:     integer("tokens_used"),
  costCents:      real("cost_cents"),
  durationMs:     integer("duration_ms"),
  sourceEventId:  integer("source_event_id"),
  flagged:        boolean("flagged").notNull().default(false),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("idx_ai_decision_log_contact_id").on(t.contactId),
  index("idx_ai_decision_log_decision_type").on(t.decisionType),
  index("idx_ai_decision_log_created_at").on(t.createdAt),
]);
export const insertAiDecisionLogSchema = createInsertSchema(aiDecisionLog).omit({ id: true, createdAt: true });
export type AiDecisionLog = typeof aiDecisionLog.$inferSelect;
export type InsertAiDecisionLog = z.infer<typeof insertAiDecisionLogSchema>;

// ─── AI Corrections (#1409) ───────────────────────────────────────────────────
export const aiCorrections = pgTable("ai_corrections", {
  id:               serial("id").primaryKey(),
  decisionLogId:    integer("decision_log_id").references(() => aiDecisionLog.id, { onDelete: "set null" }),
  contactId:        integer("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
  decisionType:     text("decision_type").notNull(),
  originalValue:    jsonb("original_value").notNull(),
  correctedValue:   jsonb("corrected_value").notNull(),
  correctionReason: text("correction_reason"),
  correctedBy:      text("corrected_by"),
  sessionId:        text("session_id"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("idx_ai_corrections_decision_type").on(t.decisionType),
  index("idx_ai_corrections_created_at").on(t.createdAt),
  index("idx_ai_corrections_contact_id").on(t.contactId),
]);
export const insertAiCorrectionSchema = createInsertSchema(aiCorrections).omit({ id: true, createdAt: true });
export type AiCorrection = typeof aiCorrections.$inferSelect;
export type InsertAiCorrection = z.infer<typeof insertAiCorrectionSchema>;

// ─── Prompt Versions (#1409) ─────────────────────────────────────────────────
export const promptVersions = pgTable("prompt_versions", {
  id:            serial("id").primaryKey(),
  promptKey:     text("prompt_key").notNull(),
  version:       text("version").notNull(),
  promptText:    text("prompt_text").notNull(),
  modelId:       text("model_id"),
  effectiveFrom: timestamp("effective_from").notNull().defaultNow(),
  effectiveTo:   timestamp("effective_to"),
  deployedBy:    text("deployed_by"),
  notes:         text("notes"),
  createdAt:     timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_prompt_versions_key_version").on(t.promptKey, t.version),
  index("idx_prompt_versions_key_active").on(t.promptKey, t.effectiveFrom),
]);
export type PromptVersion = typeof promptVersions.$inferSelect;

// ─── Golden Examples (#1409) ─────────────────────────────────────────────────
export const goldenExamples = pgTable("golden_examples", {
  id:             serial("id").primaryKey(),
  decisionType:   text("decision_type").notNull(),
  inputSnapshot:  jsonb("input_snapshot").notNull(),
  expectedOutput: jsonb("expected_output").notNull(),
  source:         text("source").notNull().default("human_label"),
  label:          text("label"),
  active:         boolean("active").notNull().default(true),
  createdBy:      text("created_by"),
  createdAt:      timestamp("created_at").notNull().defaultNow(),
  updatedAt:      timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("idx_golden_examples_decision_type").on(t.decisionType),
]);
export type GoldenExample = typeof goldenExamples.$inferSelect;

export type InsertExecutiveGoal = z.infer<typeof insertExecutiveGoalSchema>;

// ─── Outbound Pause Control Authority (#1531) ─────────────────────────────────

export const outboundPauseControl = pgTable("outbound_pause_control", {
  id:              serial("id").primaryKey(),
  state:           text("state").notNull(),       // 'paused' | 'activating' | 'unpaused'
  reason:          text("reason"),
  epoch:           bigint("epoch", { mode: "bigint" }).notNull().default(sql`1`),
  actor:           text("actor"),
  idempotencyKey:  text("idempotency_key"),
  committedAt:     timestamp("committed_at", { withTimezone: true }).defaultNow(),
});

export type OutboundPauseControl = typeof outboundPauseControl.$inferSelect;

// ─── Serper Canonical Gateway Control (#1600) ────────────────────────────────
// Singleton row (id=1). All Serper API calls flow through SerperGateway which
// reads/writes this row atomically (fail-closed when missing or malformed).
export const serperControl = pgTable("serper_control", {
  id:                      integer("id").primaryKey(),
  enabled:                 boolean("enabled").notNull().default(false),
  state:                   text("state").notNull().default("closed"), // 'closed' | 'open' | 'half_open'
  consecutiveFailures:     integer("consecutive_failures").notNull().default(0),
  openedAt:                timestamp("opened_at", { withTimezone: true }),
  reasonCode:              text("reason_code"),
  lastFailureAt:           timestamp("last_failure_at", { withTimezone: true }),
  lastSuccessAt:           timestamp("last_success_at", { withTimezone: true }),
  halfOpenProbeClaimedAt:  timestamp("half_open_probe_claimed_at", { withTimezone: true }),
  policyVersion:           integer("policy_version").notNull().default(1),
  lifetimeCalls:           bigint("lifetime_calls", { mode: "number" }).notNull().default(0),
  lifetimeSuccesses:       bigint("lifetime_successes", { mode: "number" }).notNull().default(0),
  lifetimeFailures:        bigint("lifetime_failures", { mode: "number" }).notNull().default(0),
  windowCalls:             integer("window_calls").notNull().default(0),
  windowSuccesses:         integer("window_successes").notNull().default(0),
  windowFailures:          integer("window_failures").notNull().default(0),
  windowStartedAt:         timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
  windowEndsAt:            timestamp("window_ends_at", { withTimezone: true }).notNull(),
  // localBudget is a raw API-call ceiling for the current billing window —
  // the SAME unit as windowCalls (1 increment == 1 Serper API call). Never
  // populate this column with a dollar/spend figure; readers (SerperGateway,
  // the SFP arm-pilot readiness gate, admin dashboards) all assume calls.
  localBudget:             integer("local_budget").notNull().default(50000),
  providerBalance:         integer("provider_balance"),
  yieldWebsites:           bigint("yield_websites", { mode: "number" }).notNull().default(0),
  yieldEmails:             bigint("yield_emails", { mode: "number" }).notNull().default(0),
  yieldPhones:             bigint("yield_phones", { mode: "number" }).notNull().default(0),
  updatedAt:               timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SerperControl = typeof serperControl.$inferSelect;

// ─── Serper Per-Call Usage Log (Task #2003) ──────────────────────────────────
// One row per SerperGateway.executeSearch() attempt (success, provider
// failure, or gateway block). Written best-effort from inside the gateway —
// a logging failure must never block or fail the underlying search call.
// Lets usage be broken down by day and by caller, unlike the single
// aggregate serper_control row which only tracks the current billing window.
export const serperCallLog = pgTable("serper_call_log", {
  id:          serial("id").primaryKey(),
  callSite:    text("call_site").notNull(),
  endpoint:    text("endpoint").notNull(), // '/search' | '/places'
  outcome:     text("outcome").notNull(), // 'success' | 'provider_error' | 'blocked'
  blockReason: text("block_reason"), // set only when outcome = 'blocked'
  httpStatus:  integer("http_status"),
  errorText:   text("error_text"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  createdAtIdx: index("serper_call_log_created_at_idx").on(table.createdAt),
  callSiteIdx:  index("serper_call_log_call_site_idx").on(table.callSite, table.createdAt),
}));

export type SerperCallLog = typeof serperCallLog.$inferSelect;

export const outboundPauseAudit = pgTable("outbound_pause_audit", {
  id:            serial("id").primaryKey(),
  epoch:         bigint("epoch", { mode: "bigint" }).notNull(),
  changeType:    text("change_type").notNull(),   // 'state-transition' | 'metadata-revision' | 'idempotent-return'
  fromState:     text("from_state").notNull(),
  toState:       text("to_state").notNull(),
  actor:         text("actor"),
  correlationId: text("correlation_id"),
  reason:        text("reason"),
  details:       jsonb("details"),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [
  index("outbound_pause_audit_epoch_idx").on(t.epoch),
  index("outbound_pause_audit_created_at_idx").on(t.createdAt),
]);

export type OutboundPauseAudit = typeof outboundPauseAudit.$inferSelect;

// ─── ZeroBounce Durable Batch Campaign Engine (#1541 / 1540B) ─────────────────

export const zerobounceCampaigns = pgTable("zerobounce_campaigns", {
  id:                   varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  filterDefinition:     jsonb("filter_definition").notNull().default(sql`'{}'::jsonb`),
  initialEligibleTotal: integer("initial_eligible_total").notNull().default(0),
  status:               text("status").notNull().default("active"), // active | completed | cancelled
  createdBy:            text("created_by"),
  createdAt:            timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:            timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt:          timestamp("completed_at", { withTimezone: true }),
});
export type ZerobounceCampaign = typeof zerobounceCampaigns.$inferSelect;

export const zerobounceRuns = pgTable("zerobounce_runs", {
  id:              varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId:      varchar("campaign_id").notNull().references(() => zerobounceCampaigns.id, { onDelete: "cascade" }),
  bullJobId:       text("bull_job_id"),
  // running | completed | budget_stopped | cancelled | interrupted | error
  state:           text("state").notNull().default("running"),
  stopReason:      text("stop_reason"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  contactLimit:    integer("contact_limit").notNull().default(100),
  claimedCount:    integer("claimed_count").notNull().default(0),
  completedCount:  integer("completed_count").notNull().default(0),
  retryableCount:  integer("retryable_count").notNull().default(0),
  skippedCount:    integer("skipped_count").notNull().default(0),
  errorCount:      integer("error_count").notNull().default(0),
  validCount:      integer("valid_count").notNull().default(0),
  blockedCount:    integer("blocked_count").notNull().default(0),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  startedAt:       timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt:      timestamp("finished_at", { withTimezone: true }),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("zb_runs_campaign_idx").on(t.campaignId, t.createdAt),
]);
export type ZerobounceRun = typeof zerobounceRuns.$inferSelect;

export const zerobounceAttempts = pgTable("zerobounce_attempts", {
  id:             bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  campaignId:     varchar("campaign_id").notNull().references(() => zerobounceCampaigns.id, { onDelete: "cascade" }),
  runId:          varchar("run_id").notNull().references(() => zerobounceRuns.id, { onDelete: "cascade" }),
  contactId:      integer("contact_id").notNull(),
  // pending | completed | retryable_failed | skipped
  outcome:        text("outcome").notNull().default("pending"),
  providerStatus: text("provider_status"),
  subStatus:      text("sub_status"),
  // none | reserved — 'reserved' is a LOCAL daily-cap reservation, NOT confirmed provider billing
  creditState:    text("credit_state").notNull().default("none"),
  retryable:      boolean("retryable").notNull().default(false),
  errorCode:      text("error_code"),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("zb_attempts_campaign_contact_idx").on(t.campaignId, t.contactId),
  index("zb_attempts_run_idx").on(t.runId),
]);
export type ZerobounceAttempt = typeof zerobounceAttempts.$inferSelect;

// ─── Logical Job Control Holds (#1532) ───────────────────────────────────────

export const logicalJobControlHolds = pgTable("logical_job_control_holds", {
  holdId:        varchar("hold_id").primaryKey().default(sql`gen_random_uuid()`),
  logicalJobKey: text("logical_job_key").notNull(),
  reasonCode:    text("reason_code").notNull(), // global_outbound | manual_operator | maintenance | incident | automation_kill_switch | channel_pause
  sourceType:    text("source_type").notNull(), // system | operator | automation | channel
  sourceKey:     text("source_key").notNull(),  // owner identity
  sourceEpoch:   bigint("source_epoch", { mode: "bigint" }),
  ledgerEpoch:   bigint("ledger_epoch", { mode: "bigint" }).notNull(),
  active:        boolean("active").notNull().default(true),
  activatedAt:   timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt:    timestamp("released_at", { withTimezone: true }),
  expiresAt:     timestamp("expires_at", { withTimezone: true }),
  actor:         text("actor"),
  correlationId: text("correlation_id"),
  metadata:      jsonb("metadata"),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("logical_job_holds_active_key_idx").on(t.logicalJobKey).where(sql`${t.active} = true`),
  index("logical_job_holds_expires_idx").on(t.expiresAt).where(sql`${t.active} = true AND ${t.expiresAt} IS NOT NULL`),
]);

export type LogicalJobControlHold = typeof logicalJobControlHolds.$inferSelect;
export type InsertLogicalJobControlHold = typeof logicalJobControlHolds.$inferInsert;

export const logicalJobHoldEvents = pgTable("logical_job_hold_events", {
  id:            bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  holdId:        varchar("hold_id").notNull(),
  eventType:     text("event_type").notNull(), // activated | released | expired | superseded
  logicalJobKey: text("logical_job_key").notNull(),
  reasonCode:    text("reason_code").notNull(),
  sourceKey:     text("source_key").notNull(),
  ledgerEpoch:   bigint("ledger_epoch", { mode: "bigint" }).notNull(),
  actor:         text("actor"),
  correlationId: text("correlation_id"),
  metadata:      jsonb("metadata"),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("hold_events_hold_id_idx").on(t.holdId),
  index("hold_events_created_at_idx").on(t.createdAt),
  index("hold_events_logical_job_key_idx").on(t.logicalJobKey, t.createdAt),
]);

export type LogicalJobHoldEvent = typeof logicalJobHoldEvents.$inferSelect;

export const queueReconciliationState = pgTable("queue_reconciliation_state", {
  physicalQueue:  text("physical_queue").primaryKey(),
  desiredState:   text("desired_state"),   // 'paused' | 'running'
  desiredEpoch:   bigint("desired_epoch", { mode: "bigint" }),
  observedState:  text("observed_state"),  // 'paused' | 'running' | null
  observedEpoch:  bigint("observed_epoch", { mode: "bigint" }),
  reconciledAt:   timestamp("reconciled_at", { withTimezone: true }),
  lastAttemptAt:  timestamp("last_attempt_at", { withTimezone: true }),
  lastError:      text("last_error"),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type QueueReconciliationState = typeof queueReconciliationState.$inferSelect;

export const postEnrichmentEnrollmentIntents = pgTable("post_enrichment_enrollment_intents", {
  id:                     bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  dealId:                 integer("deal_id").notNull(),
  contactId:              integer("contact_id").notNull(),
  entityId:               integer("entity_id"),
  idempotencyKey:         text("idempotency_key").notNull().unique(),
  status:                 text("status").notNull().default("pending"), // pending | processing | completed | failed | cancelled
  attempts:               integer("attempts").notNull().default(0),
  lastError:              text("last_error"),
  createdAt:              timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:              timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt:            timestamp("processed_at", { withTimezone: true }),
  eligibleAfter:          timestamp("eligible_after", { withTimezone: true }),
  // ── 0138: Transactional intent fields ─────────────────────────────────────
  // sequenceId: nullable in DB (pre-0138 rows may be null/failed); app always sets on new rows
  sequenceId:             integer("sequence_id"),
  purpose:                varchar("purpose", { length: 100 }),
  channels:               jsonb("channels").$type<string[]>(),
  selectionPolicyVersion: varchar("selection_policy_version", { length: 50 }),
  selectionSnapshot:      jsonb("selection_snapshot").$type<Record<string, unknown>>(),
  // Claim/lease fields for exactly-once processing
  claimToken:             uuid("claim_token"),
  claimedAt:              timestamp("claimed_at", { withTimezone: true }),
  leaseExpiresAt:         timestamp("lease_expires_at", { withTimezone: true }),
  claimedBy:              varchar("claimed_by", { length: 100 }),
  maxAttempts:            integer("max_attempts").notNull().default(5),
  // Terminal outcome classification
  lastErrorCode:          varchar("last_error_code", { length: 100 }),
  lastErrorClass:         varchar("last_error_class", { length: 50 }), // retryable | permanent | terminal_no_op
  completedEnrollmentId:  integer("completed_enrollment_id"),
}, (t) => [
  index("pe_intents_pending_idx").on(t.status, t.eligibleAfter).where(sql`${t.status} = 'pending'`),
  index("pe_intents_deal_idx").on(t.dealId),
  index("pe_intents_claim_idx").on(t.status, t.leaseExpiresAt).where(sql`${t.status} IN ('pending', 'processing')`),
]);

export type PostEnrichmentEnrollmentIntent = typeof postEnrichmentEnrollmentIntents.$inferSelect;

export const backlogReleaseRuns = pgTable("backlog_release_runs", {
  id:             varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  scope:          text("scope").notNull(),  // logical_job_key or '*'
  limits:         jsonb("limits").notNull(), // { chunkSize, ratePerMin, maxTotal }
  actor:          text("actor").notNull(),
  stage:          text("stage").notNull().default("pending"), // pending | running | completed | aborted | failed
  cursor:         jsonb("cursor"),
  abortRequested: boolean("abort_requested").notNull().default(false),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt:      timestamp("started_at", { withTimezone: true }),
  completedAt:    timestamp("completed_at", { withTimezone: true }),
  abortedAt:      timestamp("aborted_at", { withTimezone: true }),
  stats:          jsonb("stats"),
});

export type BacklogReleaseRun = typeof backlogReleaseRuns.$inferSelect;

// ---------------------------------------------------------------------------
// BT-06 — Commercial Truth Classification
// ---------------------------------------------------------------------------
// Vocabulary: production | test | demo | synthetic | unknown
// - Root-subject tables (contacts, deals, prospects, companies) carry
//   `record_class` (the current class; mutable only via the authority).
// - Immutable events are in commercial_classification_events.
// - Workflow commands are in commercial_classification_commands.
// - Aggregate lineage metadata is in commercial_aggregate_lineage.
// ---------------------------------------------------------------------------

export const COMMERCIAL_CLASS_VALUES = [
  "production",
  "test",
  "demo",
  "synthetic",
  "unknown",
] as const;
export type CommercialClass = typeof COMMERCIAL_CLASS_VALUES[number];

export const CLASSIFICATION_POLICY_VERSION = 1;

// Append-only immutable classification event log.
// (event_namespace, event_key) is the idempotency key; replay is safe.
export const commercialClassificationEvents = pgTable("commercial_classification_events", {
  id:              serial("id").primaryKey(),
  subjectType:     text("subject_type").notNull(),        // 'contact' | 'deal' | 'prospect' | 'company'
  subjectId:       integer("subject_id").notNull(),
  eventNamespace:  text("event_namespace").notNull(),     // stable namespace, e.g. 'bt06:manual'
  eventKey:        text("event_key").notNull(),           // unique within namespace
  policyVersion:   integer("policy_version").notNull().default(CLASSIFICATION_POLICY_VERSION),
  priorClass:      text("prior_class"),                   // null = first classification
  newClass:        text("new_class").notNull(),           // CommercialClass
  evidenceHash:    text("evidence_hash"),                 // SHA-256 of allowlisted evidence
  // evidence_fields: allowlisted non-PII key/value pairs only.
  // MUST NOT contain SSN, EIN, bank data, email/document bodies, credentials.
  evidenceFields:  jsonb("evidence_fields").notNull().default(sql`'{}'::jsonb`),
  actorId:         text("actor_id"),
  approverId:      text("approver_id"),
  createdAt:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cce_namespace_key_uidx").on(table.eventNamespace, table.eventKey),
  index("cce_subject_idx").on(table.subjectType, table.subjectId),
]);

export type CommercialClassificationEvent = typeof commercialClassificationEvents.$inferSelect;
export type InsertCommercialClassificationEvent = typeof commercialClassificationEvents.$inferInsert;

// Idempotent command table for preview/approve/execute workflow.
export const commercialClassificationCommands = pgTable("commercial_classification_commands", {
  id:             uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: uuid("idempotency_key").notNull().unique(),
  subjectType:    text("subject_type").notNull(),
  subjectId:      integer("subject_id").notNull(),
  targetClass:    text("target_class").notNull(),
  status:         text("status").notNull().default("preview"), // preview | approved | executed | rejected
  requestedBy:    text("requested_by"),
  approvedBy:     text("approved_by"),
  evidenceFields: jsonb("evidence_fields").notNull().default(sql`'{}'::jsonb`),
  evidenceRefs: jsonb("evidence_refs").notNull().default(sql`'[]'::jsonb`),
  payloadHash: text("payload_hash"),
  previewDependencyFingerprint: text("preview_dependency_fingerprint"),
  purposePolicyFingerprint: text("purpose_policy_fingerprint"),
  policyVersion: integer("policy_version").notNull().default(1),
  executorId: text("executor_id"),
  executionFence: integer("execution_fence").notNull().default(0),
  versionLock:    integer("version_lock").notNull().default(0),
  previewAt:      timestamp("preview_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt:     timestamp("approved_at", { withTimezone: true }),
  executedAt:     timestamp("executed_at", { withTimezone: true }),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("ccc_subject_idx").on(table.subjectType, table.subjectId),
  index("ccc_status_idx").on(table.status),
]);

export type CommercialClassificationCommand = typeof commercialClassificationCommands.$inferSelect;

// CRO-02 is an additive shadow graph.  These axes intentionally are not
// commercial classes and snapshots cannot become readiness/campaign truth.
export const COMMERCIAL_PROVENANCE_VALUES = ["verified", "untraceable", "legacy_unknown", "conflicted", "invalid"] as const;
export const COMMERCIAL_IDENTITY_VALUES = ["resolved", "unresolved", "collision", "conflicted", "legacy_unknown"] as const;
export const COMMERCIAL_ORGANIZATION_LINK_VALUES = ["verified", "missing", "conflicted", "legacy_unknown", "rejected"] as const;
export const COMMERCIAL_RELATIONSHIP_VALUES = ["decision_maker", "not_decision_maker", "unknown", "conflicted"] as const;
export const COMMERCIAL_EVIDENCE_KINDS = ["classification_event", "contact_source_event", "import_row_disposition", "identity_observation", "merge_operation", "merge_redirect", "business_link_decision", "legacy_company_mapping_decision", "relationship_review"] as const;
export type CommercialProvenanceResolution = typeof COMMERCIAL_PROVENANCE_VALUES[number];
export type CommercialIdentityResolution = typeof COMMERCIAL_IDENTITY_VALUES[number];
export type CommercialOrganizationLinkResolution = typeof COMMERCIAL_ORGANIZATION_LINK_VALUES[number];
export type CommercialRelationshipResolution = typeof COMMERCIAL_RELATIONSHIP_VALUES[number];

export const commercialSubjectRevisions = pgTable("commercial_subject_revisions", {
  subjectType: text("subject_type").notNull(), subjectId: integer("subject_id").notNull(),
  revision: integer("revision").notNull().default(0), authorityVersion: integer("authority_version").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("commercial_subject_revisions_pk").on(t.subjectType, t.subjectId)]);
export const commercialMembershipRevisions = pgTable("commercial_membership_revisions", {
  edgeType: text("edge_type").notNull(), leftSubjectType: text("left_subject_type").notNull(), leftSubjectId: integer("left_subject_id").notNull(),
  rightSubjectType: text("right_subject_type").notNull(), rightSubjectId: integer("right_subject_id").notNull(), revision: integer("revision").notNull().default(0),
  authorityVersion: integer("authority_version").notNull().default(1), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("commercial_membership_revisions_pk").on(t.edgeType, t.leftSubjectType, t.leftSubjectId, t.rightSubjectType, t.rightSubjectId)]);
export const contactBusinessLinkDecisions = pgTable("contact_business_link_decisions", {
  id: uuid("id").primaryKey().defaultRandom(), contactId: integer("contact_id").notNull().references(() => contacts.id),
  businessId: integer("business_id").references(() => businesses.id), decision: text("decision").notNull(),
  decisionKey: text("decision_key").notNull().unique(), actorId: text("actor_id"), revision: integer("revision").notNull().default(1),
  evidenceSourceEventId: integer("evidence_source_event_id").references(() => contactSourceEvents.id, { onDelete: "restrict" }),
  systemEvidenceId: uuid("system_evidence_id").references(() => contactBusinessSystemLinkEvidence.id, { onDelete: "restrict" }),
  sfpEvidenceId: uuid("sfp_evidence_id").references((): AnyPgColumn => contactBusinessSfpLinkEvidence.id, { onDelete: "restrict" }),
  firstPartyEvidenceId: uuid("first_party_evidence_id").references((): AnyPgColumn => contactBusinessFirstPartyLinkEvidence.id, { onDelete: "restrict" }),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "restrict" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), supersededAt: timestamp("superseded_at", { withTimezone: true }),
}, (table) => [
  index("contact_business_link_decisions_sfp_evidence_idx").on(table.sfpEvidenceId)
    .where(sql`${table.sfpEvidenceId} IS NOT NULL`),
  index("contact_business_link_decisions_first_party_evidence_idx").on(table.firstPartyEvidenceId)
    .where(sql`${table.firstPartyEvidenceId} IS NOT NULL`),
]);
export const contactBusinessSystemLinkEvidence = pgTable("contact_business_system_link_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  decisionKey: text("decision_key").notNull().unique(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  sourceLinkId: uuid("source_link_id").notNull().references(() => canonicalSourceLinks.id, { onDelete: "restrict" }),
  sourceEntityId: integer("source_entity_id").references(() => sunbizEntities.id, { onDelete: "restrict" }),
  ruleVersion: text("rule_version").notNull(),
  factsHash: text("facts_hash").notNull(),
  facts: jsonb("facts").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("contact_business_system_link_evidence_subject_idx").on(t.contactId, t.businessId, t.createdAt)]);
export const contactBusinessLinkCandidates = pgTable("contact_business_link_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  source: text("source").notNull(),
  sourceVersion: text("source_version"),
  candidateKey: text("candidate_key").notNull().unique(),
  confidence: integer("confidence").notNull(),
  supersedesCandidateId: uuid("supersedes_candidate_id")
    .references((): AnyPgColumn => contactBusinessLinkCandidates.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("contact_business_link_candidate_subject_idx").on(t.contactId, t.businessId, t.createdAt),
  uniqueIndex("contact_business_link_candidate_superseded_once_uidx")
    .on(t.supersedesCandidateId).where(sql`${t.supersedesCandidateId} IS NOT NULL`),
]);
export const legacyCompanyMappingDecisions = pgTable("legacy_company_mapping_decisions", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: integer("company_id").notNull().references(() => companies.id),
  businessId: integer("business_id").references(() => businesses.id), decision: text("decision").notNull(),
  decisionKey: text("decision_key").notNull().unique(), actorId: text("actor_id"), revision: integer("revision").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), supersededAt: timestamp("superseded_at", { withTimezone: true }),
});

export const cro03bProjectionReceipts = pgTable("cro03b_projection_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03bRecipeItems.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  businessId: integer("business_id").references(() => businesses.id, { onDelete: "restrict" }),
  contactSourceEventId: integer("contact_source_event_id").references(() => contactSourceEvents.id, { onDelete: "restrict" }),
  linkDecisionId: uuid("link_decision_id").references(() => contactBusinessLinkDecisions.id, { onDelete: "restrict" }),
  field: text("field").notNull(),
  candidateSetHash: text("candidate_set_hash").notNull(),
  beforeValueHash: text("before_value_hash").notNull(),
  afterValueHash: text("after_value_hash").notNull(),
  subjectGeneration: integer("subject_generation"),
  disposition: text("disposition").notNull(),
  receiptKey: text("receipt_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cro03bFinalizationReceipts = pgTable("cro03b_finalization_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().unique().references(() => cro03bRecipeItems.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  validationIntentId: uuid("validation_intent_id").references(() => validationIntents.id, { onDelete: "restrict" }),
  subjectGeneration: integer("subject_generation").notNull(),
  emailTokenHash: text("email_token_hash"),
  linkDisposition: text("link_disposition").notNull(),
  scoringRequestKey: text("scoring_request_key").notNull().unique(),
  state: text("state").notNull().default("validation_pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const cro03bLegacyWriterFences = pgTable("cro03b_legacy_writer_fences", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id").notNull().references(() => cro03bRecipeItems.id, { onDelete: "restrict" }),
  subjectType: text("subject_type").notNull(),
  subjectKey: text("subject_key").notNull(),
  writerKey: text("writer_key").notNull(),
  disposition: text("disposition").notNull(),
  evidenceRef: text("evidence_ref"),
  reasonCode: text("reason_code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro03b_legacy_fence_identity_uidx").on(table.itemId, table.writerKey, table.subjectType, table.subjectKey),
]);
export const commercialRelationshipCandidates = pgTable("commercial_relationship_candidates", {
  id: uuid("id").primaryKey().defaultRandom(), contactId: integer("contact_id").notNull().references(() => contacts.id),
  businessId: integer("business_id").notNull().references(() => businesses.id), source: text("source").notNull(), sourceVersion: text("source_version"),
  confidence: integer("confidence").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const commercialRelationshipReviews = pgTable("commercial_relationship_reviews", {
  id: uuid("id").primaryKey().defaultRandom(), contactId: integer("contact_id").notNull().references(() => contacts.id),
  businessId: integer("business_id").notNull().references(() => businesses.id), decision: text("decision").notNull(), reviewKey: text("review_key").notNull().unique(),
  actorId: text("actor_id").notNull(), revision: integer("revision").notNull().default(1), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
});
export const commercialResolutionSnapshots = pgTable("commercial_resolution_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(), requestedSubjectType: text("requested_subject_type").notNull(), requestedSubjectId: integer("requested_subject_id").notNull(),
  effectiveSubjectType: text("effective_subject_type").notNull(), effectiveSubjectId: integer("effective_subject_id").notNull(), purpose: text("purpose").notNull(),
  policyVersion: integer("policy_version").notNull(), schemaVersion: integer("schema_version").notNull().default(1), mode: text("mode").notNull().default("shadow"),
  resolution: text("resolution").notNull(), recordClass: text("record_class").notNull(), provenanceResolution: text("provenance_resolution").notNull(),
  identityResolution: text("identity_resolution").notNull(), organizationLinkResolution: text("organization_link_resolution").notNull(),
  relationshipResolution: text("relationship_resolution").notNull(), reasonCodes: jsonb("reason_codes").notNull().default([]),
  dependencyFingerprint: text("dependency_fingerprint").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const commercialResolutionDependencies = pgTable("commercial_resolution_dependencies", {
  snapshotId: uuid("snapshot_id").notNull().references(() => commercialResolutionSnapshots.id, { onDelete: "restrict" }),
  objectType: text("object_type").notNull(), objectId: text("object_id").notNull(), revision: integer("revision").notNull(),
  authorityVersion: integer("authority_version").notNull(), rank: integer("rank").notNull(),
}, (t) => [unique("commercial_resolution_dependencies_pk").on(t.snapshotId, t.objectType, t.objectId)]);
export const commercialEvidenceReferences = pgTable("commercial_evidence_references", {
  id: uuid("id").primaryKey().defaultRandom(), snapshotId: uuid("snapshot_id").notNull().references(() => commercialResolutionSnapshots.id, { onDelete: "restrict" }),
  classificationEventId: integer("classification_event_id").references(() => commercialClassificationEvents.id, { onDelete: "restrict" }),
  contactSourceEventId: integer("contact_source_event_id").references(() => contactSourceEvents.id, { onDelete: "restrict" }),
  importRowDispositionId: integer("import_row_disposition_id").references(() => importRowDispositions.id, { onDelete: "restrict" }),
  identityObservationId: uuid("identity_observation_id").references(() => contactIdentityObservations.id, { onDelete: "restrict" }),
  mergeOperationId: uuid("merge_operation_id").references(() => contactMergeOperations.id, { onDelete: "restrict" }),
  mergeRedirectId: uuid("merge_redirect_id").references(() => contactMergeRedirects.id, { onDelete: "restrict" }),
  businessLinkDecisionId: uuid("business_link_decision_id").references(() => contactBusinessLinkDecisions.id, { onDelete: "restrict" }),
  legacyCompanyMappingDecisionId: uuid("legacy_company_mapping_decision_id").references(() => legacyCompanyMappingDecisions.id, { onDelete: "restrict" }),
  relationshipReviewId: uuid("relationship_review_id").references(() => commercialRelationshipReviews.id, { onDelete: "restrict" }),
});
export const commercialPurposePolicies = pgTable("commercial_purpose_policies", {
  purpose: text("purpose").notNull(), policyVersion: integer("policy_version").notNull(), requiredEdges: jsonb("required_edges").notNull().default({}),
  mode: text("mode").notNull().default("shadow"), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique("commercial_purpose_policies_pkey").on(t.purpose, t.policyVersion)]);
export const commercialShadowControls = pgTable("commercial_shadow_controls", {
  controlKey: text("control_key").primaryKey().default("commercial"), mode: text("mode").notNull().default("shadow"), schemaVersion: integer("schema_version").notNull().default(1),
  coverageHighWater: bigint("coverage_high_water", { mode: "number" }).notNull().default(0), approvedDiscrepancyThreshold: numeric("approved_discrepancy_threshold"),
  releaseSha: text("release_sha"), rollbackMarker: text("rollback_marker").notNull().default("legacy-effective"), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
/** Aggregate-only shadow observations.  Deliberately contains no subject key. */
export const commercialShadowAggregates = pgTable("commercial_shadow_aggregates", {
  id: uuid("id").primaryKey().defaultRandom(),
  purpose: text("purpose").notNull(),
  coverageHighWater: bigint("coverage_high_water", { mode: "number" }).notNull(),
  policyVersion: integer("policy_version").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  scope: text("scope").notNull(),
  bucketType: text("bucket_type").notNull(),
  bucketKey: text("bucket_key").notNull(),
  subjectCount: integer("subject_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("commercial_shadow_aggregates_bucket_uidx").on(t.purpose, t.coverageHighWater, t.policyVersion, t.schemaVersion, t.scope, t.bucketType, t.bucketKey),
]);

// Aggregate lineage: one row per KPI rebuild storing lineage metadata.
export const commercialAggregateLineage = pgTable("commercial_aggregate_lineage", {
  id:              serial("id").primaryKey(),
  aggregateType:   text("aggregate_type").notNull(),   // 'funnel_metrics' | 'executive_kpi' | 'agent_payouts'
  aggregateKey:    text("aggregate_key").notNull(),    // e.g. date "2026-08-21" or period "2026-08"
  policyVersion:   integer("policy_version").notNull().default(CLASSIFICATION_POLICY_VERSION),
  sourceRowCount:  integer("source_row_count").notNull().default(0),
  productionCount: integer("production_count").notNull().default(0),
  excludedCount:   integer("excluded_count").notNull().default(0),
  unknownCount:    integer("unknown_count").notNull().default(0),
  lineageHwm:      timestamp("lineage_hwm", { withTimezone: true }),
  computedAt:      timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("cal_type_key_idx").on(table.aggregateType, table.aggregateKey),
]);

export type CommercialAggregateLineage = typeof commercialAggregateLineage.$inferSelect;

// ─── Canonical contact identity + reviewed merge operations (BT-07) ─────────
// Identity observations deliberately retain normalized evidence only. Raw
// email/phone values stay on the contact compatibility record and must never be
// copied into merge audit payloads.
export const contactIdentityObservations = pgTable("contact_identity_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  identityKind: text("identity_kind").notNull(), // email | phone
  normalizedValue: text("normalized_value"),
  lookupToken: text("lookup_token").notNull(),
  normalizationVersion: integer("normalization_version").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id"),
  countryCode: text("country_code"),
  phoneEndpointType: text("phone_endpoint_type"),
  phoneOwnership: text("phone_ownership"),
  eligibility: text("eligibility").notNull().default("ineligible"),
  confidence: integer("confidence").notNull().default(0),
  invalidReason: text("invalid_reason"),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cio_observation_dedupe_uidx").on(table.contactId, table.identityKind, table.lookupToken, table.normalizationVersion, table.sourceType),
  index("cio_contact_kind_idx").on(table.contactId, table.identityKind, table.observedAt),
  index("cio_lookup_token_idx").on(table.identityKind, table.lookupToken),
  index("cio_eligible_idx").on(table.identityKind, table.eligibility).where(sql`eligibility = 'eligible' AND superseded_at IS NULL`),
]);
export type ContactIdentityObservation = typeof contactIdentityObservations.$inferSelect;

export const contactMergeOperations = pgTable("contact_merge_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: uuid("idempotency_key").notNull().unique(),
  survivorContactId: integer("survivor_contact_id").notNull().references(() => contacts.id),
  deprecatedContactId: integer("deprecated_contact_id").notNull().references(() => contacts.id),
  status: text("status").notNull().default("previewed"),
  actorId: text("actor_id").notNull(),
  actorRole: text("actor_role").notNull(),
  manifestVersion: integer("manifest_version").notNull(),
  normalizationVersion: integer("normalization_version").notNull(),
  previewHash: text("preview_hash").notNull(),
  contactVersions: jsonb("contact_versions").notNull().default(sql`'{}'::jsonb`),
  fieldDecisions: jsonb("field_decisions").notNull().default(sql`'{}'::jsonb`),
  conflictReason: text("conflict_reason"),
  ghlDisposition: text("ghl_disposition").notNull().default("none"),
  reconciliationStatus: text("reconciliation_status").notNull().default("not_required"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cmo_pair_active_uidx").on(table.survivorContactId, table.deprecatedContactId)
    .where(sql`status IN ('previewed', 'approved', 'executing', 'committed', 'reconciliation_pending', 'completed')`),
  index("cmo_survivor_idx").on(table.survivorContactId),
  index("cmo_deprecated_idx").on(table.deprecatedContactId),
]);
export type ContactMergeOperation = typeof contactMergeOperations.$inferSelect;

export const contactMergeRedirects = pgTable("contact_merge_redirects", {
  id: uuid("id").primaryKey().defaultRandom(),
  deprecatedContactId: integer("deprecated_contact_id").notNull().references(() => contacts.id),
  survivorContactId: integer("survivor_contact_id").notNull().references(() => contacts.id),
  operationId: uuid("operation_id").notNull().references(() => contactMergeOperations.id),
  active: boolean("active").notNull().default(true),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cmr_active_deprecated_uidx").on(table.deprecatedContactId).where(sql`active`),
  index("cmr_survivor_idx").on(table.survivorContactId),
]);
export type ContactMergeRedirect = typeof contactMergeRedirects.$inferSelect;

export const contactMergeRelationshipActions = pgTable("contact_merge_relationship_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => contactMergeOperations.id),
  manifestVersion: integer("manifest_version").notNull(),
  relationKey: text("relation_key").notNull(),
  sourceRecordId: text("source_record_id").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull().default("committed"),
  beforeSnapshot: jsonb("before_snapshot").notNull().default(sql`'{}'::jsonb`),
  afterSnapshot: jsonb("after_snapshot").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("cmra_operation_relation_record_uidx").on(table.operationId, table.relationKey, table.sourceRecordId),
  index("cmra_operation_idx").on(table.operationId),
]);

export const contactMergeUndoRecords = pgTable("contact_merge_undo_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().unique().references(() => contactMergeOperations.id),
  requestedBy: text("requested_by").notNull(),
  status: text("status").notNull().default("requested"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const contactMergeReconciliations = pgTable("contact_merge_reconciliations", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().unique().references(() => contactMergeOperations.id),
  status: text("status").notNull().default("pending"),
  reason: text("reason").notNull(),
  attempts: integer("attempts").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── CR-06 Premium Campaign Governance ──────────────────────────────────────
// These additive tables intentionally do not replace the legacy campaign,
// sequence, enrollment, or message status columns.
export const cr06Artifacts = pgTable("cr06_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  identityKey: text("identity_key").notNull(),
  artifactKind: text("artifact_kind").notNull(),
  recordClass: text("record_class").notNull().default("production"),
  purpose: text("purpose").notNull().default("cold_marketing"),
  governanceState: text("governance_state").notNull().default("draft"),
  compatibilityState: text("compatibility_state").notNull().default("governed"),
  preparationState: text("preparation_state").notNull().default("not_prepared"),
  version: integer("version").notNull(),
  parentArtifactId: uuid("parent_artifact_id").references((): AnyPgColumn => cr06Artifacts.id, { onDelete: "restrict" }),
  document: jsonb("document").notNull(),
  contentHash: text("content_hash").notNull(),
  dependencyFingerprint: text("dependency_fingerprint"),
  createdBy: text("created_by").notNull(),
  reviewedBy: text("reviewed_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Cr06Artifact = typeof cr06Artifacts.$inferSelect;

export const cr06RolloutManifests = pgTable("cr06_rollout_manifests", {
  id: uuid("id").primaryKey().defaultRandom(),
  manifestVersion: text("manifest_version").notNull().unique(),
  manifestHash: text("manifest_hash").notNull(),
  status: text("status").notNull().default("dry_run"),
  programCount: integer("program_count").notNull().default(0),
  sequenceCount: integer("sequence_count").notNull().default(0),
  contentCount: integer("content_count").notNull().default(0),
  manualTaskCount: integer("manual_task_count").notNull().default(0),
  document: jsonb("document").notNull(),
  actorId: text("actor_id"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  fence: integer("fence").notNull().default(0),
  receipt: jsonb("receipt"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
});
export type Cr06RolloutManifest = typeof cr06RolloutManifests.$inferSelect;

export const cr06ApprovalSnapshots = pgTable("cr06_approval_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  artifactId: uuid("artifact_id").notNull().unique().references(() => cr06Artifacts.id, { onDelete: "restrict" }),
  artifactHash: text("artifact_hash").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  dependencyFingerprint: text("dependency_fingerprint").notNull(),
  reviewerId: text("reviewer_id").notNull(),
  compareAndSetHash: text("compare_and_set_hash").notNull(),
  dependencySnapshot: jsonb("dependency_snapshot").notNull().default(sql`'{}'::jsonb`),
  snapshotVersion: integer("snapshot_version").notNull().default(1),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cr06CampaignGates = pgTable("cr06_campaign_gates", {
  id: uuid("id").primaryKey().defaultRandom(),
  programArtifactId: uuid("program_artifact_id").notNull().references(() => cr06Artifacts.id, { onDelete: "restrict" }),
  cohortRunId: uuid("cohort_run_id").notNull().references(() => cr04CohortRuns.id, { onDelete: "restrict" }),
  approvalId: uuid("approval_id").notNull().references(() => cr06ApprovalSnapshots.id, { onDelete: "restrict" }),
  preflightHash: text("preflight_hash").notNull(),
  cap: integer("cap").notNull(),
  state: text("state").notNull().default("closed"),
  confirmation: text("confirmation"),
  actorId: text("actor_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  // Mutating a gate requires the caller to compare this exact revision.
  revision: integer("revision").notNull().default(1),
  dependencySnapshot: jsonb("dependency_snapshot").notNull().default(sql`'{}'::jsonb`),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cr06CampaignGateRevisions = pgTable("cr06_campaign_gate_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  campaignGateId: uuid("campaign_gate_id").notNull().references(() => cr06CampaignGates.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull(),
  state: text("state").notNull(),
  actorId: text("actor_id").notNull(),
  dependencySnapshot: jsonb("dependency_snapshot").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cr06_campaign_gate_revision_schema_uidx").on(table.campaignGateId, table.revision),
]);

export const cr06PreparationRuns = pgTable("cr06_preparation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  programArtifactId: uuid("program_artifact_id").notNull().references(() => cr06Artifacts.id, { onDelete: "restrict" }),
  approvalId: uuid("approval_id").notNull().references(() => cr06ApprovalSnapshots.id, { onDelete: "restrict" }),
  cohortRunId: uuid("cohort_run_id").notNull().references(() => cr04CohortRuns.id, { onDelete: "restrict" }),
  dependencyFingerprint: text("dependency_fingerprint").notNull(),
  dependencySnapshot: jsonb("dependency_snapshot").notNull().default(sql`'{}'::jsonb`),
  dependencyVersion: integer("dependency_version").notNull().default(1),
  state: text("state").notNull().default("building"),
  requestedCount: integer("requested_count").notNull().default(0),
  preparedCount: integer("prepared_count").notNull().default(0),
  blockedCount: integer("blocked_count").notNull().default(0),
  deferredCount: integer("deferred_count").notNull().default(0),
  runHash: text("run_hash"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  fence: integer("fence").notNull().default(0),
  blockerSummary: jsonb("blocker_summary").notNull().default(sql`'{}'::jsonb`),
  receipt: jsonb("receipt"),
  receiptVersion: integer("receipt_version").notNull().default(1),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const cr06PreparedEnrollments = pgTable("cr06_prepared_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  preparationRunId: uuid("preparation_run_id").notNull().references(() => cr06PreparationRuns.id, { onDelete: "restrict" }),
  cohortOrdinal: integer("cohort_ordinal").notNull(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  contactGeneration: integer("contact_generation").notNull(),
  emailTokenHash: text("email_token_hash"),
  senderPolicyVersion: text("sender_policy_version").notNull(),
  dependencyFingerprint: text("dependency_fingerprint").notNull(),
  evidenceSnapshot: jsonb("evidence_snapshot").notNull(),
  state: text("state").notNull().default("ready_held"),
  removalReason: text("removal_reason"),
  manualTaskId: integer("manual_task_id").references(() => tasks.id, { onDelete: "restrict" }),
  sequenceEnrollmentId: integer("sequence_enrollment_id").references(() => sequenceEnrollments.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cr06DeliveryIntents = pgTable("cr06_delivery_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  preparationRunId: uuid("preparation_run_id").notNull().references(() => cr06PreparationRuns.id, { onDelete: "restrict" }),
  preparedEnrollmentId: uuid("prepared_enrollment_id").notNull().references(() => cr06PreparedEnrollments.id, { onDelete: "restrict" }),
  sequenceArtifactId: uuid("sequence_artifact_id").notNull().references(() => cr06Artifacts.id, { onDelete: "restrict" }),
  contentArtifactId: uuid("content_artifact_id").notNull().references(() => cr06Artifacts.id, { onDelete: "restrict" }),
  recipientContactId: integer("recipient_contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  touchNumber: integer("touch_number").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  state: text("state").notNull().default("held"),
  recipientSnapshot: jsonb("recipient_snapshot").notNull(),
  renderHash: text("render_hash").notNull(),
  dependencySnapshot: jsonb("dependency_snapshot").notNull().default(sql`'{}'::jsonb`),
  dependencyVersion: integer("dependency_version").notNull().default(1),
  providerAttemptCount: integer("provider_attempt_count").notNull().default(0),
  terminalReason: text("terminal_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
});

// Every preparation persists one immutable, non-capacity-bearing reservation
// for each authority scope. These are evidence of held work only, never
// authorization to transmit.
export const cr06PreparationReservations = pgTable("cr06_preparation_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  preparationRunId: uuid("preparation_run_id").notNull().references(() => cr06PreparationRuns.id, { onDelete: "restrict" }),
  reservationKey: text("reservation_key").notNull(),
  scopeType: text("scope_type").notNull(),
  scopeIdentity: text("scope_identity").notNull(),
  scopeWindow: timestamp("scope_window", { withTimezone: true }),
  reservedMemberCap: integer("reserved_member_cap").notNull(),
  effectiveCap: integer("effective_cap").notNull().default(0),
  currentUsage: integer("current_usage").notNull().default(0),
  sendCapacityUnits: integer("send_capacity_units").notNull().default(0),
  dependencySnapshot: jsonb("dependency_snapshot").notNull(),
  receipt: jsonb("receipt").notNull(),
  receiptHash: text("receipt_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  state: text("state").notNull().default("held"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  reconciliationReceipt: jsonb("reconciliation_receipt"),
  reconciliationReceiptHash: text("reconciliation_receipt_hash"),
  reconciliationActorId: text("reconciliation_actor_id"),
  reconciliationAsOf: timestamp("reconciliation_as_of", { withTimezone: true }),
  reconciliationKey: text("reconciliation_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cr06_preparation_reservation_run_scope_uidx").on(table.preparationRunId, table.scopeType),
  uniqueIndex("cr06_preparation_reservation_key_uidx").on(table.reservationKey),
  index("cr06_preparation_reservation_expiry_idx").on(table.state, table.expiresAt),
]);

export const cr06ManualTaskIntents = pgTable("cr06_manual_task_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  preparationRunId: uuid("preparation_run_id").notNull().references(() => cr06PreparationRuns.id, { onDelete: "restrict" }),
  preparedEnrollmentId: uuid("prepared_enrollment_id").notNull().unique().references(() => cr06PreparedEnrollments.id, { onDelete: "restrict" }),
  taskDefinitionArtifactId: uuid("task_definition_artifact_id").notNull().references(() => cr06Artifacts.id, { onDelete: "restrict" }),
  triggerTouchNumber: integer("trigger_touch_number").notNull().default(2),
  state: text("state").notNull().default("held"),
  scheduledAfter: timestamp("scheduled_after", { withTimezone: true }).notNull(),
  cr05TaskId: integer("cr05_task_id").references(() => tasks.id, { onDelete: "restrict" }),
  commandKey: text("command_key").notNull().unique(),
  dependencySnapshot: jsonb("dependency_snapshot").notNull().default(sql`'{}'::jsonb`),
  dependencyVersion: integer("dependency_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cr06AttributionEvents = pgTable("cr06_attribution_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  preparationRunId: uuid("preparation_run_id").notNull().references(() => cr06PreparationRuns.id, { onDelete: "restrict" }),
  deliveryIntentId: uuid("delivery_intent_id").references(() => cr06DeliveryIntents.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  eventType: text("event_type").notNull(),
  outcome: text("outcome").notNull(),
  provider: text("provider"),
  providerEventKey: text("provider_event_key"),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cr06FeedbackReceipts = pgTable("cr06_feedback_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  deliveryIntentId: uuid("delivery_intent_id").notNull().references(() => cr06DeliveryIntents.id, { onDelete: "restrict" }),
  preparationRunId: uuid("preparation_run_id").notNull().references(() => cr06PreparationRuns.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  source: text("source").notNull(),
  eventKey: text("event_key").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  receivedBy: text("received_by").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  effectVersion: integer("effect_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cr06_feedback_receipt_source_key_schema_uidx").on(table.source, table.eventKey),
]);

// ─── CRO-07 — Controlled Delivery, Reply, Growth & Conversion Feedback ──────
// CRO-07 NEVER writes to any cr06_* table above. It references CR-06 delivery
// intents by id only. CR06_DISPATCH_AVAILABLE / the /release route contract
// in server/routes/cr06.ts stay unchanged — CRO-07 owns a separate,
// denied-by-default release/attempt/reconciliation authority for its own
// intents so that a future authorized adapter has somewhere durable to live.

// Immutable, compare-and-set release revisions bound to one exact CR-06
// delivery intent. Only one release chain may be active/approved/draft per
// intent at a time — enforced by the partial unique index below (kill line).
export const cro07Releases = pgTable("cro07_releases", {
  id: uuid("id").primaryKey().defaultRandom(),
  cr06DeliveryIntentId: uuid("cr06_delivery_intent_id").notNull().references(() => cr06DeliveryIntents.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull().default(1),
  state: text("state").notNull().default("draft"), // draft | approved | active | expired | revoked
  reviewedSha: text("reviewed_sha").notNull(),
  migrationHead: text("migration_head").notNull(),
  cr06GateId: uuid("cr06_gate_id").references(() => cr06CampaignGates.id, { onDelete: "restrict" }),
  cr06ProgramArtifactId: uuid("cr06_program_artifact_id").references(() => cr06Artifacts.id, { onDelete: "restrict" }),
  cr06CohortRunId: uuid("cr06_cohort_run_id").references(() => cr04CohortRuns.id, { onDelete: "restrict" }),
  senderRoute: text("sender_route").notNull(), // approved sender/reply-route identity key
  // Approved webhook source (the URL path segment / HMAC-secret selector a
  // provider's feedback events must arrive under). Immutable input to the
  // release, like senderRoute — copied onto the claimed attempt and checked
  // together with providerAccountId before any feedback event can apply a
  // side effect (see cro07-feedback.ts / migration 0211).
  providerSource: text("provider_source"),
  adapterKey: text("adapter_key").notNull().default("denied_fake"),
  environment: text("environment").notNull().default("disabled"),
  readinessSnapshot: jsonb("readiness_snapshot").notNull(),
  suppressionGeneration: text("suppression_generation").notNull(),
  pauseEpoch: text("pause_epoch").notNull(),
  caps: jsonb("caps").notNull(),
  canarySize: integer("canary_size").notNull().default(0),
  stopThresholds: jsonb("stop_thresholds").notNull(),
  dependencySnapshot: jsonb("dependency_snapshot").notNull(),
  dependencyFingerprint: text("dependency_fingerprint").notNull(),
  approverId: text("approver_id"),
  reason: text("reason").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revisionHash: text("revision_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("cro07_release_active_chain_per_intent_uidx")
    .on(table.cr06DeliveryIntentId)
    .where(sql`state IN ('draft','approved','active')`),
  index("cro07_release_intent_idx").on(table.cr06DeliveryIntentId),
]);
export type Cro07Release = typeof cro07Releases.$inferSelect;

// One durable capacity reservation per (release, capacity key). Reserved
// BEFORE any attempt is allowed to claim a unit.
export const cro07Reservations = pgTable("cro07_reservations", {
  id: uuid("id").primaryKey().defaultRandom(),
  releaseId: uuid("release_id").notNull().references(() => cro07Releases.id, { onDelete: "restrict" }),
  capacityKey: text("capacity_key").notNull(), // daily_cap | canary | per_hour
  reservedCap: integer("reserved_cap").notNull(),
  usedCount: integer("used_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro07_reservation_release_key_uidx").on(table.releaseId, table.capacityKey),
]);

// Durable provider attempt — persisted BEFORE any transport I/O (kill line).
export const cro07Attempts = pgTable("cro07_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Unique: a release must claim exactly one attempt (hard DB guarantee,
  // not just an idempotency-key convention).
  releaseId: uuid("release_id").notNull().unique().references(() => cro07Releases.id, { onDelete: "restrict" }),
  cr06DeliveryIntentId: uuid("cr06_delivery_intent_id").notNull().references(() => cr06DeliveryIntents.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  leaseToken: uuid("lease_token").notNull().defaultRandom(),
  fenceEpoch: text("fence_epoch").notNull(),
  provider: text("provider").notNull(),
  // Immutable provider/source correlation, set ONCE at claim time from the
  // release's approved sender_route — never from a webhook payload. This is
  // the anchor authenticated feedback must match before applying any effect
  // (see cro07-feedback.ts); it prevents a signer for one source/account
  // from asserting feedback against an attempt sent under a different one.
  providerAccountId: text("provider_account_id"),
  // Immutable webhook-source correlation, copied from the release's
  // providerSource at claim time. Checked together with providerAccountId
  // — a signer for a DIFFERENT registered source can never assert feedback
  // against this attempt even if it somehow names a matching account id.
  providerSource: text("provider_source"),
  adapterKey: text("adapter_key").notNull(),
  state: text("state").notNull().default("reserved"),
  // reserved -> in_flight -> {accepted|rejected|timeout_unknown} -> {reconciled_success|reconciled_failed|duplicate}
  providerAttemptId: text("provider_attempt_id"),
  redactedError: text("redacted_error"),
  attemptedAt: timestamp("attempted_at", { withTimezone: true }),
  terminalAt: timestamp("terminal_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("cro07_attempt_intent_idx").on(table.cr06DeliveryIntentId),
  index("cro07_attempt_release_state_idx").on(table.releaseId, table.state),
]);
export type Cro07Attempt = typeof cro07Attempts.$inferSelect;

export const cro07Reconciliations = pgTable("cro07_reconciliations", {
  id: uuid("id").primaryKey().defaultRandom(),
  attemptId: uuid("attempt_id").notNull().references(() => cro07Attempts.id, { onDelete: "restrict" }),
  fromState: text("from_state").notNull(),
  toState: text("to_state").notNull(),
  reasonCode: text("reason_code").notNull(),
  actorId: text("actor_id").notNull(),
  evidence: jsonb("evidence").notNull().default(sql`'{}'::jsonb`),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Authenticated CRO-07 provider ingress — deliberately separate from
// ingestCr06SyntheticFeedback(); never widen that function into this one.
export const cro07FeedbackReceipts = pgTable("cro07_feedback_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(), // provider name
  providerAccountId: text("provider_account_id"),
  providerEventId: text("provider_event_id").notNull(),
  signatureValid: boolean("signature_valid").notNull(),
  attemptId: uuid("attempt_id").references(() => cro07Attempts.id, { onDelete: "restrict" }),
  releaseId: uuid("release_id").references(() => cro07Releases.id, { onDelete: "restrict" }),
  cr06DeliveryIntentId: uuid("cr06_delivery_intent_id").references(() => cr06DeliveryIntents.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
  contactGeneration: integer("contact_generation"),
  eventType: text("event_type").notNull(),
  // ordinary_reply | explicit_unsubscribe | complaint | hard_bounce | soft_bounce | delivered | ambiguous_reply
  canonicalEffect: text("canonical_effect").notNull(),
  providerOccurredAt: timestamp("provider_occurred_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro07_feedback_source_event_uidx").on(table.source, table.providerEventId),
  index("cro07_feedback_intent_idx").on(table.cr06DeliveryIntentId),
]);
export type Cro07FeedbackReceipt = typeof cro07FeedbackReceipts.$inferSelect;

// A durable, idempotent CR-05 reply-work occurrence. Ordinary replies stop
// outreach immediately and create exactly one owned task via
// storage.createAuthorityTask(..., { commandKey }); they are never treated
// as unsubscribe/complaint/consent withdrawal.
export const cro07ReplyWork = pgTable("cro07_reply_work", {
  id: uuid("id").primaryKey().defaultRandom(),
  feedbackReceiptId: uuid("feedback_receipt_id").notNull().unique().references(() => cro07FeedbackReceipts.id, { onDelete: "restrict" }),
  // Nullable: a provider event whose identity cannot be resolved to a known
  // contact still gets a review-required reply-work row for human follow-up.
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
  occurrenceKey: text("occurrence_key").notNull().unique(),
  cr05TaskId: integer("cr05_task_id").references(() => tasks.id, { onDelete: "restrict" }),
  ownerResolution: text("owner_resolution").notNull().default("review_required"), // deterministic | review_required
  stoppedIntentIds: jsonb("stopped_intent_ids").notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Versioned canonical event taxonomy — additive alias mapping only; never
// rewrites the historical raw rows it maps.
export const cro07EventTaxonomy = pgTable("cro07_event_taxonomy", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: integer("version").notNull(),
  canonicalEvent: text("canonical_event").notNull(),
  subject: text("subject").notNull(),
  requiredIdentity: jsonb("required_identity").notNull().default(sql`'[]'::jsonb`),
  producerAuthority: text("producer_authority").notNull(),
  occurrenceRule: text("occurrence_rule").notNull().default("at_most_once"),
  aliases: jsonb("aliases").notNull().default(sql`'[]'::jsonb`),
  deprecated: boolean("deprecated").notNull().default(false),
  effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("cro07_taxonomy_canonical_version_uidx").on(table.canonicalEvent, table.version),
]);

// Truthful source-to-revenue attribution graph. revenueStatus stays
// 'unknown' until a future REV-06A processor-confirmed receipt exists;
// 'synthetic_fixture' is disposable-certification only and must never leak
// into a production report.
export const cro07AttributionEdges = pgTable("cro07_attribution_edges", {
  id: uuid("id").primaryKey().defaultRandom(),
  edgeType: text("edge_type").notNull(),
  fromType: text("from_type").notNull(),
  fromId: text("from_id").notNull(),
  toType: text("to_type").notNull(),
  toId: text("to_id").notNull(),
  revenueStatus: text("revenue_status").notNull().default("unknown"), // unknown | synthetic_fixture | processor_confirmed
  revenueAmountCents: bigint("revenue_amount_cents", { mode: "number" }),
  isSynthetic: boolean("is_synthetic").notNull().default(false),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro07_attribution_edge_uidx").on(table.edgeType, table.fromType, table.fromId, table.toType, table.toId),
  index("cro07_attribution_from_idx").on(table.fromType, table.fromId),
  index("cro07_attribution_to_idx").on(table.toType, table.toId),
]);

// Frozen experiment design + guarded decision. A winner never edits approved
// CR-06 content — it only produces a newVersionHandoffId for a fresh draft.
export const cro07Experiments = pgTable("cro07_experiments", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  hypothesis: text("hypothesis").notNull(),
  metric: text("metric").notNull(),
  populationDefinition: jsonb("population_definition").notNull(),
  allocation: jsonb("allocation").notNull(),
  versions: jsonb("versions").notNull(),
  minSampleSize: integer("min_sample_size").notNull(),
  minDurationDays: integer("min_duration_days").notNull(),
  confidenceRule: jsonb("confidence_rule").notNull(),
  guardrails: jsonb("guardrails").notNull(),
  contaminationExclusions: jsonb("contamination_exclusions").notNull().default(sql`'[]'::jsonb`),
  state: text("state").notNull().default("frozen_design"), // frozen_design | collecting | stopped_guardrail | ready_for_review | decided
  frozenBy: text("frozen_by").notNull(),
  frozenAt: timestamp("frozen_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  decision: text("decision"), // winner_a | winner_b | inconclusive | stopped_guardrail
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  newVersionHandoffKey: text("new_version_handoff_key"),
  designHash: text("design_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Cro07Experiment = typeof cro07Experiments.$inferSelect;

// Durable per-arm sample counters, updated only via atomic increments.
export const cro07ExperimentSamples = pgTable("cro07_experiment_samples", {
  id: uuid("id").primaryKey().defaultRandom(),
  experimentId: uuid("experiment_id").notNull().references(() => cro07Experiments.id, { onDelete: "restrict" }),
  arm: text("arm").notNull(),
  exposureCount: integer("exposure_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  guardrailBreachCount: integer("guardrail_breach_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("cro07_experiment_sample_arm_uidx").on(table.experimentId, table.arm),
]);

// ── Field Sales: Door-to-Door Territory & Visit Operations ───────────────────

/** Canonical outcome codes for field visit dispositions */
export const FIELD_VISIT_OUTCOME_CODES = [
  "visited_owner_spoke",
  "visited_owner_absent",
  "left_materials",
  "follow_up_requested",
  "statement_requested",
  "do_not_visit",
  "no_answer",
] as const;
export type FieldVisitOutcomeCode = (typeof FIELD_VISIT_OUTCOME_CODES)[number];

/** Territory criteria Zod schema — validated at write time */
export const TerritoryCriteriaSchema = z
  .object({
    postalCodes: z
      .array(z.string().regex(/^\d{5}$/, "postal codes must be 5 digits"))
      .max(50)
      .optional(),
    cities: z
      .array(z.string().min(1))
      .max(20)
      .optional(),
    states: z
      .array(z.string().regex(/^[A-Z]{2}$/, "states must be 2-letter USPS codes"))
      .max(5)
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      (v.postalCodes && v.postalCodes.length > 0) ||
      (v.cities && v.cities.length > 0) ||
      (v.states && v.states.length > 0),
    { message: "At least one of postalCodes, cities, or states must be non-empty" }
  );
export type TerritoryCriteria = z.infer<typeof TerritoryCriteriaSchema>;

export const salesTerritories = pgTable("sales_territories", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  criteria: jsonb("criteria").notNull(),
  timezone: text("timezone").notNull().default("America/New_York"),
  effectiveDate: date("effective_date"),
  expiredAt: timestamp("expired_at", { withTimezone: true }),
  version: integer("version").notNull().default(1),
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
export type SalesTerritory = typeof salesTerritories.$inferSelect;

export const salesTerritoryAssignments = pgTable("sales_territory_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  territoryId: uuid("territory_id").notNull().references(() => salesTerritories.id),
  agentUserId: varchar("agent_user_id").notNull().references(() => users.id),
  isPrimary: boolean("is_primary").notNull().default(true),
  overrideApproverUserId: varchar("override_approver_user_id").references(() => users.id),
  overrideReason: text("override_reason"),
  overrideAt: timestamp("override_at", { withTimezone: true }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("sta_agent_user_id_idx").on(table.agentUserId),
]);
export type SalesTerritoryAssignment = typeof salesTerritoryAssignments.$inferSelect;

export const fieldRoutePreviews = pgTable("field_route_previews", {
  id: uuid("id").primaryKey().defaultRandom(),
  territoryId: uuid("territory_id").references(() => salesTerritories.id),
  repUserId: varchar("rep_user_id").notNull().references(() => users.id),
  routeDate: date("route_date").notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  candidateSnapshot: jsonb("candidate_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
export type FieldRoutePreview = typeof fieldRoutePreviews.$inferSelect;

export const fieldRoutes = pgTable("field_routes", {
  id: uuid("id").primaryKey().defaultRandom(),
  previewId: uuid("preview_id").references(() => fieldRoutePreviews.id),
  territoryId: uuid("territory_id").references(() => salesTerritories.id),
  repUserId: varchar("rep_user_id").notNull().references(() => users.id),
  routeDate: date("route_date").notNull(),
  status: text("status").notNull().default("open"),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  frozenByUserId: varchar("frozen_by_user_id").references(() => users.id),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelledByUserId: varchar("cancelled_by_user_id").references(() => users.id),
  policyVersion: text("policy_version").notNull(),
  stopCount: integer("stop_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});
export type FieldRoute = typeof fieldRoutes.$inferSelect;

export const fieldRouteStops = pgTable("field_route_stops", {
  id: uuid("id").primaryKey().defaultRandom(),
  routeId: uuid("route_id").notNull().references(() => fieldRoutes.id),
  businessId: integer("business_id").notNull().references(() => businesses.id),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  plannedOrder: integer("planned_order").notNull(),
  recordFingerprint: text("record_fingerprint").notNull(),
  status: text("status").notNull().default("available"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  claimedByUserId: varchar("claimed_by_user_id").references(() => users.id),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("frs_route_id_idx").on(table.routeId),
]);
export type FieldRouteStop = typeof fieldRouteStops.$inferSelect;

export const fieldVisits = pgTable("field_visits", {
  id: uuid("id").primaryKey().defaultRandom(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  stopId: uuid("stop_id").notNull().references(() => fieldRouteStops.id),
  repUserId: varchar("rep_user_id").notNull().references(() => users.id),
  businessId: integer("business_id").notNull().references(() => businesses.id),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  visitedAt: timestamp("visited_at", { withTimezone: true }).notNull().defaultNow(),
  outcomeCode: text("outcome_code").notNull(),
  note: text("note"),
  confirmed: boolean("confirmed").notNull().default(false),
  latitude: numeric("latitude", { precision: 9, scale: 6 }),
  longitude: numeric("longitude", { precision: 9, scale: 6 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (table) => [
  index("fv_stop_id_idx").on(table.stopId),
  index("fv_rep_visited_idx").on(table.repUserId, table.visitedAt),
]);
export type FieldVisit = typeof fieldVisits.$inferSelect;

// ─── Sales Rep Ops Readiness Receipts ────────────────────────────────────────

export const READINESS_GATE_STATUSES = ['PASS', 'FAIL', 'BLOCKED_EXTERNAL', 'NOT_APPLICABLE'] as const;
export type ReadinessGateStatus = typeof READINESS_GATE_STATUSES[number];

export const READINESS_AGGREGATE_VERDICTS = ['PASS', 'FAIL', 'BLOCKED_EXTERNAL'] as const;
export type ReadinessAggregateVerdict = typeof READINESS_AGGREGATE_VERDICTS[number];

export const salesRepOpsReadinessRuns = pgTable("sales_rep_ops_readiness_runs", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull().unique(),
  releaseSha: text("release_sha").notNull(),
  migrationHead: text("migration_head").notNull(),
  configFingerprint: text("config_fingerprint").notNull(),
  populationFingerprint: text("population_fingerprint").notNull(),
  status: text("status").notNull().default("running"),
  gateResults: jsonb("gate_results").notNull().default([]),
  aggregateVerdict: text("aggregate_verdict"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  triggeredByUserId: varchar("triggered_by_user_id").references(() => users.id),
});

export const insertSalesRepOpsReadinessRunSchema = createInsertSchema(salesRepOpsReadinessRuns);
export type SalesRepOpsReadinessRun = typeof salesRepOpsReadinessRuns.$inferSelect;
export type InsertSalesRepOpsReadinessRun = typeof salesRepOpsReadinessRuns.$inferInsert;

export const salesRepPilotPreviews = pgTable("sales_rep_pilot_previews", {
  id: uuid("id").primaryKey().defaultRandom(),
  readinessRunId: integer("readiness_run_id").references(() => salesRepOpsReadinessRuns.id),
  previewFingerprint: text("preview_fingerprint").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  repUserIds: text("rep_user_ids").array().notNull(),
  candidateContactIds: integer("candidate_contact_ids").array().notNull(),
  candidateLocationIds: integer("candidate_location_ids").array().notNull(),
  policyVersion: text("policy_version").notNull(),
  verdictSummary: jsonb("verdict_summary").notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertSalesRepPilotPreviewSchema = createInsertSchema(salesRepPilotPreviews);
export type SalesRepPilotPreview = typeof salesRepPilotPreviews.$inferSelect;
export type InsertSalesRepPilotPreview = typeof salesRepPilotPreviews.$inferInsert;

// ── MI-05: CRO-03C native candidate evidence (0252) ──────────────────────────
// Stores encrypted per-field evidence produced by live CRO-03C provider
// executors. Bridge between provider transport and canonical projection.
// subject_type = 'business' → eligible for businesses.mainEmail projection.
// subject_type = 'person'   → Apollo reveal, held for MI-06 validation.

export const cro03cCandidateEvidence = pgTable("cro03c_candidate_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  generationId: uuid("generation_id").notNull().references(() => cro03cGenerations.id, { onDelete: "restrict" }),
  stageKey: text("stage_key").notNull(),
  field: text("field").notNull(),
  sourceRank: integer("source_rank").notNull().default(100),
  subjectType: text("subject_type").notNull(),
  disposition: text("disposition").notNull().default("staged"),
  confidence: integer("confidence").notNull().default(0),
  envelopeCiphertext: text("envelope_ciphertext").notNull(),
  envelopeNonce: text("envelope_nonce").notNull(),
  envelopeTag: text("envelope_tag").notNull(),
  envelopeKeyVersion: integer("envelope_key_version").notNull().default(1),
  normalizedValueHash: text("normalized_value_hash").notNull(),
  maskedValue: text("masked_value").notNull(),
  /** Apollo People Match confidence: 'high' | 'medium' | 'low' | 'none'. NULL for non-person candidates. */
  apolloMatchConfidence: text("apollo_match_confidence"),
  /** MI-06: FK to businesses — populated at evidence creation for MI-06+ candidates (nullable for pre-MI-06 rows). */
  businessId: integer("business_id").references(() => businesses.id, { onDelete: "restrict" }),
  /** MI-06: per-candidate metadata (e.g. { ownerTitle: "owner" } for Apollo person reveals). */
  candidateMetadata: jsonb("candidate_metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // MI-05: value hash included so multiple email candidates survive per (generation, stage, field).
  uniqueIndex("cro03c_candidate_evidence_gen_stage_field_value_uniq").on(table.generationId, table.stageKey, table.field, table.normalizedValueHash),
  index("cro03c_candidate_evidence_generation_idx").on(table.generationId),
]);
export type Cro03cCandidateEvidence = typeof cro03cCandidateEvidence.$inferSelect;

// ── Task #1978: Free-discovery candidate evidence (Sunbiz/free-email pipeline) ──
// Durable, contract-compatible run/generation envelope for FREE (non-paid)
// discovery activity (first-party contact-page crawl, JSON-LD, etc). Deliberately
// NOT inserted into cro03c_generations/cro03c_commands — those tables represent
// paid-provider billing/ceremony authority (activation policy + live runtime
// attestation + CRO-03A/B admission chain) which free discovery never performs
// or impersonates. Reuses the same envelope-encryption/hash/mask contract as
// cro03c_candidate_evidence (server/services/cro03/candidate-evidence-service.ts)
// so a later governed promotion into that table (under explicit operator
// authorization) can carry the value forward without re-deriving it.
export const freeDiscoveryGenerations = pgTable("free_discovery_generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  runKey: text("run_key").notNull().unique(),
  actorId: text("actor_id").notNull(),
  purpose: text("purpose").notNull().default("email_discovery"),
  reason: text("reason").notNull(),
  state: text("state").notNull().default("running"),
  subjectCount: integer("subject_count").notNull().default(0),
  candidateCount: integer("candidate_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type FreeDiscoveryGeneration = typeof freeDiscoveryGenerations.$inferSelect;

export const freeDiscoveryCandidates = pgTable("free_discovery_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  generationId: uuid("generation_id").notNull().references(() => freeDiscoveryGenerations.id, { onDelete: "restrict" }),
  field: text("field").notNull().default("email"),
  subjectType: text("subject_type").notNull(),
  businessId: integer("business_id").references(() => businesses.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
  domain: text("domain").notNull(),
  source: text("source").notNull(),
  /** 'role' = business-level inbox (info@, sales@...); 'named' = tied to one identified person. */
  attributionScope: text("attribution_scope").notNull(),
  /** Only populated for attributionScope='named' — the name/title evidence that justified attaching this address to one specific contact. */
  personNameEvidence: text("person_name_evidence"),
  personTitleEvidence: text("person_title_evidence"),
  disposition: text("disposition").notNull().default("staged"),
  confidence: integer("confidence").notNull().default(0),
  envelopeCiphertext: text("envelope_ciphertext").notNull(),
  envelopeNonce: text("envelope_nonce").notNull(),
  envelopeTag: text("envelope_tag").notNull(),
  envelopeKeyVersion: integer("envelope_key_version").notNull().default(1),
  normalizedValueHash: text("normalized_value_hash").notNull(),
  maskedValue: text("masked_value").notNull(),
  /** Set only once a governed promotion writes the value into cro03c_candidate_evidence — immutable provenance link, never rewritten. */
  promotedCandidateEvidenceId: uuid("promoted_candidate_evidence_id").references(() => cro03cCandidateEvidence.id, { onDelete: "set null" }),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("free_discovery_candidates_gen_field_value_uniq").on(table.generationId, table.field, table.normalizedValueHash),
  index("free_discovery_candidates_business_idx").on(table.businessId),
  index("free_discovery_candidates_contact_idx").on(table.contactId),
  index("free_discovery_candidates_domain_idx").on(table.domain),
]);
export type FreeDiscoveryCandidate = typeof freeDiscoveryCandidates.$inferSelect;

// ── South Florida Prospecting (migration 0277/0278) ─────────────────────────
// Declared in the Drizzle schema as well as SQL migrations because production
// Publish applies schema diffs and does not execute arbitrary migration files.
export const sfpPrograms = pgTable("sfp_programs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  countyFips: text("county_fips").array().notNull(),
  verticalIds: text("vertical_ids").array().notNull(),
  maxCohortSize: integer("max_cohort_size").notNull().default(100),
  policyVersion: integer("policy_version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(false),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  activatedBy: text("activated_by"),
  recurringEnabled: boolean("recurring_enabled").notNull().default(false),
  scheduleConfig: jsonb("schedule_config").notNull().default({ freeBatch: 25, paidBatch: 10, validationBatch: 25, campaignStaging: 0 }),
  /**
   * Which vertical taxonomy version (see sfp-vertical-classifier.ts) this
   * program's `verticalIds` are drawn from, and which the classification
   * bridge and cohort selector must use for both live-text classification
   * and evidence admission. Defaults to 1 (legacy five-package taxonomy) so
   * every pre-existing program is unaffected.
   */
  taxonomyVersion: integer("taxonomy_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
}, (table) => [
  // Task #1998 round-3 correction (item 4): the PROGRAM's owned configuration
  // cap is a distinct DB-enforced fact from sfp_cohort_runs.cohort_size's own
  // 0-100 RUN-RESULT constraint below — this one bounds what an operator may
  // configure as the program's ceiling, never a value borrowed from the run
  // table. See migrations/0285_sfp_program_max_cohort_size_range.sql.
  check("sfp_programs_max_cohort_size_range", sql`max_cohort_size BETWEEN 1 AND 100`),
  check("sfp_programs_taxonomy_version_chk", sql`taxonomy_version IN (1, 2)`),
]);

export const sfpCohortRuns = pgTable("sfp_cohort_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id").notNull().references(() => sfpPrograms.id),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: text("status").notNull().default("draft"),
  cohortSize: integer("cohort_size").notNull().default(0),
  cohortHash: text("cohort_hash"),
  frozenAt: timestamp("frozen_at", { withTimezone: true }),
  releaseSha: text("release_sha").notNull().default(""),
  actorId: text("actor_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  errorDetail: text("error_detail"),
  /** Immutable lifecycle of the frozen cohort itself — separate from
   *  downstream stage-progress status (sfp_stage_runs.state). Only
   *  'frozen' with voidedAt/supersededAt both null is consumable
   *  downstream. */
  cohortState: text("cohort_state").notNull().default("freezing"),
  requestHash: text("request_hash"),
  configHash: text("config_hash"),
  requestPayload: jsonb("request_payload"),
  policyVersions: jsonb("policy_versions"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: text("voided_by"),
  voidReason: text("void_reason"),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  supersededByRunId: uuid("superseded_by_run_id"),
  supersededByActor: text("superseded_by_actor"),
  /** Correction 7 (migration 0282): explicit frozen source-snapshot / high-water
   *  identity captured inside the freeze transaction, distinct from requestHash —
   *  see south-florida-prospecting.ts freezeCohortTx. */
  sourceSnapshotHash: text("source_snapshot_hash"),
  sourceHighWaterBusinessId: integer("source_high_water_business_id"),
  sourceBusinessCount: integer("source_business_count"),
  sourceTxid: bigint("source_txid", { mode: "number" }),
  sourceSnapshotCapturedAt: timestamp("source_snapshot_captured_at", { withTimezone: true }),
}, (table) => [
  index("idx_sfp_cohort_runs_program").on(table.programId, table.createdAt),
  index("idx_sfp_cohort_runs_cohort_state").on(table.cohortState, table.createdAt),
  check("sfp_cohort_runs_cohort_size_range", sql`cohort_size BETWEEN 0 AND 100`),
]);

export const sfpCohortMembers = pgTable("sfp_cohort_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  // RESTRICT (not CASCADE): a frozen cohort run's membership evidence is
  // permanent history — deleting the run row must never silently take its
  // members with it. See migration 0281_sfp_corrections.sql.
  cohortRunId: uuid("cohort_run_id").notNull().references(() => sfpCohortRuns.id, { onDelete: "restrict" }),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  roiScore: integer("roi_score").notNull().default(0),
  geographyClass: text("geography_class").notNull().default("unknown"),
  geographySource: text("geography_source").notNull().default("none"),
  countyFips: text("county_fips"),
  vertical: text("vertical"),
  exclusionReason: text("exclusion_reason"),
  selectionRank: integer("selection_rank"),
  isCanary: boolean("is_canary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Classifier + geography resolver evidence persisted per member — see
  // migration 0281_sfp_corrections.sql and sfp-vertical-classifier.ts /
  // sfp-geography-resolver.ts.
  classifierVersion: integer("classifier_version"),
  classifierOutcome: text("classifier_outcome"),
  classifierConfidence: numeric("classifier_confidence", { precision: 4, scale: 3 }),
  classifierMatchedTarget: text("classifier_matched_target"),
  classifierReasons: jsonb("classifier_reasons"),
  classifierEvidenceHash: text("classifier_evidence_hash"),
  geographyResolverVersion: integer("geography_resolver_version"),
  geographyOutcome: text("geography_outcome"),
  geographyLocationId: integer("geography_location_id"),
  geographyReasons: jsonb("geography_reasons"),
}, (table) => [
  uniqueIndex("sfp_cohort_members_run_business_uidx").on(table.cohortRunId, table.businessId),
  index("idx_sfp_cohort_members_run").on(table.cohortRunId, table.roiScore),
]);

/** One row per (cohortRunId, businessId) scanned during a freeze attempt —
 *  the full ordered disposition taxonomy. sum(all rows for a run) must equal
 *  the run's total scanned canonical businesses. */
export const sfpCohortDecisions = pgTable("sfp_cohort_decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  // RESTRICT (not CASCADE) — see sfpCohortMembers comment above.
  cohortRunId: uuid("cohort_run_id").notNull().references(() => sfpCohortRuns.id, { onDelete: "restrict" }),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  disposition: text("disposition").notNull(),
  dispositionDetail: text("disposition_detail"),
  suppressionScope: text("suppression_scope"),
  suppressionSubjectHash: text("suppression_subject_hash"),
  // Task #1998 round-3 correction (item 3): structured, genuinely
  // subject-aware suppression/bounce evidence — see SuppressionEvidence /
  // SuppressionSubject in roi-cohort-selector.ts. `suppressionSubjects`
  // carries EVERY determining contact, never a single sample.
  suppressionAuthority: text("suppression_authority"),
  suppressionReasonCode: text("suppression_reason_code"),
  suppressionEvidenceRef: text("suppression_evidence_ref"),
  suppressionChannel: text("suppression_channel"),
  suppressionSubjects: jsonb("suppression_subjects"),
  suppressionBusinessWideRuleApplied: boolean("suppression_business_wide_rule_applied").notNull().default(false),
  geographyClass: text("geography_class"),
  geographySource: text("geography_source"),
  vertical: text("vertical"),
  roiScore: integer("roi_score"),
  selected: boolean("selected").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  classifierVersion: integer("classifier_version"),
  classifierOutcome: text("classifier_outcome"),
  classifierConfidence: numeric("classifier_confidence", { precision: 4, scale: 3 }),
  classifierMatchedTarget: text("classifier_matched_target"),
  classifierReasons: jsonb("classifier_reasons"),
  classifierEvidenceHash: text("classifier_evidence_hash"),
  geographyResolverVersion: integer("geography_resolver_version"),
  geographyOutcome: text("geography_outcome"),
  geographyLocationId: integer("geography_location_id"),
  geographyReasons: jsonb("geography_reasons"),
  // Task #1999 (C1/Architecture correction 1): freeze-time evidence pinning. The
  // selected sfp_classification_evidence row is an immutable, append-only fact — a
  // later classification run inserting a new row for the same business can never
  // retroactively change what THIS decision meant at freeze time, because this FK
  // points at one specific row, not at "the latest row for this business".
  classificationEvidenceId: uuid("classification_evidence_id").references(() => sfpClassificationEvidence.id, { onDelete: "restrict" }),
  classificationPolicyVersion: integer("classification_policy_version"),
  classificationEvidenceHash: text("classification_evidence_hash"),
  classificationModelVersion: text("classification_model_version"),
  classificationPromptVersion: text("classification_prompt_version"),
  classificationClassifierVersion: integer("classification_classifier_version"),
}, (table) => [
  uniqueIndex("sfp_cohort_decisions_run_business_uidx").on(table.cohortRunId, table.businessId),
  index("idx_sfp_cohort_decisions_run_disposition").on(table.cohortRunId, table.disposition),
]);

/** Audit receipt for the one-time legacy-key SFP config initializer. */
export const sfpConfigInitReceipts = pgTable("sfp_config_init_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id").notNull().references(() => sfpPrograms.id),
  source: text("source").notNull(),
  sourceHash: text("source_hash").notNull(),
  resultingConfig: jsonb("resulting_config").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sfpFunnelSnapshots = pgTable("sfp_funnel_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  // RESTRICT (not CASCADE) — see sfpCohortMembers comment above. The frozen
  // funnel snapshot is the sole reconciliation-of-record for a cohort run
  // (VFC-05) and must never be deletable as a side effect of deleting the
  // run row.
  cohortRunId: uuid("cohort_run_id").notNull().references(() => sfpCohortRuns.id, { onDelete: "restrict" }).unique(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  totalBusinesses: integer("total_businesses").notNull().default(0),
  southFlorida: integer("south_florida").notNull().default(0),
  outsideGeography: integer("outside_geography").notNull().default(0),
  geographyUnresolved: integer("geography_unresolved").notNull().default(0),
  inTargetVertical: integer("in_target_vertical").notNull().default(0),
  verticalUnresolved: integer("vertical_unresolved").notNull().default(0),
  dbprExcluded: integer("dbpr_excluded").notNull().default(0),
  suppressed: integer("suppressed").notNull().default(0),
  bouncedInvalidOnly: integer("bounced_invalid_only").notNull().default(0),
  existingCustomer: integer("existing_customer").notNull().default(0),
  testDemoInternal: integer("test_demo_internal").notNull().default(0),
  inactiveEntity: integer("inactive_entity").notNull().default(0),
  duplicateConflict: integer("duplicate_conflict").notNull().default(0),
  alreadyEnriched: integer("already_enriched").notNull().default(0),
  requiresFreeDiscovery: integer("requires_free_discovery").notNull().default(0),
  requiresPaidDiscovery: integer("requires_paid_discovery").notNull().default(0),
  readyForValidation: integer("ready_for_validation").notNull().default(0),
  providerValid: integer("provider_valid").notNull().default(0),
  outreachEligible: integer("outreach_eligible").notNull().default(0),
  reviewRequired: integer("review_required").notNull().default(0),
  selectedFrozen: integer("selected_frozen").notNull().default(0),
});

export const sfpOutreachPolicyDocuments = pgTable("sfp_outreach_policy_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: integer("version").notNull().unique(),
  documentHash: text("document_hash").notNull(),
  validationTtlDays: integer("validation_ttl_days").notNull(),
  acceptedOutcomes: jsonb("accepted_outcomes").notNull(),
  retryableOutcomes: jsonb("retryable_outcomes").notNull(),
  roleInboxPolicy: jsonb("role_inbox_policy").notNull(),
  consentTierPolicy: jsonb("consent_tier_policy").notNull(),
  reasonCodes: jsonb("reason_codes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by").notNull(),
});

export const sfpOutreachPolicyControl = pgTable("sfp_outreach_policy_control", {
  // No declarative check() here on purpose: drizzle-kit 0.31.10's push-based
  // generator (used by Replit Publish to diff dev vs production schemas)
  // introspects this table's CHECK constraint from Postgres — where
  // pg_get_constraintdef already returns the full "CHECK (singleton)" text —
  // and then wraps that stored text in another "CHECK (...)" when emitting a
  // fresh CREATE TABLE for production, producing invalid SQL
  // ("CHECK (CHECK (singleton))"). This happens purely because the table is
  // new to production; declaring the check in schema.ts cannot avoid it as
  // long as the constraint also exists in dev. The singleton-enforcing CHECK
  // is instead applied out-of-band via ensureSfpOutreachPolicyControlCheckConstraint()
  // (server/services/cro03/sfp-outreach-policy.ts), matching migration
  // 0289/0291's hand-written DDL exactly (see PM-07 in the Task #2001
  // corrective audit, and the Publish CHECK-doubling bug found afterward).
  singleton: boolean("singleton").notNull().default(true),
  activePolicyId: uuid("active_policy_id").notNull().references(() => sfpOutreachPolicyDocuments.id),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  activatedBy: text("activated_by").notNull(),
}, (table) => [
  primaryKey({ columns: [table.singleton] }),
]);

export const sfpOutreachEligibility = pgTable("sfp_outreach_eligibility", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortRunId: uuid("cohort_run_id").notNull().references(() => sfpCohortRuns.id),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  candidateId: uuid("candidate_id").references(() => freeDiscoveryCandidates.id, { onDelete: "set null" }),
  // Immutable source identity for contact-sourced validation. RESTRICT retains
  // the original CRM row for audit/staging history; never null it on deletion.
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
  contactBusinessLinkDecisionId: uuid("contact_business_link_decision_id")
    .references(() => contactBusinessLinkDecisions.id, { onDelete: "restrict" }),
  contactBusinessLinkRevision: integer("contact_business_link_revision"),
  policyVersion: integer("policy_version").notNull().default(1),
  status: text("status").notNull(),
  decisionReason: text("decision_reason").notNull().default(""),
  zbOutcome: text("zb_outcome"),
  validationAt: timestamp("validation_at", { withTimezone: true }),
  validationAgeDays: integer("validation_age_days"),
  namedContact: boolean("named_contact").notNull().default(false),
  roleInbox: boolean("role_inbox").notNull().default(false),
  maskedEmail: text("masked_email"),
  discoverySource: text("discovery_source"),
  evidenceConfidence: integer("evidence_confidence"),
  suppressionStatus: text("suppression_status").notNull().default("unchecked"),
  outreachPolicyVersion: integer("outreach_policy_version"),
  outreachPolicyReason: text("outreach_policy_reason"),
  validationOperationId: uuid("validation_operation_id").references(() => providerOperations.id, { onDelete: "set null" }),
  stagingIntentId: uuid("staging_intent_id"),
  campaignStagedAt: timestamp("campaign_staged_at", { withTimezone: true }),
  campaignStagedBy: text("campaign_staged_by"),
  // Task #2000+: additive typed source lineage + policy pin. The one-of source
  // reference is free candidate, paid evidence, or an existing verified-linked
  // contact whose email is revalidated through the same ZeroBounce policy.
  sourceKind: text("source_kind"),
  paidCandidateEvidenceId: uuid("paid_candidate_evidence_id").references(() => sfpPaidCandidateEvidence.id, { onDelete: "set null" }),
  normalizedValueHash: text("normalized_value_hash"),
  normalizedValueHashVersion: integer("normalized_value_hash_version"),
  policyDocumentId: uuid("policy_document_id").references(() => sfpOutreachPolicyDocuments.id),
  policyDocumentHash: text("policy_document_hash"),
  consentTier: text("consent_tier"),
  validationExpiresAt: timestamp("validation_expires_at", { withTimezone: true }),
  rawProviderStatus: text("raw_provider_status"),
  rawProviderSubstatus: text("raw_provider_substatus"),
  reusedFromOperationId: uuid("reused_from_operation_id").references(() => providerOperations.id, { onDelete: "set null" }),
  recipientAssociationPins: jsonb("recipient_association_pins").notNull().default([]),
  reasonCodes: jsonb("reason_codes").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sfp_outreach_run_business_recipient_policy_uidx")
    .on(table.cohortRunId, table.businessId, table.policyVersion, table.normalizedValueHash),
  // Non-recipient placeholders retain their old one-per-business identity.
  // Qualified recipient rows no longer overwrite another address's receipt.
  uniqueIndex("sfp_outreach_run_business_unresolved_policy_uidx")
    .on(table.cohortRunId, table.businessId, table.policyVersion)
    .where(sql`normalized_value_hash IS NULL`),
  index("idx_sfp_outreach_eligibility_run").on(table.cohortRunId, table.status),
  index("idx_sfp_outreach_eligibility_status").on(table.status, table.createdAt),
  index("sfp_outreach_candidate_idx").on(table.candidateId),
  index("sfp_outreach_eligibility_paid_evidence_idx").on(table.paidCandidateEvidenceId),
  index("sfp_outreach_eligibility_contact_idx").on(table.contactId),
  index("sfp_outreach_eligibility_normalized_hash_idx").on(table.businessId, table.normalizedValueHash),
  index("sfp_outreach_eligibility_policy_idx").on(table.policyDocumentId),
  check(
    "sfp_outreach_eligibility_source_ref_one_of_chk",
    sql`
      source_kind IS NULL
      OR (source_kind = 'free' AND candidate_id IS NOT NULL AND paid_candidate_evidence_id IS NULL AND contact_id IS NULL)
      OR (source_kind = 'paid' AND paid_candidate_evidence_id IS NOT NULL AND candidate_id IS NULL AND contact_id IS NULL)
      OR (source_kind = 'contact' AND contact_id IS NOT NULL AND candidate_id IS NULL
          AND paid_candidate_evidence_id IS NULL AND contact_business_link_decision_id IS NOT NULL
          AND contact_business_link_revision IS NOT NULL AND normalized_value_hash IS NOT NULL
          AND normalized_value_hash_version IS NOT NULL AND normalized_value_hash_version IN (0,1))
    `,
  ),
]);

export const sfpNamedEmailEligibilityReviews = pgTable("sfp_named_email_eligibility_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  eligibilityId: uuid("eligibility_id").notNull().references(() => sfpOutreachEligibility.id, { onDelete: "restrict" }),
  decision: text("decision").notNull(),
  reviewerId: text("reviewer_id").notNull(),
  reason: text("reason").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  expectedUpdatedAt: timestamp("expected_updated_at", { withTimezone: true }).notNull(),
  policyDocumentId: uuid("policy_document_id").notNull().references(() => sfpOutreachPolicyDocuments.id, { onDelete: "restrict" }),
  policyDocumentHash: text("policy_document_hash").notNull(),
  validationOperationId: uuid("validation_operation_id").references(() => providerOperations.id, { onDelete: "restrict" }),
  sourceKind: text("source_kind").notNull(),
  sourceReferenceId: text("source_reference_id").notNull(),
  contactBusinessLinkDecisionId: uuid("contact_business_link_decision_id").references(() => contactBusinessLinkDecisions.id, { onDelete: "restrict" }),
  contactBusinessLinkRevision: integer("contact_business_link_revision"),
  normalizedValueHash: text("normalized_value_hash").notNull(),
  normalizedValueHashVersion: integer("normalized_value_hash_version").notNull(),
  validationExpiresAt: timestamp("validation_expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sfp_named_email_reviews_eligibility_idx").on(table.eligibilityId, table.createdAt),
  uniqueIndex("sfp_named_email_reviews_snapshot_uidx").on(table.eligibilityId, table.expectedUpdatedAt),
  check("sfp_named_email_reviews_decision_check", sql`decision IN ('approved','rejected')`),
  check("sfp_named_email_reviews_source_check", sql`
    (source_kind = 'contact' AND contact_business_link_decision_id IS NOT NULL AND contact_business_link_revision IS NOT NULL)
    OR (source_kind IN ('free','paid') AND contact_business_link_decision_id IS NULL AND contact_business_link_revision IS NULL)
  `),
]);

export const sfpStageRuns = pgTable("sfp_stage_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortRunId: uuid("cohort_run_id").references(() => sfpCohortRuns.id, { onDelete: "cascade" }),
  programId: uuid("program_id").references(() => sfpPrograms.id, { onDelete: "restrict" }),
  selectionSnapshot: jsonb("selection_snapshot"),
  stage: text("stage").notNull(), idempotencyKey: text("idempotency_key").notNull(), actorId: text("actor_id").notNull(),
  state: text("state").notNull().default("pending"), maxItems: integer("max_items").notNull(),
  providerKeys: jsonb("provider_keys").notNull().default([]),
  estimatedCostMicros: bigint("estimated_cost_micros", { mode: "number" }).notNull().default(0),
  reservedCostMicros: bigint("reserved_cost_micros", { mode: "number" }).notNull().default(0),
  settledCostMicros: bigint("settled_cost_micros", { mode: "number" }).notNull().default(0),
  billingUnknownCount: integer("billing_unknown_count").notNull().default(0),
  selectedCount: integer("selected_count").notNull().default(0), processedCount: integer("processed_count").notNull().default(0),
  succeededCount: integer("succeeded_count").notNull().default(0), failedCount: integer("failed_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0), claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }), lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  terminalReason: text("terminal_reason"), authorization: jsonb("authorization"),
  payloadHash: text("payload_hash"), previewSnapshotHash: text("preview_snapshot_hash"),
  storedResult: jsonb("stored_result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sfp_stage_runs_stage_idempotency_uidx").on(table.stage, table.idempotencyKey),
  index("sfp_stage_runs_cohort_stage_idx").on(table.cohortRunId, table.stage, table.createdAt),
  index("sfp_stage_runs_program_stage_idx").on(table.programId, table.stage, table.createdAt),
  check("sfp_stage_runs_parent_scope_chk", sql`(
    cohort_run_id IS NOT NULL AND program_id IS NULL AND selection_snapshot IS NULL
  ) OR (
    cohort_run_id IS NULL AND program_id IS NOT NULL
    AND selection_snapshot IS NOT NULL AND jsonb_typeof(selection_snapshot)='object'
    AND selection_snapshot ? 'programHash' AND selection_snapshot ? 'businessPins'
  )`),
]);

export const sfpStageItems = pgTable("sfp_stage_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  stageRunId: uuid("stage_run_id").notNull().references(() => sfpStageRuns.id, { onDelete: "cascade" }),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  provider: text("provider"), candidateId: uuid("candidate_id").references(() => freeDiscoveryCandidates.id, { onDelete: "set null" }),
  // Task #1999 (C3): paid-provider (Outscraper/Apollo/Serper) evidence lives in its
  // own physically separate, encrypted table — never in free_discovery_candidates or
  // cro03c_candidate_evidence. `candidateId` stays scoped to free_discovery_candidates only.
  // Exactly one of candidateId / paidCandidateEvidenceId may be set, and only when
  // outcome_code='candidate_found' — enforced by the CHECK below.
  paidCandidateEvidenceId: uuid("paid_candidate_evidence_id").references(() => sfpPaidCandidateEvidence.id, { onDelete: "set null" }),
  providerOperationId: uuid("provider_operation_id").references(() => providerOperations.id, { onDelete: "set null" }),
  state: text("state").notNull().default("pending"), attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(), claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }), outcomeCode: text("outcome_code"),
  redactedResult: jsonb("redacted_result").notNull().default({}),
  gapVector: jsonb("gap_vector"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sfp_stage_items_run_business_provider_uidx").on(table.stageRunId, table.businessId, table.provider),
  index("sfp_stage_items_business_idx").on(table.businessId, table.createdAt),
  index("sfp_stage_items_paid_evidence_idx").on(table.paidCandidateEvidenceId),
  check(
    "sfp_stage_items_candidate_ref_one_of_chk",
    sql`
      NOT (candidate_id IS NOT NULL AND paid_candidate_evidence_id IS NOT NULL)
      AND (
        provider NOT IN ('outscraper', 'apollo', 'serper')
        OR outcome_code IS DISTINCT FROM 'candidate_found'
        OR ((candidate_id IS NOT NULL) <> (paid_candidate_evidence_id IS NOT NULL))
      )
      AND (
        provider NOT IN ('outscraper', 'apollo', 'serper')
        OR outcome_code = 'candidate_found'
        OR (candidate_id IS NULL AND paid_candidate_evidence_id IS NULL)
      )
      AND (
        provider IN ('outscraper', 'apollo', 'serper') OR paid_candidate_evidence_id IS NULL
      )
    `,
  ),
]);

/** Task #1999 (C1): append-only pre-cohort classification contract. Independent of
 *  cohort_run_id by design — pre-cohort classification happens BEFORE a cohort exists
 *  (Phase A resolves businesses from vertical-unresolved to target-vertical-eligible;
 *  freeze, which is cohort-bound, happens afterward and only reads the latest
 *  admissible row here). Never persist pre-cohort work into sfp_stage_runs/sfp_cohort_*. */
export const sfpClassificationRuns = pgTable("sfp_classification_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id").notNull().references(() => sfpPrograms.id, { onDelete: "restrict" }),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  actorId: text("actor_id").notNull(),
  state: text("state").notNull().default("pending"),
  maxBusinesses: integer("max_businesses").notNull(),
  policyVersion: integer("policy_version").notNull(),
  classifierVersion: integer("classifier_version").notNull(),
  configHash: text("config_hash").notNull(),
  payloadHash: text("payload_hash"),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  estimatedCostMicros: bigint("estimated_cost_micros", { mode: "number" }).notNull().default(0),
  reservedCostMicros: bigint("reserved_cost_micros", { mode: "number" }).notNull().default(0),
  settledCostMicros: bigint("settled_cost_micros", { mode: "number" }).notNull().default(0),
  billingUnknownCount: integer("billing_unknown_count").notNull().default(0),
  selectedCount: integer("selected_count").notNull().default(0),
  processedCount: integer("processed_count").notNull().default(0),
  succeededCount: integer("succeeded_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  terminalReason: text("terminal_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sfp_classification_runs_program_idx").on(table.programId, table.createdAt),
]);

/** Task #1999 (C1): one row per (run, business) attempted by the pre-cohort bridge.
 *  Append-only in spirit — a row is written once per run/business pair and only its
 *  terminal state/evidenceId are ever set by the run that owns it. */
export const sfpClassificationItems = pgTable("sfp_classification_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => sfpClassificationRuns.id, { onDelete: "restrict" }),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  state: text("state").notNull().default("pending"),
  outcomeCode: text("outcome_code"),
  evidenceId: uuid("evidence_id").references(() => sfpClassificationEvidence.id, { onDelete: "restrict" }),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sfp_classification_items_run_business_uidx").on(table.runId, table.businessId),
  index("sfp_classification_items_business_idx").on(table.businessId, table.createdAt),
]);

/** Task #1999 (C1/C2): append-only pre-cohort classification evidence. Every row is a
 *  complete, immutable classification decision for one business as of one evidence
 *  bundle. Rows are NEVER updated — "latest admissible" is a read-time, deterministic
 *  selection (policyVersion = the currently active policy, ORDER BY createdAt DESC,
 *  tie-broken by evidenceHash) that a later run can supersede only by inserting a NEW
 *  row, never by mutating this one. Freeze pins the selected row's id/hash/policy/
 *  classifier version into sfp_cohort_decisions so a later run can never retroactively
 *  change the meaning of an already-frozen cohort. */
export const sfpClassificationEvidence = pgTable("sfp_classification_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  evidenceHash: text("evidence_hash").notNull(),
  sourceRefs: jsonb("source_refs").notNull().default([]),
  /**
   * RULESET version (matches CLASSIFIER_VERSION in sfp-vertical-classifier.ts)
   * as of migration 0301. Rows created before that migration hold the
   * TAXONOMY version in this column (a pre-existing naming/write bug) — see
   * `taxonomyVersion` below, which was backfilled from this column's old
   * values and is the column callers should trust for "which target list".
   */
  classifierVersion: integer("classifier_version").notNull(),
  /** Which target-vertical taxonomy (1 = legacy five-package, 2 = South Florida v2) this evidence was produced against. Independent of classifierVersion. */
  taxonomyVersion: integer("taxonomy_version").notNull().default(1),
  modelVersion: text("model_version"),
  promptVersion: text("prompt_version"),
  policyVersion: integer("policy_version").notNull(),
  outcome: text("outcome").notNull(),
  confidence: numeric("confidence", { precision: 4, scale: 3 }),
  reasonCodes: jsonb("reason_codes").notNull().default([]),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
  terminalState: text("terminal_state").notNull().default("completed"),
  /** Canonical target vertical ID this evidence resolved to, when outcome='target'. Null otherwise. */
  resolvedVerticalId: text("resolved_vertical_id"),
  /**
   * Which classifier confidence tier produced the target resolution.
   * Only 'resolved_high' may be used by a selector to admit a business on
   * evidence alone (no corroborating live-text match); 'resolved_medium'
   * and any target reached via website-evidence promotion or OpenAI
   * escalation leave this null and require independent corroboration.
   */
  admissionTier: text("admission_tier"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sfp_classification_evidence_business_idx").on(table.businessId, table.policyVersion, table.createdAt),
  index("sfp_classification_evidence_resolved_vertical_idx").on(table.businessId, table.classifierVersion, table.taxonomyVersion, table.policyVersion, table.resolvedVerticalId),
  check(
    "sfp_classification_evidence_outcome_chk",
    sql`outcome IN ('target', 'non_target', 'review_required')`,
  ),
  check(
    "sfp_classification_evidence_admission_tier_chk",
    sql`admission_tier IS NULL OR admission_tier IN ('resolved_high', 'resolved_medium')`,
  ),
  check(
    "sfp_classification_evidence_resolved_vertical_target_chk",
    sql`resolved_vertical_id IS NULL OR outcome = 'target'`,
  ),
]);

/**
 * Bounded frozen-snapshot execution for Phase A classification (South
 * Florida enrichment). A snapshot pins an exact set of business IDs plus
 * every decision-relevant fact used to admit them (identity fingerprint,
 * geography, vertical/taxonomy decision inputs, hard-exclusion/suppression
 * state, DBPR lineage) at freeze time. New businesses entering the general
 * candidate pool can never invalidate an already-frozen snapshot — only a
 * change to one of THIS snapshot's own frozen businesses can, and that is
 * re-verified at run time (see runFrozenClassificationSnapshot), removing
 * only the changed business rather than rejecting the whole snapshot.
 * One-time claim (claimed_at) + expiry make execution idempotent and bounded.
 */
export const sfpClassificationSnapshots = pgTable("sfp_classification_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id").notNull().references(() => sfpPrograms.id, { onDelete: "restrict" }),
  actorId: text("actor_id").notNull(),
  taxonomyVersion: integer("taxonomy_version").notNull(),
  policyVersion: integer("policy_version").notNull(),
  targetIds: jsonb("target_ids").notNull().default([]),
  allowedProvider: text("allowed_provider").notNull(),
  maxUnits: integer("max_units").notNull(),
  businessIds: jsonb("business_ids").notNull().default([]),
  /** Per-business decision-relevant facts captured at freeze time, keyed by business id (as string). */
  perBusinessFacts: jsonb("per_business_facts").notNull().default({}),
  snapshotHash: text("snapshot_hash").notNull(),
  state: text("state").notNull().default("pending"),
  claimToken: uuid("claim_token"),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  runId: uuid("run_id").references(() => sfpClassificationRuns.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sfp_classification_snapshots_program_idx").on(table.programId, table.createdAt),
  check(
    "sfp_classification_snapshots_state_chk",
    sql`state IN ('pending', 'claimed', 'completed', 'expired')`,
  ),
]);

/** Explicit, leased cursor for recurring provider-free Phase A classification.
 * It is separate from cohort/staging state and does not grant send authority. */
export const sfpFreeClassificationContinuations = pgTable("sfp_free_classification_continuations", {
  programId: uuid("program_id").primaryKey().references(() => sfpPrograms.id, { onDelete: "restrict" }),
  state: text("state").notNull().default("idle"),
  highWaterBusinessId: integer("high_water_business_id").notNull().default(0),
  stopBusinessId: integer("stop_business_id").notNull().default(0),
  policyVersion: integer("policy_version").notNull(),
  taxonomyVersion: integer("taxonomy_version").notNull(),
  classifierVersion: integer("classifier_version").notNull(),
  scannedCount: bigint("scanned_count", { mode: "number" }).notNull().default(0),
  processedCount: bigint("processed_count", { mode: "number" }).notNull().default(0),
  targetCount: bigint("target_count", { mode: "number" }).notNull().default(0),
  rejectedCount: bigint("rejected_count", { mode: "number" }).notNull().default(0),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastError: text("last_error"),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, () => [
  check("sfp_free_classification_continuations_state_chk", sql`state IN ('idle','running','paused','completed')`),
]);

/** Task #1999 (C3): additive, encrypted, provider-neutral evidence table for
 *  Outscraper/Apollo/paid-Serper-sourced candidates. Physically separate from
 *  free_discovery_candidates (free-only) and cro03c_candidate_evidence (whose
 *  generation_id FK is NOT NULL and must not be weakened or fabricated for SFP). */
export const sfpPaidCandidateEvidence = pgTable("sfp_paid_candidate_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  provider: text("provider").notNull(),
  field: text("field").notNull().default("email"),
  subjectType: text("subject_type").notNull(),
  providerOperationId: uuid("provider_operation_id").references(() => providerOperations.id, { onDelete: "set null" }),
  disposition: text("disposition").notNull().default("staged"),
  confidence: integer("confidence").notNull().default(0),
  envelopeCiphertext: text("envelope_ciphertext").notNull(),
  envelopeNonce: text("envelope_nonce").notNull(),
  envelopeTag: text("envelope_tag").notNull(),
  envelopeKeyVersion: integer("envelope_key_version").notNull().default(1),
  normalizedValueHash: text("normalized_value_hash").notNull(),
  maskedValue: text("masked_value").notNull(),
  personNameEvidence: text("person_name_evidence"),
  personTitleEvidence: text("person_title_evidence"),
  candidateMetadata: jsonb("candidate_metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sfp_paid_candidate_evidence_provider_biz_field_value_uniq").on(table.provider, table.businessId, table.field, table.normalizedValueHash),
  index("sfp_paid_candidate_evidence_business_idx").on(table.businessId),
  check(
    "sfp_paid_candidate_evidence_provider_chk",
    sql`provider IN ('outscraper', 'apollo', 'serper')`,
  ),
]);
export type SfpPaidCandidateEvidence = typeof sfpPaidCandidateEvidence.$inferSelect;

export const contactBusinessSfpLinkEvidence = pgTable("contact_business_sfp_link_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  decisionKey: text("decision_key").notNull().unique(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  eligibilityId: uuid("eligibility_id").notNull().references(() => sfpOutreachEligibility.id, { onDelete: "restrict" }),
  sourceKind: text("source_kind").notNull(),
  freeCandidateId: uuid("free_candidate_id").references(() => freeDiscoveryCandidates.id, { onDelete: "restrict" }),
  paidCandidateEvidenceId: uuid("paid_candidate_evidence_id").references(() => sfpPaidCandidateEvidence.id, { onDelete: "restrict" }),
  normalizedValueHash: text("normalized_value_hash").notNull(),
  normalizedValueHashVersion: integer("normalized_value_hash_version").notNull(),
  contactEmailTokenHash: text("contact_email_token_hash").notNull(),
  validationOperationId: uuid("validation_operation_id").notNull().references(() => providerOperations.id, { onDelete: "restrict" }),
  factsHash: text("facts_hash").notNull(),
  facts: jsonb("facts").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("contact_business_sfp_link_evidence_subject_idx").on(table.contactId, table.businessId, table.createdAt),
  index("contact_business_sfp_link_evidence_eligibility_idx").on(table.eligibilityId),
  check("contact_business_sfp_link_evidence_source_chk", sql`
    (source_kind='free' AND free_candidate_id IS NOT NULL AND paid_candidate_evidence_id IS NULL)
    OR (source_kind='paid' AND paid_candidate_evidence_id IS NOT NULL AND free_candidate_id IS NULL)
  `),
  check("contact_business_sfp_link_evidence_hash_version_chk", sql`normalized_value_hash_version IN (0,1)`),
]);

export const contactBusinessFirstPartyLinkEvidence = pgTable("contact_business_first_party_link_evidence", {
  id: uuid("id").primaryKey().defaultRandom(),
  decisionKey: text("decision_key").notNull().unique(),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  candidateId: uuid("candidate_id").notNull().references(() => freeDiscoveryCandidates.id, { onDelete: "restrict" }),
  candidateHash: text("candidate_hash").notNull(),
  contactEmailTokenHash: text("contact_email_token_hash").notNull(),
  addressDomain: text("address_domain").notNull(),
  domainBasis: text("domain_basis").notNull(),
  attributionScope: text("attribution_scope").notNull(),
  candidateSource: text("candidate_source").notNull(),
  ruleVersion: text("rule_version").notNull(),
  factsHash: text("facts_hash").notNull(),
  facts: jsonb("facts").notNull(),
  /** Retained business-to-site relationship (migration 0362): the crawled site and the business's own site, snapshotted. */
  crawlDomain: text("crawl_domain"),
  businessSiteDomain: text("business_site_domain"),
  siteRelation: text("site_relation"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("contact_business_first_party_link_evidence_subject_idx").on(table.contactId, table.businessId, table.createdAt),
  index("contact_business_first_party_link_evidence_candidate_idx").on(table.candidateId),
  check("contact_business_first_party_link_evidence_basis_chk", sql`domain_basis IN ('business_domain','provider_mailbox')`),
  check("contact_business_first_party_link_evidence_scope_chk", sql`attribution_scope IN ('role','named')`),
  check("contact_business_first_party_link_evidence_hash_chk", sql`contact_email_token_hash ~ '^[0-9a-f]{64}$'`),
]);

export const freeDiscoveryMaterializationOutcomes = pgTable("free_discovery_materialization_outcomes", {
  candidateId: uuid("candidate_id").primaryKey().references(() => freeDiscoveryCandidates.id, { onDelete: "restrict" }),
  outcome: text("outcome").notNull(),
  reasonCode: text("reason_code"),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
  businessId: integer("business_id").references(() => businesses.id, { onDelete: "restrict" }),
  ruleVersion: text("rule_version").notNull(),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("free_discovery_materialization_outcomes_held_idx").on(table.evaluatedAt).where(sql`outcome='held'`),
  check("free_discovery_materialization_outcomes_outcome_chk", sql`outcome IN ('linked','already_linked','held')`),
]);

export const sfpCampaignPackageVersions = pgTable("sfp_campaign_package_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  packageKey: text("package_key").notNull(),
  vertical: text("vertical").notNull(),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "restrict" }),
  campaignName: text("campaign_name").notNull(),
  sequenceId: integer("sequence_id").notNull().references(() => followUpSequences.id, { onDelete: "restrict" }),
  sequenceName: text("sequence_name").notNull(),
  sequenceFamily: text("sequence_family").notNull(),
  contentHash: text("content_hash").notNull(),
  lifecycleState: text("lifecycle_state").notNull().default("draft"),
  effectiveAt: timestamp("effective_at", { withTimezone: true }),
  supersededAt: timestamp("superseded_at", { withTimezone: true }),
  actorId: text("actor_id").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sfp_campaign_package_versions_current_uidx").on(table.packageKey).where(sql`lifecycle_state = 'current'`),
  index("sfp_campaign_package_versions_key_idx").on(table.packageKey, table.createdAt),
]);
export const sfpCampaignStagingIntents = pgTable("sfp_campaign_staging_intents", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortRunId: uuid("cohort_run_id").notNull().references(() => sfpCohortRuns.id, { onDelete: "restrict" }),
  eligibilityId: uuid("eligibility_id").notNull().references(() => sfpOutreachEligibility.id, { onDelete: "restrict" }),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  // Typed immutable source lineage. Contact sources are RESTRICTed on delete
  // so historical staged evidence cannot silently lose its originating person.
  candidateId: uuid("candidate_id").references(() => freeDiscoveryCandidates.id, { onDelete: "restrict" }),
  paidCandidateEvidenceId: uuid("paid_candidate_evidence_id").references(() => sfpPaidCandidateEvidence.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
  contactBusinessLinkDecisionId: uuid("contact_business_link_decision_id")
    .references(() => contactBusinessLinkDecisions.id, { onDelete: "restrict" }),
  contactBusinessLinkRevision: integer("contact_business_link_revision"),
  normalizedValueHash: text("normalized_value_hash"),
  normalizedValueHashVersion: integer("normalized_value_hash_version"),
  sourceKind: text("source_kind"),
  idempotencyKey: text("idempotency_key").notNull(), actorId: text("actor_id").notNull(),
  state: text("state").notNull().default("staged"), policyVersion: integer("policy_version").notNull(),
  validationSnapshot: jsonb("validation_snapshot").notNull(), lineage: jsonb("lineage").notNull(),
  masterLeadId: uuid("master_lead_id").references(() => masterLeads.id, { onDelete: "set null" }),
  packageVersionId: uuid("package_version_id").references(() => sfpCampaignPackageVersions.id, { onDelete: "restrict" }),
  recipientCommitmentId: uuid("recipient_commitment_id").references((): AnyPgColumn => sfpRecipientAddressCommitments.id, { onDelete: "restrict" }),
  packageKey: text("package_key"),
  policyDocumentHash: text("policy_document_hash"),
  snapshotHash: text("snapshot_hash"),
  payloadHash: text("payload_hash"),
  commandKey: text("command_key"),
  operatorSelectedAt: timestamp("operator_selected_at", { withTimezone: true }),
  operatorSelectedBy: text("operator_selected_by"),
  readyHeldAt: timestamp("ready_held_at", { withTimezone: true }),
  terminalCode: text("terminal_code"),
  terminalReasonDetail: text("terminal_reason_detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("sfp_campaign_intent_eligibility_live_uidx").on(table.eligibilityId)
    .where(sql`state NOT IN ('rejected','cancelled','superseded')`),
  uniqueIndex("sfp_campaign_intent_key_business_uidx").on(table.idempotencyKey, table.businessId),
  index("sfp_campaign_staging_intents_state_idx").on(table.state, table.createdAt),
  index("sfp_campaign_staging_intents_package_idx").on(table.packageVersionId, table.state),
  check(
    "sfp_campaign_staging_intents_source_ref_one_of_chk",
    sql`
      (source_kind = 'free' AND candidate_id IS NOT NULL AND paid_candidate_evidence_id IS NULL AND contact_id IS NULL)
      OR (source_kind = 'paid' AND paid_candidate_evidence_id IS NOT NULL AND candidate_id IS NULL AND contact_id IS NULL)
      OR (source_kind = 'contact' AND contact_id IS NOT NULL AND candidate_id IS NULL
          AND paid_candidate_evidence_id IS NULL AND contact_business_link_decision_id IS NOT NULL
          AND contact_business_link_revision IS NOT NULL AND normalized_value_hash IS NOT NULL
          AND normalized_value_hash_version IS NOT NULL AND normalized_value_hash_version IN (0,1))
    `,
  ),
  // 'promoted' is a retained LEGACY-ONLY value (pre-migration-0290 rows only).
  // No code path in this task or after it ever writes 'promoted' again.
  check(
    "sfp_campaign_staging_intents_state_check",
    sql`state IN ('staged','operator_selected','ready_held','rejected','cancelled','superseded','promoted')`,
  ),
]);

export type SfpCampaignStagingIntent = typeof sfpCampaignStagingIntents.$inferSelect;

/**
 * ready_held -> paused-enrollment bridge (migration 0301). Records exactly
 * one attempt to resolve a `ready_held` staging intent to a contact and
 * create a paused sequence_enrollments row for it. This is a pure audit +
 * idempotency ledger — it never itself dispatches, sends, syncs to GHL, or
 * unpauses anything; `sequence_enrollments.status` is always written as
 * 'paused' by the writer that inserts into this table.
 */
export const sfpReadyHeldEnrollments = pgTable("sfp_ready_held_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  stagingIntentId: uuid("staging_intent_id").notNull().references(() => sfpCampaignStagingIntents.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").notNull().references(() => contacts.id, { onDelete: "restrict" }),
  sequenceEnrollmentId: integer("sequence_enrollment_id").notNull().references(() => sequenceEnrollments.id, { onDelete: "restrict" }),
  contactResolution: text("contact_resolution").notNull(),
  actorId: text("actor_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Review/approval metadata only (Liberty Bancard enrichment completion,
  // continuation — item 5). This is a review DECISION record, not an
  // activation control: it never touches sequence_enrollments.status, never
  // stages a campaign, never calls GHL, and never sends. The row's own
  // ready_held/paused reality is owned entirely by sfp-enrollment-bridge.ts
  // and is untouched by any write here.
  reviewStatus: text("review_status").notNull().default("pending"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewNote: text("review_note"),
  contactBusinessLinkDecisionId: uuid("contact_business_link_decision_id")
    .references(() => contactBusinessLinkDecisions.id, { onDelete: "restrict" }),
  contactBusinessLinkRevision: integer("contact_business_link_revision"),
  recipientCommitmentId: uuid("recipient_commitment_id")
    .references(() => sfpRecipientAddressCommitments.id, { onDelete: "restrict" }),
}, (table) => [
  uniqueIndex("sfp_ready_held_enrollments_intent_uidx").on(table.stagingIntentId),
  uniqueIndex("sfp_ready_held_enrollments_commitment_uidx").on(table.recipientCommitmentId)
    .where(sql`${table.recipientCommitmentId} IS NOT NULL`),
  index("sfp_ready_held_enrollments_contact_idx").on(table.contactId),
  index("sfp_ready_held_enrollments_link_pin_idx").on(table.contactBusinessLinkDecisionId, table.contactBusinessLinkRevision),
  index("sfp_ready_held_enrollments_review_status_idx").on(table.reviewStatus),
  check(
    "sfp_ready_held_enrollments_resolution_chk",
    sql`contact_resolution IN ('matched_existing', 'created_new')`,
  ),
  check(
    "sfp_ready_held_enrollments_review_status_chk",
    sql`review_status IN ('pending', 'approved', 'rejected')`,
  ),
]);

export type SfpReadyHeldEnrollment = typeof sfpReadyHeldEnrollments.$inferSelect;

export const sfpGlobalRecipientSlots = pgTable("sfp_global_recipient_slots", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  recipientIdentityHash: text("recipient_identity_hash").notNull(),
  slot: integer("slot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("sfp_global_recipient_slots_slot_check",sql`${t.slot} BETWEEN 1 AND 3`),
  unique("sfp_global_slot_business_number_unique").on(t.businessId,t.slot),
  unique("sfp_global_slot_address_unique").on(t.recipientIdentityHash),
  unique("sfp_global_slot_subject_unique").on(t.id,t.businessId,t.recipientIdentityHash),
]);

export const sfpRecipientAddressCommitments = pgTable("sfp_recipient_address_commitments", {
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id").notNull().references(() => sfpPrograms.id, { onDelete: "restrict" }),
  objectiveKey: text("objective_key").notNull().default("sfp.initial_recipient_acquisition.v1"),
  recipientIdentityHash: text("recipient_identity_hash").notNull(),
  globalSlotId: uuid("global_slot_id"),
  recipientIdentityHashVersion: integer("recipient_identity_hash_version").notNull(),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  packageVersionId: uuid("package_version_id").notNull().references(() => sfpCampaignPackageVersions.id, { onDelete: "restrict" }),
  stagingIntentId: uuid("staging_intent_id").notNull().references(() => sfpCampaignStagingIntents.id, { onDelete: "restrict" }),
  contactId: integer("contact_id").references(() => contacts.id, { onDelete: "restrict" }),
  contactBusinessLinkDecisionId: uuid("contact_business_link_decision_id")
    .references(() => contactBusinessLinkDecisions.id, { onDelete: "restrict" }),
  state: text("state").notNull().default("claimed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  committedAt: timestamp("committed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("sfp_recipient_address_commitments_program_hash_uidx")
    .on(table.programId, table.objectiveKey, table.recipientIdentityHash),
  foreignKey({ name: "sfp_recipient_global_slot_subject_fk",
    columns: [table.globalSlotId,table.businessId,table.recipientIdentityHash],
    foreignColumns: [sfpGlobalRecipientSlots.id,sfpGlobalRecipientSlots.businessId,sfpGlobalRecipientSlots.recipientIdentityHash],
  }).onDelete("restrict"),
  index("sfp_recipient_address_commitments_business_idx").on(table.programId, table.businessId, table.createdAt),
  unique("sfp_recipient_address_commitments_staging_intent_uidx").on(table.stagingIntentId),
  check("sfp_recipient_address_commitments_identity_chk", sql`
    length(recipient_identity_hash)=64 AND recipient_identity_hash ~ '^[0-9a-f]{64}$'
    AND recipient_identity_hash_version=1
  `),
  check("sfp_recipient_address_commitments_objective_chk", sql`length(trim(objective_key))>0`),
  check("sfp_recipient_address_commitments_state_chk", sql`state IN ('claimed','committed')`),
  check("sfp_recipient_address_commitments_commit_state_chk", sql`
    (state='claimed' AND committed_at IS NULL)
    OR (state='committed' AND contact_id IS NOT NULL
        AND contact_business_link_decision_id IS NOT NULL AND committed_at IS NOT NULL)
  `),
]);

export const sfpRecipientCommitmentAliases = pgTable("sfp_recipient_commitment_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  commitmentId: uuid("commitment_id").notNull().references(() => sfpRecipientAddressCommitments.id, { onDelete: "restrict" }),
  stagingIntentId: uuid("staging_intent_id").notNull().references(() => sfpCampaignStagingIntents.id, { onDelete: "restrict" }),
  sourceKind: text("source_kind").notNull(),
  sourceReferenceId: text("source_reference_id").notNull(),
  normalizedValueHash: text("normalized_value_hash").notNull(),
  normalizedValueHashVersion: integer("normalized_value_hash_version").notNull(),
  disposition: text("disposition").notNull(),
  reasonCode: text("reason_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sfp_recipient_commitment_aliases_commitment_idx").on(table.commitmentId, table.createdAt),
  unique("sfp_recipient_commitment_aliases_attempt_uidx")
    .on(table.stagingIntentId, table.commitmentId, table.disposition),
  check("sfp_recipient_commitment_aliases_source_chk", sql`source_kind IN ('free','paid','contact')`),
  check("sfp_recipient_commitment_aliases_hash_version_chk", sql`normalized_value_hash_version IN (0,1)`),
  check("sfp_recipient_commitment_aliases_disposition_chk", sql`disposition IN ('initial','reused','held')`),
]);

export const sfpEnrollmentBridgeHolds = pgTable("sfp_enrollment_bridge_holds", {
  id: uuid("id").primaryKey().defaultRandom(),
  stagingIntentId: uuid("staging_intent_id").notNull().references(() => sfpCampaignStagingIntents.id, { onDelete: "restrict" }),
  eligibilityId: uuid("eligibility_id").notNull().references(() => sfpOutreachEligibility.id, { onDelete: "restrict" }),
  holdCode: text("hold_code").notNull(),
  safeDetail: text("safe_detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sfp_enrollment_bridge_holds_intent_latest_idx").on(table.stagingIntentId, sql`${table.createdAt} DESC`),
]);

export const sfpProviderRetrievalTasks = pgTable("sfp_provider_retrieval_tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  taskKind: text("task_kind").notNull(),
  providerTaskId: text("provider_task_id").notNull(),
  providerReference: text("provider_reference"),
  submissionOperationId: uuid("submission_operation_id").notNull().references(() => providerOperations.id, { onDelete: "restrict" }),
  completionOperationId: uuid("completion_operation_id").references(() => providerOperations.id, { onDelete: "restrict" }),
  contactOperationId: uuid("contact_operation_id").references(() => providerOperations.id, { onDelete: "restrict" }),
  stageRunId: uuid("stage_run_id").notNull().references(() => sfpStageRuns.id, { onDelete: "cascade" }),
  cohortRunId: uuid("cohort_run_id").references(() => sfpCohortRuns.id, { onDelete: "cascade" }),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "restrict" }),
  businessNameSnapshot: text("business_name_snapshot").notNull(),
  domainSnapshot: text("domain_snapshot"),
  citySnapshot: text("city_snapshot"),
  stateSnapshot: text("state_snapshot"),
  state: text("state").notNull().default("submitted"),
  requestFingerprint: text("request_fingerprint").notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull().defaultNow(),
  /** Retain only a completion timestamp actually documented by the provider. */
  providerCompletedAt: timestamp("provider_completed_at", { withTimezone: true }),
  completionTimeLowerBoundAt: timestamp("completion_time_lower_bound_at", { withTimezone: true }).notNull(),
  completionTimeBoundKind: text("completion_time_bound_kind").notNull(),
  /** Conservative polling cutoff derived from completionTimeLowerBoundAt + 4h. */
  resultsExpiresAt: timestamp("results_expires_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  completedResultCount: integer("completed_result_count"),
  completedResultHashes: jsonb("completed_result_hashes").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  unique("sfp_provider_retrieval_task_provider_id_uidx").on(table.provider, table.providerTaskId),
  index("sfp_provider_retrieval_tasks_claim_idx").on(table.state, table.nextPollAt, table.leaseExpiresAt, table.submittedAt)
    .where(sql`${table.state} IN ('submitted','polling')`),
  index("sfp_provider_retrieval_tasks_business_idx").on(table.businessId, sql`${table.submittedAt} DESC`),
  index("sfp_provider_retrieval_tasks_stage_idx").on(table.stageRunId, table.businessId, table.state),
  check("sfp_provider_retrieval_tasks_provider_check", sql`provider = 'outscraper'`),
  check("sfp_provider_retrieval_tasks_task_kind_check", sql`task_kind IN ('maps_search','leads_and_contacts')`),
  check("sfp_provider_retrieval_tasks_state_check", sql`state IN ('submitted','polling','completed','no_result','failed','expired')`),
  check("sfp_provider_retrieval_tasks_request_fingerprint_check", sql`request_fingerprint ~ '^[0-9a-f]{64}$'`),
  check("sfp_provider_retrieval_task_expiry_chk", sql`expires_at > submitted_at`),
  check("sfp_provider_retrieval_task_results_expiry_chk", sql`
    (provider_completed_at IS NOT NULL
      AND completion_time_bound_kind = 'provider_completed_at'
      AND completion_time_lower_bound_at = provider_completed_at
      AND results_expires_at = provider_completed_at + INTERVAL '4 hours')
    OR
    (provider_completed_at IS NULL
      AND completion_time_bound_kind IN ('last_pending_observed','submission_started')
      AND results_expires_at = completion_time_lower_bound_at + INTERVAL '4 hours')
  `),
  check("sfp_provider_retrieval_task_completion_bound_kind_chk", sql`
    completion_time_bound_kind IN ('provider_completed_at','last_pending_observed','submission_started')
  `),
  check("sfp_provider_retrieval_task_result_count_chk", sql`completed_result_count IS NULL OR completed_result_count >= 0`),
  check("sfp_provider_retrieval_task_attempt_count_chk", sql`attempt_count >= 0`),
  check("sfp_provider_retrieval_task_lease_chk", sql`
    (state = 'polling' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state <> 'polling' AND lease_token IS NULL AND lease_expires_at IS NULL)
  `),
  check("sfp_provider_retrieval_task_hashes_array_chk", sql`jsonb_typeof(completed_result_hashes) = 'array'`),
]);

export const sfpReadyHeldConsumerItems = pgTable("sfp_ready_held_consumer_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  stagingIntentId: uuid("staging_intent_id").notNull().references(() => sfpCampaignStagingIntents.id, { onDelete: "restrict" }),
  state: text("state").notNull().default("pending"),
  actorId: text("actor_id").notNull(),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  claimToken: uuid("claim_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  runtimeOwnerEpoch: bigint("runtime_owner_epoch", { mode: "number" }),
  runtimeOwnerToken: uuid("runtime_owner_token"),
  runtimeDeploymentIdentity: text("runtime_deployment_identity"),
  runtimeEnvironmentIdentity: text("runtime_environment_identity"),
  runtimeArtifactSha: text("runtime_artifact_sha"),
  runtimeProcessIdentity: text("runtime_process_identity"),
  runtimeQueueTopologyHash: text("runtime_queue_topology_hash"),
  outcomeCode: text("outcome_code"),
  result: jsonb("result").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("sfp_ready_held_consumer_items_staging_intent_id_key").on(table.stagingIntentId),
  index("sfp_ready_held_consumer_claim_idx").on(table.state, table.nextAttemptAt, table.leaseExpiresAt, table.createdAt),
  check("sfp_ready_held_consumer_items_state_check", sql`
    state IN ('pending','claimed','retry','held','completed','dead_letter')
  `),
  check("sfp_ready_held_consumer_items_attempt_count_check", sql`attempt_count >= 0`),
  check("sfp_ready_held_consumer_owner_binding_chk", sql`
    (runtime_owner_epoch IS NULL AND runtime_owner_token IS NULL
      AND runtime_deployment_identity IS NULL AND runtime_environment_identity IS NULL
      AND runtime_artifact_sha IS NULL AND runtime_process_identity IS NULL
      AND runtime_queue_topology_hash IS NULL)
    OR
    (runtime_owner_epoch > 0 AND runtime_owner_token IS NOT NULL
      AND runtime_deployment_identity IS NOT NULL AND runtime_environment_identity IS NOT NULL
      AND runtime_artifact_sha IS NOT NULL AND runtime_process_identity IS NOT NULL
      AND runtime_queue_topology_hash IS NOT NULL)
  `),
  check("sfp_ready_held_consumer_claim_binding_chk", sql`
    (state='claimed' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND runtime_owner_epoch IS NOT NULL AND runtime_owner_token IS NOT NULL)
    OR state<>'claimed'
  `),
]);

export const emailDiscoveryDomainCache = pgTable("email_discovery_domain_cache", {
  domain: text("domain").primaryKey(),
  firstCrawledAt: timestamp("first_crawled_at", { withTimezone: true }).notNull().defaultNow(),
  lastCrawledAt: timestamp("last_crawled_at", { withTimezone: true }).notNull().defaultNow(),
  crawlCount: integer("crawl_count").notNull().default(1),
  /** [{ email, confidence, sourceUrl }] — role-inbox candidates only. */
  roleEmails: jsonb("role_emails").notNull().default([]),
  lastGenerationId: uuid("last_generation_id").references(() => freeDiscoveryGenerations.id, { onDelete: "set null" }),
});
export type EmailDiscoveryDomainCache = typeof emailDiscoveryDomainCache.$inferSelect;

// ── MI-05: businesses enrichment provenance (CAS tracking) ───────────────────
// Tracks which CRO-03C generation last wrote each enrichment field on a
// businesses row. Required for CAS in projectBusinessEnrichmentFields().
export const businessesEnrichmentProvenance = pgTable("businesses_enrichment_provenance", {
  id: serial("id").primaryKey(),
  businessId: integer("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  field: text("field").notNull(),
  generationId: uuid("generation_id").notNull(),
  stageKey: text("stage_key").notNull(),
  confidence: integer("confidence").notNull().default(0),
  writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("businesses_enrichment_provenance_business_field_uniq").on(table.businessId, table.field),
  index("businesses_enrichment_provenance_generation_idx").on(table.generationId),
]);
export type BusinessesEnrichmentProvenance = typeof businessesEnrichmentProvenance.$inferSelect;

export type SfpCampaignStagingCommand = typeof sfpCampaignStagingCommands.$inferSelect;

export const sfpCampaignStagingCommands = pgTable("sfp_campaign_staging_commands", {
  id: uuid("id").primaryKey().defaultRandom(),
  cohortRunId: uuid("cohort_run_id").notNull().references(() => sfpCohortRuns.id, { onDelete: "restrict" }),
  commandKey: text("command_key").notNull().unique(),
  payloadHash: text("payload_hash").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  actorId: text("actor_id").notNull(),
  storedResult: jsonb("stored_result"),
  // PM-04 (Task #2001 post-merge audit): pending -> executing -> completed.
  // Inserted 'pending' BEFORE any per-row work starts so a crash mid-command
  // leaves durable evidence the command was claimed, and a retry can resume
  // /reconcile against it instead of re-deriving a fresh (and possibly
  // snapshot-drifted) preview.
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("sfp_campaign_staging_commands_cohort_idx").on(table.cohortRunId, table.createdAt),
  check("sfp_campaign_staging_commands_state_check", sql`state IN ('pending', 'executing', 'completed')`),
]);

export type SfpCampaignPackageVersion = typeof sfpCampaignPackageVersions.$inferSelect;
