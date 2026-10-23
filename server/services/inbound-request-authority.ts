/**
 * CRO-05A inbound request authority.
 *
 * This module freezes source policy, claims one request occurrence, creates
 * held effect intents, records assignment evidence, and links work to the
 * request occurrence. It does not send, enroll, sync, create contacts/deals,
 * or replace any existing domain authority.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import {
  inboundAssignmentDecisions,
  inboundRequestEffects,
  inboundRequestWorkLinks,
  inboundRequests,
  deals,
  equipmentOrders,
  notifications,
  tasks,
  tickets,
  users,
  contacts,
  contactSourceEvents,
  type InboundRequest,
} from "@shared/schema";
import { resolveWorkAssignee, workPrincipalFields, WorkCommandError } from "./work-item-command";
import { auditChange } from "./audit-change";
import { z } from "zod";
type InboundTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const INBOUND_MANIFEST_VERSION = "cro05a-v2";
const BUSINESS_DAY_START_HOUR_UTC = 9;
const BUSINESS_DAY_END_HOUR_UTC = 17;
const SALES_SLA_BUSINESS_HOURS = 24;
const SUPPORT_SLA_BUSINESS_HOURS = 4;
const FULFILLMENT_SLA_BUSINESS_HOURS = 24;
export type InboundSourceClass =
  | "sales_request"
  | "support_request"
  | "fulfillment_request"
  | "marketing_opt_in"
  | "content_reputation"
  | "lifecycle_event"
  | "imported_provider_event";

export type EffectDefinition = {
  key: string;
  type: string;
  required: boolean;
  external: boolean;
  prerequisites?: string[];
};

export type SourcePolicy = {
  sourceCategory: string;
  sourceType: string;
  sourceClass: InboundSourceClass;
  effects: readonly EffectDefinition[];
  forbiddenEffects: readonly string[];
};

const SALES_EFFECTS: readonly EffectDefinition[] = [
  { key: "assignment", type: "sales_assignment", required: true, external: false },
  { key: "sales_work", type: "cr05_task", required: true, external: false, prerequisites: ["assignment"] },
  { key: "sales_sla", type: "sla", required: true, external: false, prerequisites: ["sales_work"] },
  { key: "transactional_ack", type: "transactional_ack", required: true, external: true },
];
const FREE_ANALYSIS_EFFECTS: readonly EffectDefinition[] = [
  ...SALES_EFFECTS,
  { key: "workflow_dispatch", type: "workflow_dispatch", required: false, external: true },
  { key: "provider_sync", type: "provider_sync", required: false, external: true },
  { key: "inbound_confirmation", type: "inbound_confirmation", required: false, external: true },
  { key: "referral_attribution", type: "referral_attribution", required: false, external: true },
  { key: "business_enrichment", type: "business_enrichment", required: false, external: true },
  { key: "lead_scoring", type: "lead_scoring", required: false, external: true },
  { key: "deal_blueprint", type: "deal_blueprint", required: false, external: true },
];
const SUPPORT_EFFECTS: readonly EffectDefinition[] = [
  { key: "support_ticket", type: "cr05_ticket", required: true, external: false },
  { key: "support_sla", type: "sla", required: true, external: false, prerequisites: ["support_ticket"] },
  { key: "transactional_ack", type: "transactional_ack", required: true, external: true },
];
const FULFILLMENT_EFFECTS: readonly EffectDefinition[] = [
  { key: "fulfillment", type: "fulfillment_order", required: true, external: false },
  { key: "fulfillment_sla", type: "sla", required: true, external: false, prerequisites: ["fulfillment"] },
  { key: "internal_notification", type: "internal_notification", required: true, external: false, prerequisites: ["fulfillment"] },
  { key: "transactional_ack", type: "transactional_ack", required: true, external: true },
];

export const INBOUND_SOURCE_POLICIES: readonly SourcePolicy[] = [
  { sourceCategory: "website_form", sourceType: "estimate_form", sourceClass: "sales_request", effects: SALES_EFFECTS, forbiddenEffects: ["promotional_enrollment", "proposal_send"] },
  { sourceCategory: "website_form", sourceType: "get_started_form", sourceClass: "sales_request", effects: SALES_EFFECTS, forbiddenEffects: ["promotional_enrollment", "proposal_send"] },
  { sourceCategory: "website_form", sourceType: "callback_form", sourceClass: "sales_request", effects: SALES_EFFECTS, forbiddenEffects: ["promotional_enrollment", "proposal_send"] },
  { sourceCategory: "website_form", sourceType: "free_analysis", sourceClass: "sales_request", effects: FREE_ANALYSIS_EFFECTS, forbiddenEffects: ["promotional_enrollment", "proposal_send"] },
  { sourceCategory: "website_form", sourceType: "statement_upload", sourceClass: "sales_request", effects: [...SALES_EFFECTS, { key: "statement_review", type: "statement_handoff", required: true, external: false }], forbiddenEffects: ["promotional_enrollment", "proposal_send"] },
  { sourceCategory: "website_form", sourceType: "integration_request", sourceClass: "sales_request", effects: SALES_EFFECTS, forbiddenEffects: ["promotional_enrollment", "proposal_send"] },
  { sourceCategory: "website_form", sourceType: "support_form", sourceClass: "support_request", effects: SUPPORT_EFFECTS, forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "promotional_enrollment"] },
  // This adapter may create one request-owned fulfillment deal as its durable
  // order container. It remains forbidden from creating sales work or
  // promotional enrollment.
  { sourceCategory: "website_form", sourceType: "equipment_order", sourceClass: "fulfillment_request", effects: FULFILLMENT_EFFECTS, forbiddenEffects: ["sales_assignment", "cr05_task", "promotional_enrollment"] },
  { sourceCategory: "website_form", sourceType: "testimonial_submit", sourceClass: "content_reputation", effects: [{ key: "moderation", type: "moderation_review", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "promotional_enrollment"] },
  { sourceCategory: "website_form", sourceType: "newsletter_signup", sourceClass: "marketing_opt_in", effects: [{ key: "consent_evidence", type: "consent_evidence", required: true, external: false }, { key: "cr04_readiness", type: "cr04_eligibility", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "promotional_enrollment"] },
  { sourceCategory: "manual_crm", sourceType: "dashboard", sourceClass: "sales_request", effects: SALES_EFFECTS, forbiddenEffects: ["promotional_enrollment", "proposal_send"] },
  { sourceCategory: "ghl_sync", sourceType: "inbound", sourceClass: "imported_provider_event", effects: [{ key: "projection", type: "acquisition_evidence", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "consent_evidence"] },
  { sourceCategory: "csv_import", sourceType: "csv_contact", sourceClass: "imported_provider_event", effects: [{ key: "acquisition", type: "acquisition_evidence", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "consent_evidence"] },
  { sourceCategory: "csv_import", sourceType: "outscraper", sourceClass: "imported_provider_event", effects: [{ key: "acquisition", type: "acquisition_evidence", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "consent_evidence"] },
  { sourceCategory: "csv_import", sourceType: "apollo", sourceClass: "imported_provider_event", effects: [{ key: "acquisition", type: "acquisition_evidence", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "consent_evidence"] },
  { sourceCategory: "discovery", sourceType: "apollo", sourceClass: "imported_provider_event", effects: [{ key: "acquisition", type: "acquisition_evidence", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "consent_evidence"] },
  { sourceCategory: "partner_referral", sourceType: "partner_form", sourceClass: "sales_request", effects: SALES_EFFECTS, forbiddenEffects: ["promotional_enrollment", "proposal_send"] },
  // A verified provider event is an occurrence, but is not itself permission
  // to create sales work.  The provider handler remains the owner of its
  // projection/lifecycle transition; this envelope only records the event.
  { sourceCategory: "ghl_webhook", sourceType: "inbound_message", sourceClass: "lifecycle_event", effects: [{ key: "projection", type: "provider_event_projection", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "consent_evidence", "promotional_enrollment"] },
  { sourceCategory: "ghl_webhook", sourceType: "inbound_call", sourceClass: "lifecycle_event", effects: [{ key: "projection", type: "provider_event_projection", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "consent_evidence", "promotional_enrollment"] },
  { sourceCategory: "ghl_webhook", sourceType: "appointment_booked", sourceClass: "lifecycle_event", effects: [{ key: "projection", type: "provider_event_projection", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "consent_evidence", "promotional_enrollment"] },
  { sourceCategory: "ghl_webhook", sourceType: "chat_message", sourceClass: "lifecycle_event", effects: [{ key: "projection", type: "provider_event_projection", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "consent_evidence", "promotional_enrollment"] },
  { sourceCategory: "ghl_webhook", sourceType: "chat_booking", sourceClass: "lifecycle_event", effects: [{ key: "projection", type: "provider_event_projection", required: true, external: false }], forbiddenEffects: ["sales_assignment", "cr05_task", "deal_create", "consent_evidence", "promotional_enrollment"] },
];

const POLICY_MAP = new Map(INBOUND_SOURCE_POLICIES.map((policy) => [`${policy.sourceCategory}|${policy.sourceType}`, policy]));

export function getInboundSourcePolicy(sourceCategory: string, sourceType: string): SourcePolicy {
  const policy = POLICY_MAP.get(`${sourceCategory}|${sourceType}`);
  if (!policy) throw new Error(`INVALID_INBOUND_SOURCE_COMBINATION:${sourceCategory}|${sourceType}`);
  return policy;
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload, (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.keys(value).sort().reduce<Record<string, unknown>>((out, key) => {
      out[key] = value[key];
      return out;
    }, {});
  })).digest("hex");
}

function manifestHash(policy: SourcePolicy): string {
  return hashPayload({ version: INBOUND_MANIFEST_VERSION, policy });
}

/**
 * Add business hours using a stable UTC calendar. This intentionally has no
 * runtime locale, host timezone, or DST dependency, so a replay calculates
 * the same due instant on every worker.
 */
