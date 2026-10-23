#!/usr/bin/env tsx
/**
 * CRO-05A deterministic static certification.
 *
 * This deliberately reads source rather than importing the inbound authority:
 * that authority is database-bound, while this gate must run without a server,
 * database, Redis, or provider configuration.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

let checks = 0;
function check(name: string, fn: () => void): void {
  fn();
  checks++;
  console.log(`PASS ${name}`);
}

function source(file: string): string {
  assert.ok(existsSync(file), `required CRO-05A file is missing: ${file}`);
  return readFileSync(file, "utf8");
}

function routeBody(routes: string, route: string): string {
  const start = routes.indexOf(`app.post("${route}"`);
  assert.notEqual(start, -1, `public route is missing: ${route}`);
  const next = routes.indexOf("\n  app.", start + 1);
  return routes.slice(start, next === -1 ? undefined : next);
}

function withoutRetiredProposalHelper(routes: string): string {
  const start = routes.indexOf("async function legacyAutoProposalEmail");
  assert.notEqual(start, -1, "retired proposal helper disposition is missing");
  const end = routes.indexOf("\n\n  // === PUBLIC FORM SUBMISSIONS ===", start);
  assert.notEqual(end, -1, "cannot determine retired proposal helper boundary");
  return routes.slice(0, start) + routes.slice(end);
}

const authority = source("server/services/inbound-request-authority.ts");
const publicRoutes = source("server/routes/public.ts");
const importsRoutes = source("server/routes/imports.ts");
const leadOpsRoutes = source("server/routes/lead-ops.ts");
const leadOpsUi = source("client/src/pages/dashboard/LeadOpsCenter.tsx");
const statementWorker = source("server/services/statement-command-worker.ts");
const statementChain = source("server/services/statement-upload-chain.ts");
const statementAnalyzer = source("server/services/statement-analyzer.ts");
const freeAnalysisUi = source("client/src/pages/FreeAnalysis.tsx");
const schema = source("shared/schema.ts");
const migration = source("migrations/0204_cro05a_inbound_revenue_operations.sql");
const equipmentMigration = source("migrations/0205_cro05a_equipment_fulfillment_truth.sql");

const publicPostRoutes = readdirSync("server/routes")
  .filter(file => file.endsWith(".ts"))
  .flatMap(file => {
    const body = source(`server/routes/${file}`);
    return [...body.matchAll(/app\.post\("(\/api\/public\/[^"]+)"/g)]
      .map(match => ({ file, route: match[1] }));
  });
const certifiedPublicIntakes = new Map([
  ["/api/public/statement-upload", "public.ts"],
  ["/api/public/estimate", "public.ts"],
  ["/api/public/support", "public.ts"],
  ["/api/public/get-started", "public.ts"],
  ["/api/public/integration-request", "public.ts"],
  ["/api/public/callback", "public.ts"],
  ["/api/public/testimonial-submit", "public.ts"],
  ["/api/public/free-analysis", "imports.ts"],
]);
// These are continuation commands over an already-established chat/proposal
// capability, not contact/request intake adapters. Keeping the disposition
// exhaustive makes a newly added public POST fail this gate until classified.
const publicContinuationCommands = new Set([
  "/api/public/chat/session",
  "/api/public/chat/session/:sessionId/message",
  "/api/public/chat/session/:sessionId/identify",
  "/api/public/chat/session/:sessionId/close",
  "/api/public/chat/offline",
  "/api/public/proposal/:token/accept",
  "/api/public/co-branded-proposal/:token/accept",
]);

check("every public POST route is enumerated and every intake is authority-owned", () => {
  const discovered = new Set(publicPostRoutes.map(entry => entry.route));
  for (const entry of publicPostRoutes) {
    assert.ok(
      certifiedPublicIntakes.has(entry.route) || publicContinuationCommands.has(entry.route),
      `unclassified public POST route ${entry.file}:${entry.route}`,
    );
  }
  for (const [route, file] of certifiedPublicIntakes) {
    assert.ok(discovered.has(route), `certified public intake is missing: ${route}`);
    const routes = file === "public.ts" ? publicRoutes : importsRoutes;
    if (route === "/api/public/statement-upload" || route === "/api/public/free-analysis") {
      const body = routeBody(routes, route);
      assert.match(body, /claimInboundRequest\(/, `${route} does not claim authority`);
    } else {
      assert.match(publicRoutes, new RegExp(`"${route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}": \\["website_form"`));
      assert.match(routeBody(routes, route), /acceptInbound\(req,/, `${route} does not hand off to authority`);
    }
  }
});

check("all CRO-05A source classes are frozen in the source policy", () => {
  const classes = [
    "sales_request",
    "support_request",
    "fulfillment_request",
    "partner_application_request",
    "privacy_request",
    "marketing_opt_in",
    "content_reputation",
    "lifecycle_event",
    "imported_provider_event",
  ];
  for (const sourceClass of classes) {
    assert.match(authority, new RegExp(`"${sourceClass}"`), `missing source class ${sourceClass}`);
  }
  assert.match(authority, /INBOUND_MANIFEST_VERSION\s*=\s*"cro05a-v2"/);
  assert.match(authority, /getInboundSourcePolicy[\s\S]*INVALID_INBOUND_SOURCE_COMBINATION/);
  assert.match(authority, /state:\s*"held"/);
});

check("source policy forbids sales and promotional effects for non-sales sources", () => {
  for (const sourceType of ["support_form", "testimonial_submit", "newsletter_signup"]) {
    const policyLine = authority.split("\n").find(line => line.includes(`sourceType: "${sourceType}"`));
    assert.ok(policyLine, `missing ${sourceType} policy`);
    assert.match(policyLine, /forbiddenEffects: \["sales_assignment", "cr05_task", "deal_create", "promotional_enrollment"\]/);
  }
  const equipmentPolicy = authority.split("\n").find(line => line.includes('sourceType: "equipment_order"'));
  assert.ok(equipmentPolicy, "missing equipment_order policy");
  assert.match(equipmentPolicy, /forbiddenEffects: \["sales_assignment", "cr05_task", "promotional_enrollment"\]/);
  assert.doesNotMatch(equipmentPolicy, /"deal_create"/);
  assert.match(authority, /sourceType: "testimonial_submit"[\s\S]{0,500}type: "moderation_review"/);
  assert.match(authority, /sourceType: "newsletter_signup"[\s\S]{0,500}type: "cr04_eligibility"/);
});

check("active public intake handlers have no direct transport or enrollment call", () => {
  const activeRoutes = withoutRetiredProposalHelper(publicRoutes);
  assert.doesNotMatch(activeRoutes, /\b(?:sendGhlEmail|sendGhlSms|sendSmtpEmail|sendProposalEmail)\s*\(/);
  assert.doesNotMatch(activeRoutes, /\b(?:enrollInInboundConfirmation|autoEnrollFromTrigger|createSequenceEnrollment|enrollContactInSequence)\s*\(/);
  const freeAnalysis = routeBody(importsRoutes, "/api/public/free-analysis");
  assert.doesNotMatch(freeAnalysis, /\b(?:triggerWorkflowsByEvent|enqueuePromotionalEnrollment|sendConfirmationSms|syncFormSubmissionToGhl|enrollInInboundConfirmation|evaluateContactability|ingestBusinessFromContact|routeContact|generateDealBlueprint|scoreContact|trackReferral)\s*\(/);
  assert.match(authority, /const FREE_ANALYSIS_EFFECTS[\s\S]{0,700}workflow_dispatch/);
  assert.match(authority, /const FREE_ANALYSIS_EFFECTS[\s\S]{0,700}provider_sync/);
  assert.match(authority, /sourceType: "free_analysis"[\s\S]{0,200}effects: FREE_ANALYSIS_EFFECTS/);
  assert.match(authority, /sourceType: "free_analysis"[\s\S]{0,700}forbiddenEffects: \["promotional_enrollment", "proposal_send"\]/);
  // The legacy helper remains only as an unreachable compatibility disposition;
  // a future handler must not revive it instead of writing a held effect intent.
  assert.equal((publicRoutes.match(/\blegacyAutoProposalEmail\s*\(/g) ?? []).length, 1);
});

check("free analysis owns authority before mutation and returns opaque persisted lifecycle", () => {
  const route = routeBody(importsRoutes, "/api/public/free-analysis");
  assert.match(route, /req\.header\("Idempotency-Key"\)/);
  assert.match(route, /sourceCategory:\s*"website_form",\s*sourceType:\s*"free_analysis"/);
  assert.ok(
    route.indexOf("claimInboundRequest({") < route.indexOf("createContactLocalFirst({"),
    "free analysis mutates contact state before claiming the request",
  );
  assert.match(route, /const submissionId = inboundClaim\.request\.id/);
  assert.match(route, /const request = await orchestrateInboundRequest\(\{/);
  assert.match(route, /res\.status\(201\)\.json\(\{ requestReceipt: request\.id, status: request\.lifecycleState \}\)/);
  assert.match(route, /requestReceipt: inboundClaim\.request\.id,\s*status: inboundClaim\.request\.lifecycleState/);
  assert.doesNotMatch(route, /status:\s*"(?:accepted|processing|review_required)"/);
  assert.doesNotMatch(route, /res\.status\(201\)\.json\(\{[\s\S]{0,250}\b(?:contactId|dealId|submissionId|estimatedSavings|recommendedProgram|recommendedTerminal)\b/);
});

check("free analysis browser retries reuse one key and treat receipts as opaque", () => {
  const submitStart = freeAnalysisUi.indexOf("const handleSubmit = async () =>");
  const submitEnd = freeAnalysisUi.indexOf("\n  const results =", submitStart);
  assert.notEqual(submitStart, -1, "free analysis submit handler is missing");
  assert.notEqual(submitEnd, -1, "cannot determine free analysis submit handler boundary");
  const submit = freeAnalysisUi.slice(submitStart, submitEnd);

  assert.match(freeAnalysisUi, /const submissionIdempotencyKey = useRef<string \| null>\(null\)/);
  assert.match(submit, /submissionIdempotencyKey\.current \?\?= crypto\.randomUUID\(\)/);
  assert.match(
    submit,
    /\{\s*"Idempotency-Key": submissionIdempotencyKey\.current\s*\}/,
    "free analysis does not send its form-held key",
  );
  assert.equal(
    (submit.match(/crypto\.randomUUID\(\)/g) ?? []).length,
    1,
    "free analysis must generate a key once per mounted submission, not per request attempt",
  );
  assert.doesNotMatch(
    submit,
    /(?:const|let|var)\s+\w+\s*=\s*await apiRequest|\.json\(\)|\.text\(\)/,
    "free analysis must not consume or expose the opaque receipt response",
  );
});

check("partner referral returns orchestration lifecycle and replay equality", () => {
  const route = routeBody(importsRoutes, "/api/affiliate/referral");
  assert.match(route, /const request = await orchestrateInboundRequest\(\{ requestId: inboundClaim\.request\.id, contactId: contact\.id \}\)/);
  assert.match(route, /res\.status\(201\)\.json\(\{ requestReceipt: request\.id, status: request\.lifecycleState \}\)/);
  assert.match(route, /requestReceipt: inboundClaim\.request\.id, status: inboundClaim\.request\.lifecycleState/);
  assert.doesNotMatch(route, /status:\s*"(?:accepted|processing|review_required)"/);
  assert.doesNotMatch(route, /res\.status\(201\)\.json\(\{[^}]*\b(?:success|contactId|dealId|referralId)\b/);
});

check("claimed free-analysis and referral failures persist a safe honest lifecycle before responding", () => {
  assert.match(importsRoutes, /claimInboundRequest, orchestrateInboundRequest, setInboundRequestLifecycle/);
  for (const routeName of ["/api/public/free-analysis", "/api/affiliate/referral"]) {
    const route = routeBody(importsRoutes, routeName);
    assert.match(route, /let claimedRequestId: string \| null = null/);
    assert.match(route, /claimedRequestId = (?:submissionId|inboundClaim\.request\.id)/);
    assert.match(route, /await setInboundRequestLifecycle\(\s*claimedRequestId,\s*mutationStarted \? "review_required" : "failed"/);
    assert.match(route, /mutationStarted \? "(?:FREE_ANALYSIS|AFFILIATE_REFERRAL)_PARTIAL_MUTATION" : "(?:FREE_ANALYSIS|AFFILIATE_REFERRAL)_PROCESSING_FAILED"/);
    assert.doesNotMatch(route, /terminalReason:\s*err(?:\.message)?/);
  }
  const freeAnalysis = routeBody(importsRoutes, "/api/public/free-analysis");
  assert.doesNotMatch(freeAnalysis, /createReviewQueueItem\([\s\S]{0,200}\)\.catch/);
});

check("statement SMS and PEWC evidence cannot create email consent", () => {
  const statementRoute = routeBody(publicRoutes, "/api/public/statement-upload");
  assert.match(statementRoute, /incomingConsent:\s*\{\s*consentSms:\s*parseBool\(consentSms\)\s*\?\s*true\s*:\s*undefined\s*\}/);
  assert.match(statementRoute, /channel:\s*"sms"/);
  assert.match(statementRoute, /recordPewcDecision\(/);
  assert.doesNotMatch(statementRoute, /consentEmail\s*:\s*parseBool\(consentSms\)/);
  assert.doesNotMatch(statementRoute, /channel:\s*"email"[\s\S]{0,300}consentSms/);
  assert.doesNotMatch(statementRoute, /channel:\s*"email"[\s\S]{0,300}pewcConsent/);
});

check("statement upload claims the canonical inbound occurrence before contact or command handoff", () => {
  const statementRoute = routeBody(publicRoutes, "/api/public/statement-upload");
  assert.match(statementRoute, /claimInboundRequest\(\{\s*idempotencyKey,\s*sourceCategory:\s*"website_form",\s*sourceType:\s*"statement_upload"/);
  assert.match(statementRoute, /requestFingerprint:\s*fingerprint/);
  assert.match(statementRoute, /callerScope,/);
  assert.match(statementRoute, /const submissionId = inboundClaim\.request\.id/);
  assert.match(statementRoute, /status:\s*inboundClaim\.request\.lifecycleState/);
  assert.doesNotMatch(statementRoute, /status:\s*"(?:accepted|processing)"/);
  assert.match(statementRoute, /eventKey:\s*`form:statement_upload:\$\{submissionId\}`/);
  assert.match(statementRoute, /await persistAndEnqueueStatementCommand\(/);
  assert.match(statementRoute, /const inboundResponse = await acceptInbound\(req, \{\s*contactId:\s*contact\.id/);
  assert.match(statementRoute, /res\.status\(202\)\.json\(inboundResponse\)/);
  assert.doesNotMatch(statementRoute, /X-Statement-Upload-Request-Id|statement_upload_request_id/);
  assert.doesNotMatch(statementRoute, /crypto\.randomUUID\(\)/);
  assert.match(authority, /requestFingerprint\?: string/);
  assert.match(authority, /const requestFingerprint = input\.requestFingerprint \|\| hashPayload\(input\.payload\)/);
});

check("statement execution uses opaque protected objects and no checkout-local paths", () => {
  assert.match(statementWorker, /putProtectedObject\(/);
  assert.match(statementWorker, /getProtectedObject\(objectRef, authorization, expectedChecksum\)/);
  assert.match(statementWorker, /protectedObjectRef/);
  assert.match(statementChain, /storageKey\s*=\s*object\.objectRef/);
  assert.match(statementAnalyzer, /extractTextFromProtectedObject\(\s*selectedDoc\.storageKey/);
  for (const [name, file] of Object.entries({ statementWorker, statementChain, statementAnalyzer })) {
    assert.doesNotMatch(file, /uploads\/(?:statement-command|statements)|process\.cwd\(\).*statement/i, `${name} retains a local statement path`);
    assert.doesNotMatch(file, /\b(?:readFileSync|createReadStream|writeFileSync)\s*\(/, `${name} performs local statement file I/O`);
  }
});

check("statement request handoff and worker lifecycle share durable authority evidence", () => {
  const statementRoute = routeBody(publicRoutes, "/api/public/statement-upload");
  assert.match(statementRoute, /inboundRequestId:\s*submissionId/);
  assert.match(statementWorker, /protectedObjectRef:\s*object\.objectRef/);
  assert.match(statementWorker, /effectKey:\s*"statement_review"/);
  assert.match(statementWorker, /terminalReason:\s*"DURABLE_STATEMENT_COMMAND_HANDOFF"/);
  assert.match(statementWorker, /state:\s*"ready",\s*terminalReason:\s*"DURABLE_STATEMENT_COMMAND_HANDOFF"/);
  assert.match(statementWorker, /state:\s*"attempting",\s*terminalReason:\s*"STATEMENT_WORKER_CLAIMED"/);
  assert.match(statementWorker, /state:\s*"sent",\s*terminalReason:\s*"STATEMENT_WORKER_COMPLETED"/);
  assert.match(statementWorker, /state:\s*"failed",\s*terminalReason:\s*"STATEMENT_COMMAND_RETRYABLE_FAILURE"/);
  assert.match(statementWorker, /const queued = await enqueueStatementUploadCommandId/);
  assert.ok(
    statementWorker.indexOf('terminalReason: "DURABLE_STATEMENT_COMMAND_HANDOFF"')
      > statementWorker.indexOf("const queued = await enqueueStatementUploadCommandId"),
    "statement handoff may only complete after durable queue ownership",
  );
  assert.match(statementWorker, /setInboundRequestLifecycle\(inboundRequestId, "processing"/);
  assert.match(statementWorker, /completedState:\s*"completed"/);
  assert.match(statementWorker, /STATEMENT_COMMAND_RETRYABLE_FAILURE/);
  assert.match(statementRoute, /ownedCommandId = null/);
  assert.match(statementRoute, /ownedInboundRequestId = null/);
  assert.doesNotMatch(statementRoute, /(?:protectedObjectRef|commandId):\s*(?:inboundResponse|statementQueued)/);
});

check("request lifecycle is gated by required internal effects only", () => {
  assert.match(authority, /export function decideInboundLifecycle/);
  assert.match(authority, /eq\(inboundRequestEffects\.required, true\)/);
  assert.match(authority, /eq\(inboundRequestEffects\.externalSideEffect, false\)/);
  assert.match(authority, /effects\.some\(\(effect\) => effect\.state !== "sent"\)/);
  assert.match(authority, /reconcileInboundRequestLifecycle\(\{/);
  assert.match(authority, /completedState:\s*"accepted"/);
});

check("testimonial handling is moderation-only and creates no sales deal", () => {
  const testimonial = routeBody(publicRoutes, "/api/public/testimonial-submit");
  assert.match(testimonial, /createTestimonialSubmission\(/);
  assert.match(testimonial, /status:\s*"pending"/);
  assert.match(testimonial, /publish:\s*false/);
  assert.match(testimonial, /dealId:\s*null/);
  assert.doesNotMatch(testimonial, /\bcreateDeal\s*\(/);
  assert.doesNotMatch(testimonial, /\bprocessNewLead\s*\(/);
});

check("newsletter handling records intake only and never directly enrolls", () => {
  const newsletter = routeBody(publicRoutes, "/api/newsletter/subscribe");
  assert.match(newsletter, /sourceType:\s*"newsletter_signup"/);
  assert.match(newsletter, /writeContact\(|processExistingPublicFormSubmission\(/);
  assert.doesNotMatch(newsletter, /\b(?:enroll|createDeal|processNewLead)\w*\s*\(/i);
});

check("public inbound middleware returns opaque receipts rather than entity identifiers", () => {
  assert.match(publicRoutes, /const PUBLIC_INBOUND_SOURCES/);
  assert.match(publicRoutes, /app\.use\(async \(req, res, next\) =>/);
  assert.match(publicRoutes, /async function acceptInbound\(/);
  const acceptStart = publicRoutes.indexOf("async function acceptInbound");
  const acceptEnd = publicRoutes.indexOf("\n\n  async function failInbound", acceptStart);
  const acceptInbound = publicRoutes.slice(acceptStart, acceptEnd);
  assert.match(acceptInbound, /const request = await orchestrateInboundRequest\(\{ requestId, \.\.\.refs \}\)/);
  assert.match(acceptInbound, /requestReceipt:\s*request\.id/);
  assert.match(acceptInbound, /status:\s*request\.lifecycleState/);
  assert.doesNotMatch(acceptInbound, /status:\s*"accepted"/);
  const middlewareStart = publicRoutes.indexOf("app.use(async (req, res, next) =>");
  const middlewareEnd = publicRoutes.indexOf("\n  const autoProposalRateLimit", middlewareStart);
  const middleware = publicRoutes.slice(middlewareStart, middlewareEnd);
  assert.doesNotMatch(middleware, /requestReceipt:\s*body\.(?:contactId|dealId|ticketId|submissionId)/);
  assert.doesNotMatch(middleware, /contactId:\s*body|dealId:\s*body|ticketId:\s*body/);
});

check("public inbound status polling requires receipt, key, and scope and returns lifecycle only", () => {
  assert.match(publicRoutes, /app\.get\("\/api\/public\/inbound-requests\/:receipt\/status"/);
  const statusStart = publicRoutes.indexOf('app.get("/api/public/inbound-requests/:receipt/status"');
  const statusEnd = publicRoutes.indexOf("\n  const autoProposalRateLimit", statusStart);
  const statusRoute = publicRoutes.slice(statusStart, statusEnd);
  assert.match(statusRoute, /req\.header\("Idempotency-Key"\)/);
  assert.match(statusRoute, /callerScope:\s*publicInboundCallerScope\(req\)/);
  assert.match(statusRoute, /res\.status\(404\)\.json\(\{ error: "Request not found" \}\)/);
  assert.match(statusRoute, /return res\.status\(200\)\.json\(status\)/);
  assert.doesNotMatch(statusRoute, /\b(?:contactId|dealId|ticketId|assignedTo|protectedObjectRef|terminalReason|requestFingerprint)\b/);
  assert.match(authority, /export async function getPublicInboundRequestStatus/);
  const helperStart = authority.indexOf("export async function getPublicInboundRequestStatus");
  const helperEnd = authority.indexOf("\nexport async function listInboundRequests", helperStart);
  const helper = authority.slice(helperStart, helperEnd);
  assert.match(helper, /eq\(inboundRequests\.idempotencyKey, input\.idempotencyKey\)/);
  assert.match(helper, /eq\(inboundRequests\.callerScope, input\.callerScope\)/);
  assert.match(helper, /requestReceipt:\s*inboundRequests\.id/);
  assert.match(helper, /status:\s*inboundRequests\.lifecycleState/);
  assert.doesNotMatch(helper, /\b(?:update|insert|delete)\(/);
});

check("orchestration creates request-scoped work, persists work deadlines, and certifies SLAs truthfully", () => {
  assert.match(authority, /export function addBusinessHoursUtc/);
  assert.match(authority, /BUSINESS_DAY_START_HOUR_UTC = 9/);
  assert.match(authority, /BUSINESS_DAY_END_HOUR_UTC = 17/);
  assert.match(authority, /export function inboundSlaDueAt/);
  assert.match(authority, /SALES_SLA_BUSINESS_HOURS = 24/);
  assert.match(authority, /SUPPORT_SLA_BUSINESS_HOURS = 4/);
  assert.match(authority, /commandKey:\s*`inbound:\$\{request\.id\}:task`/);
  assert.match(authority, /dueDate:\s*slaDueAt \?\? undefined/);
  assert.match(authority, /await linkInboundWork\(\{ requestId: request\.id, workType: "ticket", ticketId: input\.ticketId \}\)/);
  assert.match(authority, /slaDeadline:\s*slaDueAt \?\? null/);
  assert.match(authority, /completeSlaEffectWhenDurable/);
  assert.match(authority, /SALES_SLA_TASK_DUE_DATE_OR_LINK_MISSING/);
  assert.match(authority, /SUPPORT_SLA_TICKET_DUE_DATE_OR_LINK_MISSING/);
  assert.match(authority, /FULFILLMENT_AUTHORITY_HANDOFF_REQUIRED/);
  assert.doesNotMatch(authority, /completeInternalEffects\(request\.id, \["sales_work", "sales_sla"\]\)/);
  assert.doesNotMatch(authority, /completeInternalEffects\(request\.id, \["support_ticket", "support_sla"\]\)/);
  assert.match(authority, /incompleteState: reviewRequired \? "review_required" : "processing"/);
  assert.match(authority, /completedState:\s*"accepted"/);
  assert.match(authority, /:\s*"failed", reason\)/);
  const orchestration = authority.slice(authority.indexOf("export async function orchestrateInboundRequest"));
  assert.doesNotMatch(orchestration, /transactional_ack[\s\S]{0,120}state:\s*"sent"/);
});

check("equipment fulfillment is request-owned, replay-fenced, and completed from durable evidence", () => {
  const route = routeBody(publicRoutes, "/api/equipment-order");
  const middlewareClaim = publicRoutes.indexOf("const claim = await claimInboundRequest({");
  const middlewareNext = publicRoutes.indexOf("return next();", middlewareClaim);
  assert.ok(middlewareClaim !== -1 && middlewareClaim < middlewareNext);
  assert.match(publicRoutes, /"\/api\/equipment-order": \["website_form", "equipment_order"\]/);
  assert.match(route, /INBOUND_REQUEST_CLAIM_REQUIRED/);
  assert.ok(
    route.indexOf("INBOUND_REQUEST_CLAIM_REQUIRED") < route.indexOf("storage.getContactByEmail"),
    "equipment route can mutate before proving request ownership",
  );
  assert.match(route, /inboundRequestId:\s*submissionId/);
  assert.match(route, /commandKey:\s*`inbound:\$\{submissionId\}:equipment-order:\$\{itemIndex\}`/);
  assert.match(route, /fulfillmentDueAt/);
  assert.match(route, /commandKey:\s*`inbound:\$\{submissionId\}:equipment-notification`/);
  assert.match(route, /equipmentOrderIds,\s*notificationId:\s*notification\.id/);
  assert.doesNotMatch(route, /\btrackReferral\s*\(/);
  assert.doesNotMatch(route, /resolveReferralAttribution\s*\(/);
  assert.doesNotMatch(route, /status:\s*"(?:accepted|processing|review_required)"/);

  assert.match(authority, /key:\s*"internal_notification",\s*type:\s*"internal_notification",\s*required:\s*true,\s*external:\s*false/);
  assert.match(authority, /eq\(deals\.inboundRequestId, request\.id\)/);
  assert.match(authority, /eq\(equipmentOrders\.inboundRequestId, request\.id\)/);
  assert.match(authority, /eq\(notifications\.inboundRequestId, request\.id\)/);
  assert.match(authority, /await completeInternalEffects\(request\.id, \[\s*"fulfillment",\s*"fulfillment_sla",\s*"internal_notification"/);
  assert.match(authority, /transactional_ack[\s\S]{0,120}external:\s*true/);

  assert.match(schema, /deals_inbound_request_uidx/);
  assert.match(schema, /equipment_orders_command_key_uidx/);
  assert.match(schema, /notifications_command_key_uidx/);
  assert.match(equipmentMigration, /ADD COLUMN IF NOT EXISTS inbound_request_id UUID REFERENCES inbound_requests\(id\)/);
  assert.match(equipmentMigration, /CREATE UNIQUE INDEX IF NOT EXISTS equipment_orders_command_key_uidx/);
  assert.match(equipmentMigration, /CREATE UNIQUE INDEX IF NOT EXISTS notifications_command_key_uidx/);
});

check("operator API and Lead Ops view return every effect truthfully", () => {
  assert.match(leadOpsRoutes, /from\(inboundRequestEffects\)/);
  assert.match(leadOpsRoutes, /effects: effectsByRequest\.get\(row\.id\) \|\| \[\]/);
  assert.match(leadOpsUi, /effects: Array<\{/);
  assert.match(leadOpsUi, /request\.effects\.map\(\(effect\)/);
  assert.match(leadOpsUi, /effect\.externalSideEffect/);
});

check("CRO-05A migration and Drizzle schema expose matching durable identities", () => {
  for (const table of ["protected_objects", "inbound_requests", "inbound_request_effects", "inbound_assignment_decisions", "inbound_request_work_links"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(migration, /UNIQUE \(source_category, source_type, occurrence_key\)/);
  assert.match(migration, /UNIQUE \(request_id, effect_key\)/);
  assert.match(migration, /UNIQUE \(request_id, work_type\)/);
  assert.match(migration, /encrypted_bytes BYTEA NOT NULL/);
  for (const declaration of ["protectedObjects", "inboundRequests", "inboundRequestEffects", "inboundAssignmentDecisions", "inboundRequestWorkLinks"]) {
    assert.match(schema, new RegExp(`export const ${declaration} = pgTable`));
  }
  assert.match(schema, /uniqueIndex\("inbound_requests_occurrence_uidx"\)/);
  assert.match(schema, /uniqueIndex\("inbound_request_effects_key_uidx"\)/);
  assert.match(schema, /uniqueIndex\("inbound_request_work_links_request_type_uidx"\)/);
});

console.log(`\nCRO-05A static certification passed: ${checks} checks`);