export function addBusinessHoursUtc(receivedAt: Date, hours: number): Date {
  if (!Number.isFinite(hours) || hours < 0) throw new Error("INVALID_BUSINESS_HOURS");
  const due = new Date(receivedAt.getTime());
  const moveToBusinessOpen = () => {
    while (due.getUTCDay() === 0 || due.getUTCDay() === 6) due.setUTCDate(due.getUTCDate() + 1);
    due.setUTCHours(BUSINESS_DAY_START_HOUR_UTC, 0, 0, 0);
  };
  if (due.getUTCDay() === 0 || due.getUTCDay() === 6
    || due.getUTCHours() >= BUSINESS_DAY_END_HOUR_UTC) {
    due.setUTCDate(due.getUTCDate() + 1);
    moveToBusinessOpen();
  } else if (due.getUTCHours() < BUSINESS_DAY_START_HOUR_UTC) {
    moveToBusinessOpen();
  }

  let remaining = hours;
  while (remaining > 0) {
    const close = new Date(due);
    close.setUTCHours(BUSINESS_DAY_END_HOUR_UTC, 0, 0, 0);
    const available = (close.getTime() - due.getTime()) / 3_600_000;
    if (remaining <= available) {
      due.setTime(due.getTime() + remaining * 3_600_000);
      break;
    }
    remaining -= available;
    due.setUTCDate(due.getUTCDate() + 1);
    moveToBusinessOpen();
  }
  return due;
}

export function inboundSlaDueAt(sourceClass: InboundSourceClass, receivedAt: Date): Date | null {
  if (sourceClass === "sales_request") return addBusinessHoursUtc(receivedAt, SALES_SLA_BUSINESS_HOURS);
  if (sourceClass === "support_request") return addBusinessHoursUtc(receivedAt, SUPPORT_SLA_BUSINESS_HOURS);
  if (sourceClass === "fulfillment_request") return addBusinessHoursUtc(receivedAt, FULFILLMENT_SLA_BUSINESS_HOURS);
  return null;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type InboundClaimResult =
  | { outcome: "claimed"; request: InboundRequest; policy: SourcePolicy }
  | { outcome: "replay"; request: InboundRequest; policy: SourcePolicy }
  | { outcome: "conflict" }
  | { outcome: "scope_mismatch" };

/**
 * The deliberately small public view of an inbound occurrence. Keep this
 * separate from InboundRequest so a status reader cannot accidentally return
 * entity links, assignment data, protected-object references, or payload
 * metadata to an unauthenticated caller.
 */
export type PublicInboundRequestStatus = Readonly<{
  requestReceipt: string;
  status: string;
}>;

export async function claimInboundRequest(input: {
  idempotencyKey: string;
  occurrenceKey?: string;
  /**
   * A producer-supplied canonical fingerprint for multipart/binary requests.
   * JSON adapters use the canonical payload hash below; binary adapters must
   * include their bytes in this value before claiming the occurrence.
   */
  requestFingerprint?: string;
  sourceCategory: string;
  sourceType: string;
  callerScope: string;
  actorType: string;
  actorId?: string | null;
  payload: unknown;
  sourceReceivedAt?: Date;
}): Promise<InboundClaimResult> {
  if (!UUID_V4.test(input.idempotencyKey)) throw new Error("INVALID_INBOUND_IDEMPOTENCY_KEY");
  const policy = getInboundSourcePolicy(input.sourceCategory, input.sourceType);
  const requestFingerprint = input.requestFingerprint || hashPayload(input.payload);
  const inserted = await db.transaction(async (tx) => {
    const [request] = await tx.insert(inboundRequests).values({
      idempotencyKey: input.idempotencyKey,
      occurrenceKey: input.occurrenceKey || input.idempotencyKey,
      requestFingerprint,
      sourceCategory: input.sourceCategory,
      sourceType: input.sourceType,
      sourceClass: policy.sourceClass,
      callerScope: input.callerScope,
      actorType: input.actorType,
      actorId: input.actorId || null,
      sourceReceivedAt: input.sourceReceivedAt || new Date(),
      manifestVersion: INBOUND_MANIFEST_VERSION,
      manifestHash: manifestHash(policy),
      lifecycleState: "claimed",
      reconciliationState: "not_required",
    }).onConflictDoNothing({ target: inboundRequests.idempotencyKey }).returning();
    if (!request) return null;
    for (const effect of policy.effects) {
      await tx.insert(inboundRequestEffects).values({
        requestId: request.id,
        effectKey: effect.key,
        effectType: effect.type,
        required: effect.required,
        externalSideEffect: effect.external,
        prerequisites: effect.prerequisites || [],
        state: "held",
      }).onConflictDoNothing({ target: [inboundRequestEffects.requestId, inboundRequestEffects.effectKey] });
    }
    return request;
  });
  if (inserted) return { outcome: "claimed", request: inserted, policy };
  const [existing] = await db.select().from(inboundRequests).where(eq(inboundRequests.idempotencyKey, input.idempotencyKey)).limit(1);
  if (!existing) return claimInboundRequest(input);
  if (existing.requestFingerprint !== requestFingerprint || existing.sourceType !== input.sourceType || existing.sourceCategory !== input.sourceCategory) return { outcome: "conflict" };
  if (existing.callerScope !== input.callerScope) return { outcome: "scope_mismatch" };
  return { outcome: "replay", request: existing, policy };
}

/** Convert a verified provider event identity into the UUID command shape used
 * by the authority.  The stable occurrence key remains the provider identity;
 * the UUID is solely the authority's replay-safe command key. */
export function providerEventCommandId(source: string, eventId: string): string {
  const hex = createHash("sha256").update(`${source}:${eventId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function claimVerifiedProviderEvent(input: {
  sourceType: "inbound_message" | "inbound_call" | "appointment_booked" | "chat_message" | "chat_booking";
  eventId: string;
  payload: unknown;
}): Promise<InboundClaimResult> {
  if (!input.eventId.trim()) throw new Error("VERIFIED_PROVIDER_EVENT_ID_REQUIRED");
  return claimInboundRequest({
    idempotencyKey: providerEventCommandId(`ghl_webhook:${input.sourceType}`, input.eventId),
    occurrenceKey: `ghl:${input.sourceType}:${input.eventId}`,
    sourceCategory: "ghl_webhook",
    sourceType: input.sourceType,
    callerScope: "provider:ghl:verified",
    actorType: "service_principal",
    actorId: "ghl",
    payload: input.payload,
  });
}

export async function linkInboundRequest(requestId: string, refs: {
  contactId?: number | null;
  dealId?: number | null;
  ticketId?: number | null;
  /** Opaque protected_objects.object_ref; never the internal row id. */
  protectedObjectRef?: string | null;
  slaDueAt?: Date | null;
  lifecycleState?: "claimed" | "processing" | "accepted" | "completed" | "failed" | "cancelled" | "review_required";
}): Promise<InboundRequest | null> {
  const [updated] = await db.update(inboundRequests).set({
    contactId: refs.contactId,
    // First link snapshots the submitted mailbox; COALESCE keeps it immutable on every later link.
    ...(refs.contactId
      ? { submittedEmail: sql`COALESCE(${inboundRequests.submittedEmail}, (SELECT NULLIF(lower(btrim(email)), '') FROM contacts WHERE id = ${refs.contactId}))` }
      : {}),
    dealId: refs.dealId,
    ticketId: refs.ticketId,
    protectedObjectRef: refs.protectedObjectRef,
    slaDueAt: refs.slaDueAt,
    lifecycleState: refs.lifecycleState,
    updatedAt: new Date(),
  }).where(eq(inboundRequests.id, requestId)).returning();
  return updated || null;
}

export async function setInboundRequestLifecycle(
  requestId: string,
  lifecycleState: "claimed" | "processing" | "accepted" | "completed" | "failed" | "cancelled" | "review_required",
  terminalReason?: string | null,
): Promise<void> {
  await db.update(inboundRequests).set({
    lifecycleState,
    terminalReason: terminalReason || null,
    updatedAt: new Date(),
  }).where(eq(inboundRequests.id, requestId));
}

export async function transitionInboundEffect(effectId: string, input: {
  state: "held" | "ready" | "attempting" | "sent" | "failed" | "suppressed";
  terminalReason?: string | null;
  providerReceipt?: string | null;
}): Promise<boolean> {
  const result = await db.update(inboundRequestEffects).set({
    state: input.state,
    terminalReason: input.terminalReason || null,
    providerReceipt: input.providerReceipt || null,
    updatedAt: new Date(),
  }).where(and(eq(inboundRequestEffects.id, effectId), inArray(inboundRequestEffects.state, ["held", "ready", "attempting"]))).returning({ id: inboundRequestEffects.id });
  return result.length === 1;
}

type RequiredInternalEffectState = Pick<typeof inboundRequestEffects.$inferSelect, "state">;

/**
 * External intents are deliberately excluded: a held acknowledgement must not
 * prevent the internal request from advancing. Required internal intents do.
 */
export function decideInboundLifecycle(
  effects: readonly RequiredInternalEffectState[],
  incompleteState: "processing" | "review_required" = "processing",
  completedState: "accepted" | "completed" = "accepted",
): "processing" | "review_required" | "accepted" | "completed" | "failed" {
  if (effects.some((effect) => effect.state === "failed")) return "failed";
  if (effects.some((effect) => effect.state !== "sent")) return incompleteState;
  return completedState;
}

export async function reconcileInboundRequestLifecycle(input: {
  requestId: string;
  incompleteState?: "processing" | "review_required";
  completedState?: "accepted" | "completed";
  terminalReason?: string | null;
}): Promise<InboundRequest | null> {
  const effects = await db.select({ state: inboundRequestEffects.state })
    .from(inboundRequestEffects)
    .where(and(
      eq(inboundRequestEffects.requestId, input.requestId),
      eq(inboundRequestEffects.required, true),
      eq(inboundRequestEffects.externalSideEffect, false),
    ));
  const lifecycleState = decideInboundLifecycle(
    effects,
    input.incompleteState,
    input.completedState,
  );
  const [updated] = await db.update(inboundRequests).set({
    lifecycleState,
    terminalReason: lifecycleState === "failed"
      ? input.terminalReason || "REQUIRED_INTERNAL_EFFECT_FAILED"
      : null,
    updatedAt: new Date(),
  }).where(eq(inboundRequests.id, input.requestId)).returning();
  return updated || null;
}

export async function transitionInboundEffectByKey(input: {
  requestId: string;
  effectKey: string;
  state: "held" | "ready" | "attempting" | "sent" | "failed" | "suppressed";
  terminalReason?: string | null;
}): Promise<boolean> {
  const result = await db.update(inboundRequestEffects).set({
    state: input.state,
    terminalReason: input.terminalReason || null,
    updatedAt: new Date(),
  }).where(and(
    eq(inboundRequestEffects.requestId, input.requestId),
    eq(inboundRequestEffects.effectKey, input.effectKey),
  )).returning({ id: inboundRequestEffects.id });
  return result.length === 1;
}

type AssignmentPolicy = { version: string; reps: Array<{ id: string; active?: boolean; territory?: string; capacity?: number; load?: number; serviceHours?: Record<string, unknown> }> };
function readAssignmentPolicy(): { policy: AssignmentPolicy | null; hash: string } {
  const raw = process.env.INBOUND_ASSIGNMENT_POLICY_JSON;
  if (!raw) return { policy: null, hash: hashPayload({ missing: true }) };
  try {
    const policy = z.object({version:z.string().min(1).max(190),reps:z.array(z.object({
      id:z.string().min(1).max(190),active:z.boolean().optional(),territory:z.string().max(190).optional(),
      capacity:z.number().int().nonnegative().optional(),load:z.number().int().nonnegative().optional(),
      serviceHours:z.record(z.unknown()).optional(),
    }).strict()).max(200)}).strict().parse(JSON.parse(raw)) as AssignmentPolicy;
    if (new Set(policy.reps.map(r=>r.id)).size!==policy.reps.length) return {policy:null,hash:hashPayload({invalid:true})};
    return { policy, hash: hashPayload(policy) };
  } catch {
    return { policy: null, hash: hashPayload({ invalid: true }) };
  }
}

export async function evaluateInboundAssignment(input: {
  requestId: string;
  currentOwner?: string | null;
  territory?: string | null;
  actorType?: string;
  actorId?: string | null;
  contactId?: number | null;
  dealId?: number | null;
}, existingTx?: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<{ status: string; assignedTo: string | null; reasonCode: string; policyVersion: string }> {
  const { policy, hash } = readAssignmentPolicy();
  if (input.actorType && !["system","user"].includes(input.actorType)) throw new Error("INBOUND_ASSIGNMENT_ACTOR_UNAVAILABLE");
  const execute = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.requestId}))`);
    const [request] = await tx.select().from(inboundRequests).where(eq(inboundRequests.id,input.requestId));
    if (!request) throw new Error("INBOUND_REQUEST_NOT_FOUND");
    const [accepted] = await tx.select().from(inboundAssignmentDecisions)
      .where(eq(inboundAssignmentDecisions.requestId,input.requestId)).orderBy(asc(inboundAssignmentDecisions.decisionOrdinal)).limit(1);
    if ((request.contactId && input.contactId && request.contactId!==input.contactId) ||
      (request.dealId && input.dealId && request.dealId!==input.dealId)) throw new Error("INBOUND_REQUEST_LINK_CHANGED");
    const contactId = input.contactId ?? request.contactId;
    const dealId = input.dealId ?? request.dealId;
    // Trusted occurrence metadata prepares the complete principal lock set.
    // Actual ownership is rechecked below after user/agent identity pins.
    const [ownerSnapshot] = contactId ? await tx.select({assignedTo:contacts.assignedTo}).from(contacts).where(eq(contacts.id,contactId)) : [];
    // Pool identity is user ID/email only. Configured names and emails never
    // override actual account state. Pin all candidate principals before graph.
    const identities = [...new Set([...(policy?.reps.map(r=>r.id) ?? []),accepted?.assignedTo,
      input.currentOwner,request.assignedTo,ownerSnapshot?.assignedTo].filter((id):id is string=>typeof id==="string" && !!id))];
    const principals = identities.length ? await tx.select(workPrincipalFields).from(users)
      .where(sql`${users.id} IN (${sql.join(identities.map(id=>sql`${id}`),sql`,`)})
        OR lower(${users.email}) IN (${sql.join(identities.map(id=>sql`${id.toLowerCase()}`),sql`,`)})`)
      .orderBy(asc(users.id)).for("share") : [];
    const resolved = new Map<string,typeof principals[number]>();
    for (const identity of identities) {
      try { resolved.set(identity,await resolveWorkAssignee(identity,tx,principals,true)); }
      catch(error) { if (!(error instanceof WorkCommandError)) throw error; }
    }
    const [contact] = contactId ? await tx.select().from(contacts).where(eq(contacts.id,contactId)).for("share") : [];
    const [deal] = dealId ? await tx.select().from(deals).where(eq(deals.id,dealId)).for("share") : [];
    // Newly accepted first-party contacts remain unknown until the separate
    // classification authority acts. Only this exact occurrence's immutable
    // provenance permits a generic, unlinked management review obligation.
    // It never admits the contact/deal into rep production work or assigns it.
    const occurrenceKey=request.sourceCategory==="website_form"
      ? `form:${request.sourceType}:${request.id}`
      : request.sourceCategory==="manual_crm" && request.sourceType==="dashboard"
        ? `manual:${request.id}` : null;
    const occurrenceEvidence=contact && contact.recordClass==="unknown" && occurrenceKey
      ? await tx.select({id:contactSourceEvents.id}).from(contactSourceEvents).where(and(
        eq(contactSourceEvents.contactId,contact.id),
        eq(contactSourceEvents.sourceCategory,request.sourceCategory),
        eq(contactSourceEvents.sourceType,request.sourceType),
        eq(contactSourceEvents.eventKey,occurrenceKey),
      )).for("share") : [];
    const classReview=occurrenceEvidence.length===1 && !dealId;
    if (!contact || contact.archivedAt || (contact.recordClass!=="production" && !classReview) ||
      (dealId && (!deal || deal.archivedAt || deal.recordClass!=="production" || deal.contactId!==contact.id))) {
      throw new WorkCommandError("Inbound context is unavailable or changed. Review the retained request; no linked work was created.",409);
    }
    const owns = (email:string) => !!contact && !contact.archivedAt && contact.recordClass==="production" &&
      contact.assignedTo===email && (!dealId || (!!deal && !deal.archivedAt && deal.recordClass==="production" &&
        deal.contactId===contact.id && deal.owner===email));
    let result:{status:string;assignedTo:string|null;reasonCode:string;policyVersion:string};
    if (accepted) {
      const current = accepted.assignedTo ? resolved.get(accepted.assignedTo) : undefined;
      result = {...accepted,status:accepted.assignedTo && (!current || !owns(current.email!)) ? "review_required":accepted.status,
        reasonCode:accepted.assignedTo && (!current || !owns(current.email!)) ? "ACCEPTED_ASSIGNMENT_CURRENTLY_UNAVAILABLE":accepted.reasonCode,
        policyVersion:accepted.policyVersion ?? "missing"};
      // Never re-elect or rewrite accepted assignment or its retained task.
      await tx.update(inboundRequests).set({assignmentStatus:result.status,updatedAt:new Date()}).where(eq(inboundRequests.id,request.id));
      return result;
    }
    const eligible = (policy?.reps ?? []).filter(rep=>rep.active!==false &&
      (!input.territory || !rep.territory || rep.territory===input.territory) &&
      (rep.capacity===undefined || (rep.load ?? 0)<rep.capacity) && resolved.has(rep.id));
    const priorOwner = input.currentOwner ?? contact?.assignedTo;
    const owner = priorOwner ? resolved.get(priorOwner) : undefined;
    const selected = owner && owns(owner.email!) ? owner : [...eligible].sort((a,b)=>
      ((a.load ?? 0)-(b.load ?? 0)) || a.id.localeCompare(b.id)).map(r=>resolved.get(r.id)!).find(u=>owns(u.email!));
    result = classReview ? {status:"review_required",assignedTo:null,
      reasonCode:"CONTACT_CLASS_REVIEW_REQUIRED",policyVersion:policy?.version ?? "missing"} :
      selected ? {status:owner===selected?"preserved":"assigned",assignedTo:selected.email,
      reasonCode:owner===selected?"OWNER_PRESERVED":"POLICY_DETERMINISTIC_MATCH",policyVersion:policy?.version ?? "existing-owner"}
      : {status:"review_required",assignedTo:null,reasonCode:!policy?"UNASSIGNED_POLICY_MISSING":
        !eligible.length?"NO_CURRENT_ELIGIBLE_REP":"OWNERSHIP_HANDOFF_REQUIRED",policyVersion:policy?.version ?? "missing"};
    const [ordinal] = await tx.select({ next: sql<number>`coalesce(max(${inboundAssignmentDecisions.decisionOrdinal}), -1) + 1` }).from(inboundAssignmentDecisions).where(eq(inboundAssignmentDecisions.requestId, input.requestId));
    await tx.insert(inboundAssignmentDecisions).values({
      requestId: input.requestId,
      decisionOrdinal: Number(ordinal?.next || 0),
      status: result.status,
      assignedTo: result.assignedTo,
      reasonCode: result.reasonCode,
      policyVersion: result.policyVersion,
      policyHash: hash,
      territory: input.territory || null,
      capacitySnapshot: {mode:"configured_load_advisory_not_reserved",reps:policy?.reps ?? []},
      serviceHoursSnapshot: {mode:"not_enforced",configured:(policy?.reps ?? []).some(r=>!!r.serviceHours),
        reason:"No accepted timezone/interval enforcement contract"},
      actorType: input.actorType || "system",
      actorId: input.actorId || null,
      priorAssignee: input.currentOwner || null,
      fence: Number(ordinal?.next || 0),
    }).onConflictDoNothing({ target: [inboundAssignmentDecisions.requestId, inboundAssignmentDecisions.decisionOrdinal] });
    await tx.update(inboundRequests).set({
      assignedTo: result.assignedTo,
      assignmentStatus: result.status,
      updatedAt: new Date(),
    }).where(eq(inboundRequests.id, input.requestId));
    await auditChange({actorType:input.actorType==="user" ? "user":"system",userId:input.actorId,action:"inbound_assignment_decided",
      entityType:"inbound_request",entityKey:request.id,details:{...result,capacityMode:"advisory_not_reserved",serviceHoursMode:"not_enforced"}},tx);
    return result;
  };
  return existingTx ? execute(existingTx) : db.transaction(execute);
}

export async function linkInboundWork(input: {
  requestId: string;
  workType: "task" | "ticket";
  taskId?: number;
  ticketId?: number;
}, existingTx?: InboundTx) {
  const executor = existingTx ?? db;
  const commandKey = `inbound:${input.requestId}:${input.workType}`;
  const [link] = await executor.insert(inboundRequestWorkLinks).values({
    requestId: input.requestId,
    workType: input.workType,
    taskId: input.taskId || null,
    ticketId: input.ticketId || null,
    commandKey,
  }).onConflictDoNothing({ target: [inboundRequestWorkLinks.requestId, inboundRequestWorkLinks.workType] }).returning();
  if (link) return link;
  const [existing] = await executor.select().from(inboundRequestWorkLinks).where(and(eq(inboundRequestWorkLinks.requestId, input.requestId), eq(inboundRequestWorkLinks.workType, input.workType))).limit(1);
  return existing || null;
}

async function completeInternalEffects(requestId: string, effectKeys: readonly string[], existingTx?: InboundTx): Promise<void> {
  const executor = existingTx ?? db;
  if (!effectKeys.length) return;
  const updated = await executor.update(inboundRequestEffects).set({
    state: "sent",
    terminalReason: "INTERNAL_AUTHORITY_COMPLETED",
    updatedAt: new Date(),
  }).where(and(
    eq(inboundRequestEffects.requestId, requestId),
    inArray(inboundRequestEffects.effectKey, [...effectKeys]),
    inArray(inboundRequestEffects.state, ["held", "ready", "attempting"]),
  )).returning({ effectKey: inboundRequestEffects.effectKey });
  // A replay can find effects already truthfully completed, but an absent or
  // terminally failed required effect must never be presented as accepted.
  const completed = new Set(updated.map((effect) => effect.effectKey));
  const existing = await executor.select({
    effectKey: inboundRequestEffects.effectKey,
    state: inboundRequestEffects.state,
  }).from(inboundRequestEffects).where(and(
    eq(inboundRequestEffects.requestId, requestId),
    inArray(inboundRequestEffects.effectKey, [...effectKeys]),
  ));
  for (const effect of existing) {
    if (effect.state === "sent") completed.add(effect.effectKey);
  }
  if (completed.size !== effectKeys.length) throw new Error("INBOUND_INTERNAL_EFFECT_TRANSITION_FAILED");
}

/**
 * An SLA is complete only when the request-scoped work link and the work
 * item's own durable deadline both exist. Work creation alone is not SLA
 * evidence: a task or ticket without its deadline remains actionable only
 * after operator review.
 */
async function completeSlaEffectWhenDurable(
  requestId: string,
  effectKey: string,
  durable: boolean,
  heldReason: string,
  existingTx?: InboundTx,
): Promise<boolean> {
  if (durable) {
    await completeInternalEffects(requestId, [effectKey],existingTx);
    return true;
  }
  // Correct a previously optimistic state as well as preserving a new held
  // intent. Failed/suppressed effects retain their own terminal evidence.
  await (existingTx ?? db).update(inboundRequestEffects).set({
    state: "held",
    terminalReason: heldReason,
    updatedAt: new Date(),
  }).where(and(
    eq(inboundRequestEffects.requestId, requestId),
    eq(inboundRequestEffects.effectKey, effectKey),
    inArray(inboundRequestEffects.state, ["held", "ready", "attempting", "sent"]),
  ));
  return false;
}

async function holdInternalEffects(
  requestId: string,
  effectKeys: readonly string[],
  reason: string,
): Promise<void> {
  if (!effectKeys.length) return;
  await db.update(inboundRequestEffects).set({
    state: "held",
    terminalReason: reason,
    updatedAt: new Date(),
  }).where(and(
    eq(inboundRequestEffects.requestId, requestId),
    inArray(inboundRequestEffects.effectKey, [...effectKeys]),
    inArray(inboundRequestEffects.state, ["held", "ready", "attempting", "sent"]),
  ));
}

/**
 * Complete the internal portion of a claimed public occurrence.  This is the
 * only public-adapter handoff that is allowed to create CR-05 work: its command
 * key is request-derived, so two occurrences for one contact remain distinct
 * while delivery of one occurrence is replay safe.  External effects are
 * deliberately left in their original held state.
 */
export async function orchestrateInboundRequest(input: {
  requestId: string;
  contactId?: number | null;
  dealId?: number | null;
  ticketId?: number | null;
  equipmentOrderIds?: number[];
  notificationId?: number | null;
  territory?: string | null;
}): Promise<InboundRequest> {
  const request = await getInboundRequestById(input.requestId);
  if (!request) throw new Error("INBOUND_REQUEST_NOT_FOUND");
  for (const key of ["contactId","dealId","ticketId"] as const) {
    if (request[key] && input[key] && request[key]!==input[key]) throw new Error("INBOUND_REQUEST_LINK_CHANGED");
  }
  const policy = getInboundSourcePolicy(request.sourceCategory, request.sourceType);
  const slaDueAt = inboundSlaDueAt(policy.sourceClass, request.sourceReceivedAt);

  try {
    const initialLink = await linkInboundRequest(request.id, {
      contactId: input.contactId ?? request.contactId,
      dealId: input.dealId ?? request.dealId,
      ticketId: input.ticketId ?? request.ticketId,
      slaDueAt: slaDueAt ?? request.slaDueAt,
      lifecycleState: "processing",
    });
    if (!initialLink) throw new Error("INBOUND_REQUEST_LINK_FAILED");
    let reviewRequired = false;
    if (policy.sourceClass === "sales_request") {
      const sales = await db.transaction(async tx => {
      const assignment = await evaluateInboundAssignment({
        requestId: request.id,
        currentOwner: request.assignedTo,
        territory: input.territory,
        actorType: "system",
        contactId:input.contactId ?? request.contactId,
        dealId:input.dealId ?? request.dealId,
      },tx);
      if (!input.contactId) throw new Error("INBOUND_SALES_REQUEST_CONTACT_REQUIRED");
      const task = await storage.createAuthorityTask({
        contactId: assignment.reasonCode==="CONTACT_CLASS_REVIEW_REQUIRED" ? undefined : input.contactId,
        dealId: assignment.reasonCode==="CONTACT_CLASS_REVIEW_REQUIRED" ? undefined : input.dealId ?? undefined,
        title: assignment.reasonCode==="CONTACT_CLASS_REVIEW_REQUIRED" ? "Review retained inbound request" : "Follow up inbound sales request",
        description: `Inbound ${request.sourceType} request${!assignment.assignedTo ? ` — Management assignment review: ${assignment.reasonCode}` : ""}`,
        assignedTo: assignment.status==="review_required" ? undefined : assignment.assignedTo ?? undefined,
        dueDate: slaDueAt ?? undefined,
        status: "pending",
        priority: "normal",
        source: "inbound_request",
        automationKey: `inbound-sales:${request.id}`,
      }, {
        producer: "inbound_request",
        commandKey: `inbound:${request.id}:task`,
        issueKey: `inbound-sales:${request.id}`,
        context:{requestId:request.id,slaDueAt:slaDueAt?.toISOString() ?? null,assignmentReason:assignment.reasonCode},
      },tx);
      const link = await linkInboundWork({ requestId: request.id, workType: "task", taskId: task.id },tx);
      if (!link?.taskId || link.taskId !== task.id) throw new Error("INBOUND_SALES_WORK_LINK_FAILED");
      // Occurrence replay must not overwrite a later human deadline.
      const [taskWithDueDate] = await tx.select({
        id: tasks.id,
        dueDate: tasks.dueDate,
      }).from(tasks).where(eq(tasks.id,task.id));
      await completeInternalEffects(request.id, ["sales_work"],tx);
      let review = assignment.status==="review_required";
      if (!await completeSlaEffectWhenDurable(
        request.id,
        "sales_sla",
        Boolean(link.taskId && taskWithDueDate?.dueDate && slaDueAt
          && taskWithDueDate.dueDate.getTime() === slaDueAt.getTime()),
        "SALES_SLA_TASK_DUE_DATE_OR_LINK_MISSING",
        tx,
      )) {
        review = true;
      }
      if (assignment.assignedTo && !review) {
        await completeInternalEffects(request.id, ["assignment"],tx);
      } else {
        review = true;
        await tx.update(inboundRequestEffects).set({state:"held",terminalReason:assignment.reasonCode,updatedAt:new Date()})
          .where(and(eq(inboundRequestEffects.requestId,request.id),eq(inboundRequestEffects.effectKey,"assignment")));
      }
      return {review};
      });
      reviewRequired ||= sales.review;
    } else if (policy.sourceClass === "support_request") {
      if (!input.ticketId) throw new Error("INBOUND_SUPPORT_REQUEST_TICKET_REQUIRED");
      const link = await linkInboundWork({ requestId: request.id, workType: "ticket", ticketId: input.ticketId });
      if (!link?.ticketId || link.ticketId !== input.ticketId) throw new Error("INBOUND_SUPPORT_WORK_LINK_FAILED");
      const [ticketWithDueDate] = await db.update(tickets).set({
        slaDeadline: slaDueAt ?? null,
      }).where(eq(tickets.id, input.ticketId)).returning({
        id: tickets.id,
        slaDeadline: tickets.slaDeadline,
      });
      await completeInternalEffects(request.id, ["support_ticket"]);
      if (!await completeSlaEffectWhenDurable(
        request.id,
        "support_sla",
        Boolean(link.ticketId && ticketWithDueDate?.slaDeadline && slaDueAt
          && ticketWithDueDate.slaDeadline.getTime() === slaDueAt.getTime()),
        "SUPPORT_SLA_TICKET_DUE_DATE_OR_LINK_MISSING",
      )) {
        reviewRequired = true;
      }
    } else if (policy.sourceClass === "fulfillment_request") {
      if (!input.contactId || !input.dealId || !input.notificationId
        || !input.equipmentOrderIds?.length || !slaDueAt) {
        throw new Error("FULFILLMENT_AUTHORITY_HANDOFF_REQUIRED");
      }
      const orderIds = [...new Set(input.equipmentOrderIds)];
      const [ownedDeal] = await db.select({ id: deals.id }).from(deals).where(and(
        eq(deals.id, input.dealId),
        eq(deals.inboundRequestId, request.id),
        eq(deals.contactId, input.contactId),
        eq(deals.pipeline, "fulfillment"),
      )).limit(1);
      const ownedOrders = await db.select({
        id: equipmentOrders.id,
        fulfillmentDueAt: equipmentOrders.fulfillmentDueAt,
      }).from(equipmentOrders).where(and(
        inArray(equipmentOrders.id, orderIds),
        eq(equipmentOrders.inboundRequestId, request.id),
        eq(equipmentOrders.dealId, input.dealId),
        eq(equipmentOrders.contactId, input.contactId),
      ));
      const [ownedNotification] = await db.select({ id: notifications.id }).from(notifications).where(and(
        eq(notifications.id, input.notificationId),
        eq(notifications.inboundRequestId, request.id),
        eq(notifications.commandKey, `inbound:${request.id}:equipment-notification`),
      )).limit(1);
      const durableSla = ownedOrders.length === orderIds.length
        && ownedOrders.every((order) => order.fulfillmentDueAt?.getTime() === slaDueAt.getTime());
      if (!ownedDeal || !ownedNotification || !durableSla) {
        await holdInternalEffects(
          request.id,
          ["fulfillment", "fulfillment_sla", "internal_notification"],
          "FULFILLMENT_DURABLE_EVIDENCE_MISSING",
        );
        reviewRequired = true;
      } else {
        // Only evidence already committed by the existing equipment/deal/
        // notification authorities can complete these internal effects.
        await completeInternalEffects(request.id, [
          "fulfillment",
          "fulfillment_sla",
          "internal_notification",
        ]);
      }
    } else {
      // No competing fulfillment, moderation, marketing, or import authority
      // exists here. Their required internal effects remain held for that
      // authority rather than being falsely completed by this envelope.
      reviewRequired = true;
    }

    const linked = await linkInboundRequest(request.id, {
      contactId: input.contactId ?? request.contactId,
      dealId: input.dealId ?? request.dealId,
      ticketId: input.ticketId ?? request.ticketId,
      slaDueAt: slaDueAt ?? request.slaDueAt,
      lifecycleState: reviewRequired ? "review_required" : "processing",
    });
    if (!linked) throw new Error("INBOUND_REQUEST_LINK_FAILED");
    const reconciled = await reconcileInboundRequestLifecycle({
      requestId: request.id,
      incompleteState: reviewRequired ? "review_required" : "processing",
      completedState: "accepted",
    });
    if (!reconciled) throw new Error("INBOUND_REQUEST_RECONCILIATION_FAILED");
    return reconciled;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "INBOUND_ORCHESTRATION_FAILED";
    await setInboundRequestLifecycle(request.id, reason.includes("POLICY") || reason.includes("REVIEW")
      ? "review_required"
      : "failed", reason);
    throw error;
  }
}

/**
 * An ambiguous callback has sales intent, but no safe contact identity.
 * Keep its sales effects held until an operator resolves identity. A
 * request-keyed notification is the actionable, contactless review handoff.
 * Both the handoff and review state commit atomically.
 */
export async function queueAmbiguousCallbackReview(input: {
  requestId: string;
  candidateContactIds: number[];
  name: string;
  phone: string;
  bestTime?: string;
}): Promise<InboundRequest> {
  if (input.candidateContactIds.length < 2) throw new Error("CALLBACK_REVIEW_REQUIRES_MULTIPLE_CANDIDATES");
  const request = await getInboundRequestById(input.requestId);
  if (!request || request.sourceCategory !== "website_form" || request.sourceType !== "callback_form") {
    throw new Error("CALLBACK_REVIEW_REQUEST_NOT_FOUND");
  }
  const dueAt = inboundSlaDueAt("sales_request", request.sourceReceivedAt);
  const commandKey = `inbound:${request.id}:callback-identity-review`;
  return db.transaction(async (tx) => {
    await tx.insert(notifications).values({
      inboundRequestId: request.id,
      commandKey,
      channel: "#sales",
      title: "Callback identity needs review",
      message: `Callback from ${input.name} (${input.phone}); best time: ${input.bestTime || "Anytime"}. Multiple contacts match this number. Review request ${request.id} before attaching to a contact or creating sales work.`,
      type: "alert",
      metadata: { candidateContactIds: [...new Set(input.candidateContactIds)], dueAt: dueAt?.toISOString() },
    }).onConflictDoNothing();
    const [notice] = await tx.select({ id: notifications.id }).from(notifications)
      .where(and(eq(notifications.inboundRequestId, request.id), eq(notifications.commandKey, commandKey))).limit(1);
    if (!notice) throw new Error("CALLBACK_REVIEW_NOTIFICATION_MISSING");
    const [updated] = await tx.update(inboundRequests).set({
      lifecycleState: "review_required",
      terminalReason: "AMBIGUOUS_CALLBACK_IDENTITY",
      assignmentStatus: "review_required",
      slaDueAt: dueAt,
      updatedAt: new Date(),
    }).where(eq(inboundRequests.id, request.id)).returning();
    if (!updated) throw new Error("CALLBACK_REVIEW_REQUEST_NOT_FOUND");
    // Sales assignment, work, SLA, and external effects remain held; no
    // candidate is treated as the owner merely because their number matches.
    return updated;
  });
}

export async function getInboundRequestById(id: string): Promise<InboundRequest | null> {
  const [row] = await db.select().from(inboundRequests).where(eq(inboundRequests.id, id)).limit(1);
  return row || null;
}

/**
 * Read a public receipt only when every capability presented by its original
 * caller matches. A miss intentionally has one result for unknown receipts,
 * incorrect idempotency keys, and caller-scope mismatches.
 */
export async function getPublicInboundRequestStatus(input: {
  requestReceipt: string;
  idempotencyKey: string;
  callerScope: string;
}): Promise<PublicInboundRequestStatus | null> {
  const [row] = await db.select({
    requestReceipt: inboundRequests.id,
    status: inboundRequests.lifecycleState,
  }).from(inboundRequests).where(and(
    eq(inboundRequests.id, input.requestReceipt),
    eq(inboundRequests.idempotencyKey, input.idempotencyKey),
    eq(inboundRequests.callerScope, input.callerScope),
  )).limit(1);
  return row || null;
}

export async function listInboundRequests(input: {
  limit?: number;
  offset?: number;
  sourceClass?: string;
  lifecycleState?: string;
}) {
  const limit = Math.min(Math.max(input.limit || 50, 1), 200);
  const offset = Math.max(input.offset || 0, 0);
  const filters = [];
  if (input.sourceClass) filters.push(eq(inboundRequests.sourceClass, input.sourceClass));
  if (input.lifecycleState) filters.push(eq(inboundRequests.lifecycleState, input.lifecycleState));
  return db.select().from(inboundRequests)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(inboundRequests.createdAt))
    .limit(limit)
    .offset(offset);
}