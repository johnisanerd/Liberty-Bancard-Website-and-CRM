import crypto from "crypto";
import { injectCanSpamFooter } from "../can-spam-footer";

// ---------------------------------------------------------------------------
// Unavoidable pause authority guard
// ---------------------------------------------------------------------------
// Every outbound send function in this file MUST call assertPauseAllowed()
// before any sdrGhlFetch network I/O. This is the transport boundary —
// caller-level checks are defense-in-depth only; this gate is mandatory.
async function assertPauseAllowed(tag: string): Promise<{ tokenId: string; epoch: bigint }> {
  const { authorize, recheckEpoch } = await import("../outbound-pause-authority");
  const { registerInflight, deregisterInflight } = await import("../outbound-control-service");
  const decision = await authorize({});
  if (!decision.allowed) {
    throw new Error(`[SDR:${tag}] Outbound blocked by pause authority: ${decision.reasonCode}`);
  }
  // register BEFORE recheckEpoch so the pause drain sees the token
  const tokenId = crypto.randomUUID();
  await registerInflight(tokenId, decision.epoch);
  const epochOk = await recheckEpoch(decision.epoch);
  if (!epochOk) {
    deregisterInflight(tokenId);
    throw new Error(`[SDR:${tag}] Outbound blocked: epoch changed before send (pause activated)`);
  }
  return { tokenId, epoch: decision.epoch };
}

async function assertCommercialAllowed(
  dbContactId: number | undefined,
  purpose: "marketing_outreach" | "transactional_response" = "marketing_outreach",
  binding?: { inboundRequestId?: string; intendedRecipientContactId?: number },
): Promise<void> {
  // This transport has no server-owned category parameter comparable to SMTP,
  // so a missing internal contact identity cannot prove a transactional intent.
  // Fail closed rather than allowing a caller-controlled purpose to bypass the
  // commercial authorization boundary.
  if (!dbContactId) throw new Error("COMMERCIAL_CLASS_UNKNOWN");
  const hasInboundBinding = purpose === "transactional_response"
    && !!binding?.inboundRequestId?.trim()
    && binding.intendedRecipientContactId === dbContactId;
  const { authorizeCommercialUse } = await import("../commercial-resolution");
  const decision = await authorizeCommercialUse({
    subjectType: "contact",
    subjectId: dbContactId,
    effect: purpose === "marketing_outreach"
      ? "marketing_outreach"
      : hasInboundBinding ? "inbound_transactional_acknowledgement" : "account_transactional",
    inboundRequestId: hasInboundBinding ? binding?.inboundRequestId : undefined,
    intendedRecipientId: hasInboundBinding ? binding?.intendedRecipientContactId : undefined,
  });
  if (!decision.effectiveDecision.allowed) throw new Error(decision.effectiveDecision.reasonCode);
}

async function resolveLocalContactId(
  dbContactId: number | undefined,
  ghlContactId: string,
): Promise<number | undefined> {
  if (dbContactId) return dbContactId;
  const [{ db }, { contacts }, { eq }] = await Promise.all([
    import("../../db"),
    import("@shared/schema"),
    import("drizzle-orm"),
  ]);
  const [contact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.ghlContactId, ghlContactId))
    .limit(1);
  return contact?.id;
}

const DEFAULT_GHL_BASE_URL = "https://services.leadconnectorhq.com";
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60_000;

let requestTimestamps: number[] = [];

function getBaseUrl(): string {
  return process.env.GHL_BASE_URL || DEFAULT_GHL_BASE_URL;
}

function getAuthToken(): string | null {
  return process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY || null;
}

function getLocationId(): string | null {
  return process.env.GHL_LOCATION_ID || null;
}

function getWebhookSecret(): string | null {
  return process.env.GHL_WEBHOOK_SECRET || null;
}

export function isSdrGhlConfigured(): boolean {
  return !!(getAuthToken() && getLocationId());
}

async function rateLimit(): Promise<void> {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (requestTimestamps.length >= RATE_LIMIT_MAX) {
    const oldestInWindow = requestTimestamps[0];
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - oldestInWindow) + 100;
    console.log(`[SDR GHL] Rate limit reached, waiting ${waitMs}ms`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  requestTimestamps.push(Date.now());
}

export interface GhlApiResponse {
  [key: string]: unknown;
}

// Options type that carries the authorized pause epoch through retry loops.
type SdrGhlFetchOptions = RequestInit & { pauseEpoch?: bigint };

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function sdrGhlFetch(path: string, options: SdrGhlFetchOptions = {}, retries = 3): Promise<GhlApiResponse> {
  const method = (options.method || "GET").toUpperCase();
  // ── Canonical pause boundary (fetch-level enforcement) ────────────────────
  // Any mutation whose caller did NOT already run the pause protocol (signalled
  // by a supplied pauseEpoch) gets the full authorize → register(epoch) →
  // recheck → I/O → deregister protocol here. This closes bypasses through
  // callers that skip their own gate (AI toggles/DND fallback, conversation
  // create, bootstrap custom-field/tag POSTs, etc.).
  if (MUTATION_METHODS.has(method) && options.pauseEpoch === undefined) {
    const { deregisterInflight } = await import("../outbound-control-service");
    const { tokenId, epoch } = await assertPauseAllowed(`sdrGhlFetch:${method} ${path.split("?")[0]}`);
    try {
      return await sdrGhlFetch(path, { ...options, pauseEpoch: epoch }, retries);
    } finally {
      deregisterInflight(tokenId);
    }
  }

  const token = getAuthToken();
  if (!token) throw new Error("GHL not configured. Set GHL_PRIVATE_INTEGRATION_TOKEN or GHL_API_KEY.");

  // Extract pause epoch before building the fetch-compatible options
  const { pauseEpoch, ...fetchOptions } = options;

  await rateLimit();

  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Version": "2021-07-28",
    ...(fetchOptions.headers as Record<string, string> || {}),
  };

  let lastRateLimited = false;
  for (let attempt = 0; attempt < retries; attempt++) {
    // ── Per-attempt cross-process epoch recheck ────────────────────────────
    // Called at the TOP of every iteration (including after backoff waits) so
    // a pause committed in any process blocks subsequent retry attempts.
    if (pauseEpoch !== undefined) {
      const { recheckEpochFromDB } = await import("../../services/outbound-pause-authority");
      const epochOk = await recheckEpochFromDB(pauseEpoch);
      if (!epochOk) {
        throw new Error(
          `[SDR GHL] Outbound blocked: pause was activated after authorization ` +
          `(epoch ${pauseEpoch} no longer current). Aborting retry.`,
        );
      }
    }
    try {
      const response = await fetch(url, { ...fetchOptions, headers });

      lastRateLimited = response.status === 429;
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("retry-after") || "5", 10);
        const waitMs = retryAfter * 1000;
        console.warn(`[SDR GHL] 429 rate limited, retrying after ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(`GHL API error ${response.status}: ${errorBody}`);
      }

      const contentType = response.headers.get("content-type") || "";
      if (response.status === 204 || !contentType.includes("application/json")) {
        return {};
      }

      const text = await response.text();
      return text ? JSON.parse(text) : {};
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt === retries - 1) throw err;
      if (errMsg.includes("429")) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  // Retries exhausted while the provider kept answering 429: that is a refusal, never an empty success.
  if (lastRateLimited) throw new Error("GHL API error 429: rate limit retries exhausted");
  return {};
}

export interface UpsertContactParams {
  locationId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  tags?: string[];
  customField?: Record<string, string>;
  existingGhlId?: string;
}

export async function upsertContact(params: UpsertContactParams): Promise<string> {
  const locationId = params.locationId || getLocationId();
  if (!locationId) throw new Error("GHL_LOCATION_ID not set");

  const payload: Record<string, unknown> = {
    locationId,
    firstName: params.firstName,
    lastName: params.lastName,
    email: params.email,
    phone: params.phone,
    companyName: params.companyName,
    tags: params.tags || [],
  };

  if (params.customField && Object.keys(params.customField).length > 0) {
    payload.customFields = Object.entries(params.customField).map(([key, value]) => ({ key, field_value: value }));
  }

  const { deregisterInflight } = await import("../outbound-control-service");
  const { tokenId, epoch } = await assertPauseAllowed("upsertContact");
  try {
    if (params.existingGhlId) {
      await sdrGhlFetch(`/contacts/${params.existingGhlId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
        pauseEpoch: epoch,
      });
      return params.existingGhlId;
    }

    const result = await sdrGhlFetch("/contacts/", {
      method: "POST",
      body: JSON.stringify(payload),
      pauseEpoch: epoch,
    });

    const contactData = result.contact as Record<string, unknown> | undefined;
    return (contactData?.id as string) || (result.id as string) || "";
  } finally {
    deregisterInflight(tokenId);
  }
}

export async function updateCustomFields(ghlContactId: string, fields: Record<string, string>): Promise<void> {
  const { deregisterInflight } = await import("../outbound-control-service");
  const { tokenId, epoch } = await assertPauseAllowed("updateCustomFields");
  try {
    await sdrGhlFetch(`/contacts/${ghlContactId}`, {
      method: "PUT",
      body: JSON.stringify({
        customFields: Object.entries(fields).map(([key, value]) => ({ key, field_value: value })),
      }),
      pauseEpoch: epoch,
    });
  } finally {
    deregisterInflight(tokenId);
  }
}

export interface ConversationResult {
  id?: string;
  conversationId?: string;
}

export async function createConversation(params: {
  contactId: string;
  locationId?: string;
}): Promise<ConversationResult> {
  const locationId = params.locationId || getLocationId();
  const result = await sdrGhlFetch("/conversations/", {
    method: "POST",
    body: JSON.stringify({
      locationId,
      contactId: params.contactId,
    }),
  });
  return result as unknown as ConversationResult;
}

export interface OpportunityParams {
  pipelineId: string;
  stageId: string;
  contactId: string;
  name: string;
  status?: "open" | "won" | "lost" | "abandoned";
  monetaryValue?: number;
  existingOpportunityId?: string;
  locationId?: string;
}

export interface OpportunityResult {
  id?: string;
  [key: string]: unknown;
}

export async function manageOpportunity(params: OpportunityParams): Promise<OpportunityResult> {
  const locationId = params.locationId || getLocationId();

  const payload = {
    pipelineId: params.pipelineId,
    pipelineStageId: params.stageId,
    locationId,
    contactId: params.contactId,
    name: params.name,
    status: params.status || "open",
    monetaryValue: params.monetaryValue,
  };

  const { deregisterInflight } = await import("../outbound-control-service");
  const { tokenId, epoch } = await assertPauseAllowed("manageOpportunity");
  try {
    if (params.existingOpportunityId) {
      return await sdrGhlFetch(`/opportunities/${params.existingOpportunityId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
        pauseEpoch: epoch,
      }) as unknown as OpportunityResult;
    }

    return await sdrGhlFetch("/opportunities/", {
      method: "POST",
      body: JSON.stringify(payload),
      pauseEpoch: epoch,
    }) as unknown as OpportunityResult;
  } finally {
    deregisterInflight(tokenId);
  }
}

export interface WorkflowTriggerResult {
  success?: boolean;
  [key: string]: unknown;
}

export async function triggerWorkflow(params: {
  workflowId: string;
  contactId: string;
  metadata?: Record<string, unknown>;
}): Promise<WorkflowTriggerResult> {
  const { deregisterInflight } = await import("../outbound-control-service");
  const { tokenId, epoch } = await assertPauseAllowed("triggerWorkflow");
  try {
    return await sdrGhlFetch(`/contacts/${params.contactId}/workflow/${params.workflowId}`, {
      method: "POST",
      body: JSON.stringify(params.metadata || {}),
      pauseEpoch: epoch,
    }) as unknown as WorkflowTriggerResult;
  } finally {
    deregisterInflight(tokenId);
  }
}

export interface GhlCalendar {
  id: string;
  name: string;
  [key: string]: unknown;
}

export async function fetchCalendars(locationId?: string): Promise<GhlCalendar[]> {
  const locId = locationId || getLocationId();
  if (!locId) throw new Error("GHL_LOCATION_ID not set");
  const result = await sdrGhlFetch(`/calendars/?locationId=${locId}`);
  return (result.calendars as GhlCalendar[]) || [];
}

export interface NoteResult {
  id?: string;
  body?: string;
}

export async function addNote(params: {
  contactId: string;
  body: string;
}): Promise<NoteResult> {
  const { deregisterInflight } = await import("../outbound-control-service");
  const { tokenId, epoch } = await assertPauseAllowed("addNote");
  try {
    return await sdrGhlFetch(`/contacts/${params.contactId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: params.body }),
      pauseEpoch: epoch,
    }) as unknown as NoteResult;
  } finally {
    deregisterInflight(tokenId);
  }
}

export async function addTag(params: {
  contactId: string;
  tags: string[];
}): Promise<void> {
  const { deregisterInflight } = await import("../outbound-control-service");
  const { tokenId, epoch } = await assertPauseAllowed("addTag");
  try {
    await sdrGhlFetch(`/contacts/${params.contactId}/tags`, {
      method: "POST",
      body: JSON.stringify({ tags: params.tags }),
      pauseEpoch: epoch,
    });
  } finally {
    deregisterInflight(tokenId);
  }
}

export async function removeTag(params: {
  contactId: string;
  tags: string[];
}): Promise<void> {
  const { deregisterInflight } = await import("../outbound-control-service");
  const { tokenId, epoch } = await assertPauseAllowed("removeTag");
  try {
    await sdrGhlFetch(`/contacts/${params.contactId}/tags`, {
      method: "DELETE",
      body: JSON.stringify({ tags: params.tags }),
      pauseEpoch: epoch,
    });
  } finally {
    deregisterInflight(tokenId);
  }
}

/**
 * Webhook Signing — HighLevel Current and Legacy Standards
 * ─────────────────────────────────────────────────────────
 *
 * CURRENT STANDARD (primary):
 *   Header:  x-ghl-signature
 *   Method:  Ed25519 asymmetric signature over the raw UTF-8 request body
 *   Key:     GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY env var — Ed25519 public key in
 *            PEM format (-----BEGIN PUBLIC KEY-----…) obtained from the GHL
 *            Marketplace developer portal for your app.
 *   Verified with: crypto.verify(null, bodyBuf, publicKeyPem, sigBase64Buf)
 *   Source:  GHL Marketplace JS SDK README, verifyEd25519Signature()
 *
 * LEGACY FALLBACK (temporary, during GHL transition):
 *   Header:  x-ghl-signature  (HMAC hex, optionally sha256= prefixed)
 *         OR x-wh-signature   (older legacy header, same HMAC format)
 *   Method:  HMAC-SHA256 over the raw body
 *   Key:     GHL_WEBHOOK_SECRET env var (shared secret)
 *   Used when: GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY is not yet configured.
 *   Log:     "[SDR GHL] Using HMAC-SHA256 legacy fallback — set GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY"
 *
 * MISSING SIGNATURE:
 *   Production → always reject (401).
 *   Development → pass with warning (to allow local testing without keys).
 *
 * REPLAY PROTECTION (applies to both methods):
 *   5-minute window enforced via x-ghl-timestamp header or dateAdded/
 *   createdAt/timestamp fields in the JSON payload.
 *
 * IDEMPOTENCY:
 *   webhook_event_log table records processed events; GHL retries of an
 *   already-200'd delivery are rejected by the dedup middleware (upstream of
 *   business logic) without re-processing.
 */

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Resolve the Ed25519 public key PEM, normalising escaped newlines from env vars. */
function getEd25519PublicKey(): string | null {
  const raw = process.env.GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY;
  if (!raw) return null;
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

/** Extract a millisecond timestamp from a parsed GHL event payload. */
function extractPayloadTimestampMs(payload: string): number | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    for (const field of ["dateAdded", "createdAt", "timestamp", "date_added", "created_at"]) {
      const val = parsed[field];
      if (!val) continue;
      if (typeof val === "number" && val > 1_000_000_000_000) return val;
      if (typeof val === "number" && val > 1_000_000_000) return val * 1000;
      if (typeof val === "string") {
        const ms = Date.parse(val);
        if (!isNaN(ms)) return ms;
      }
    }
  } catch {
    // not JSON or no timestamp fields
  }
  return null;
}

/**
 * Ed25519 signature verification — current GHL standard.
 * signature is base64-encoded (NOT hex). publicKeyPem is the PEM public key.
 */
function checkEd25519Signature(rawBody: string, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    const bodyBuf = Buffer.from(rawBody, "utf8");
    const sigBuf  = Buffer.from(signatureBase64, "base64");
    // crypto.verify with null algorithm = Ed25519 (no hash, signs raw bytes directly).
    // Node.js 15+ required; this project uses Node.js 20.
    return crypto.verify(null, bodyBuf, publicKeyPem, sigBuf);
  } catch {
    return false;
  }
}

/**
 * HMAC-SHA256 signature verification — legacy GHL method (kept during transition).
 * Handles both plain hex and sha256=<hex> prefixed formats.
 */
function checkHmacSignature(payload: string, signature: string, secret: string): boolean {
  try {
    const expectedSig  = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const sigToCompare = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    if (sigToCompare.length !== expectedSig.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(sigToCompare, "hex"),
      Buffer.from(expectedSig, "hex"),
    );
  } catch {
    return false;
  }
}

/** Helper: extract a single-valued header from a headers map. */
function getHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const v = headers[name];
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Deprecated shim used by per-route handlers as defence-in-depth.
 * Delegates to validateWebhookRequest so that Ed25519 / HMAC priority is
 * identical to the middleware layer.
 */
export function validateWebhookSignature(payload: string, signature: string): boolean {
  const result = validateWebhookRequest(payload, { "x-ghl-signature": signature });
  return result.valid;
}

export type WebhookVerificationMethod =
  | "ed25519_current"       // x-ghl-signature verified with Ed25519 public key (current standard)
  | "hmac_sha256_legacy"    // x-ghl-signature or x-wh-signature verified with HMAC-SHA256 (legacy)
  | "no_secret_dev_only";   // no key/secret configured — dev-only passthrough

export type WebhookVerificationResult = {
  valid: boolean;
  method: WebhookVerificationMethod;
  replayRejected: boolean;
  timestampAgeMs: number | null;
  error?: string;
};

/**
 * Full webhook verification: Ed25519 (primary) or HMAC-SHA256 (legacy fallback),
 * plus replay protection.
 *
 * Call this at the middleware layer.  validateWebhookSignature() delegates here.
 *
 * Verification priority:
 *   1. x-ghl-signature + GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY → Ed25519 (current)
 *   2. x-ghl-signature + GHL_WEBHOOK_SECRET              → HMAC-SHA256 (legacy)
 *   3. x-wh-signature  + GHL_WEBHOOK_SECRET              → HMAC-SHA256 (oldest legacy)
 *   4. No signature at all                               → reject in prod, warn in dev
 *
 * @param rawBody  Raw request body string (preserve original bytes)
 * @param headers  Full request headers object from Express req.headers
 */
export function validateWebhookRequest(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
): WebhookVerificationResult {
  const sigGhl    = getHeader(headers, "x-ghl-signature") ?? "";
  const sigLegacy = getHeader(headers, "x-wh-signature")  ?? "";
  const ed25519Key = getEd25519PublicKey();
  const hmacSecret = getWebhookSecret();
  const isProd     = process.env.NODE_ENV === "production";

  // ── No signature at all ──────────────────────────────────────────────────
  if (!sigGhl && !sigLegacy) {
    if (isProd || hmacSecret || ed25519Key) {
      console.warn("[SDR GHL] Webhook rejected — no x-ghl-signature or x-wh-signature header present");
      return { valid: false, method: "no_secret_dev_only", replayRejected: false, timestampAgeMs: null, error: "Missing webhook signature" };
    }
    // Dev: no keys configured, no signature — allow for local testing
    return { valid: true, method: "no_secret_dev_only", replayRejected: false, timestampAgeMs: null };
  }

  // ── Method 1: Ed25519 (current standard) ─────────────────────────────────
  if (sigGhl && ed25519Key) {
    if (!checkEd25519Signature(rawBody, sigGhl, ed25519Key)) {
      return { valid: false, method: "ed25519_current", replayRejected: false, timestampAgeMs: null, error: "Ed25519 signature mismatch" };
    }
    return applyReplayCheck(rawBody, headers, "ed25519_current");
  }

  // ── Method 2: HMAC-SHA256 on x-ghl-signature (legacy — transition) ───────
  if (sigGhl && hmacSecret) {
    console.warn("[SDR GHL] Using HMAC-SHA256 legacy fallback on x-ghl-signature — set GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY to use Ed25519 (current standard)");
    if (!checkHmacSignature(rawBody, sigGhl, hmacSecret)) {
      return { valid: false, method: "hmac_sha256_legacy", replayRejected: false, timestampAgeMs: null, error: "HMAC-SHA256 signature mismatch (x-ghl-signature)" };
    }
    return applyReplayCheck(rawBody, headers, "hmac_sha256_legacy");
  }

  // ── Method 3: HMAC-SHA256 on x-wh-signature (oldest legacy header) ───────
  if (sigLegacy && hmacSecret) {
    console.warn("[SDR GHL] Using HMAC-SHA256 legacy fallback on x-wh-signature — migrate to x-ghl-signature Ed25519");
    if (!checkHmacSignature(rawBody, sigLegacy, hmacSecret)) {
      return { valid: false, method: "hmac_sha256_legacy", replayRejected: false, timestampAgeMs: null, error: "HMAC-SHA256 signature mismatch (x-wh-signature)" };
    }
    return applyReplayCheck(rawBody, headers, "hmac_sha256_legacy");
  }

  // ── Signature present but no key/secret configured ───────────────────────
  if (isProd) {
    return { valid: false, method: "no_secret_dev_only", replayRejected: false, timestampAgeMs: null, error: "Signature header present but no verification key configured in production" };
  }
  // Dev fallback: signature present but keys not yet set — allow with warning
  console.warn("[SDR GHL] Webhook signature present but no GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY or GHL_WEBHOOK_SECRET — allowing in non-production");
  return { valid: true, method: "no_secret_dev_only", replayRejected: false, timestampAgeMs: null };
}

/** Apply replay-window check after signature has already been verified. */
function applyReplayCheck(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  method: WebhookVerificationMethod,
): WebhookVerificationResult {
  let eventTimestampMs: number | null = null;

  // Priority 1: x-ghl-timestamp header
  const headerTs = getHeader(headers, "x-ghl-timestamp");
  if (headerTs) {
    const n = Number(headerTs);
    if (!isNaN(n)) eventTimestampMs = n > 1_000_000_000_000 ? n : n * 1000;
  }
  // Priority 2: timestamp field in JSON payload
  if (eventTimestampMs === null) {
    eventTimestampMs = extractPayloadTimestampMs(rawBody);
  }

  if (eventTimestampMs !== null) {
    const ageMs = Date.now() - eventTimestampMs;
    if (ageMs > REPLAY_WINDOW_MS) {
      console.warn(`[SDR GHL] Webhook replay rejected — event timestamp is ${Math.round(ageMs / 1000)}s old (limit: ${REPLAY_WINDOW_MS / 1000}s)`);
      return { valid: false, method, replayRejected: true, timestampAgeMs: ageMs, error: `Event timestamp is ${Math.round(ageMs / 1000)}s old — replay window is ${REPLAY_WINDOW_MS / 1000}s` };
    }
    return { valid: true, method, replayRejected: false, timestampAgeMs: ageMs };
  }
  // No timestamp — signature passed, allow (dedup covers GHL retries)
  return { valid: true, method, replayRejected: false, timestampAgeMs: null };
}

export interface SendMessageResult {
  messageId?: string;
  [key: string]: unknown;
}

export async function sendChatReply(params: {
  contactId: string;
  dbContactId?: number;
  commercialPurpose?: "marketing_outreach" | "transactional_response";
  inboundRequestId?: string;
  intendedRecipientContactId?: number;
  message: string;
  conversationId?: string;
}): Promise<SendMessageResult> {
  const dbContactId = await resolveLocalContactId(params.dbContactId, params.contactId);
  await assertCommercialAllowed(dbContactId, params.commercialPurpose, params);
  const { deregisterInflight } = await import("../outbound-control-service");
  const { tokenId, epoch } = await assertPauseAllowed("sendChatReply");
  try {
    const payload: Record<string, unknown> = {
      type: "Custom",
      contactId: params.contactId,
      message: params.message,
    };
    if (params.conversationId) {
      payload.conversationId = params.conversationId;
    }
    return await sdrGhlFetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify(payload),
      pauseEpoch: epoch,
    }) as unknown as SendMessageResult;
  } finally {
    deregisterInflight(tokenId);
  }
}

export async function sendSmsReply(params: {
  contactId: string;
  message: string;
  dbContactId?: number;
  commercialPurpose?: "marketing_outreach" | "transactional_response";
  inboundRequestId?: string;
  intendedRecipientContactId?: number;
}): Promise<SendMessageResult> {
  const dbContactId = await resolveLocalContactId(params.dbContactId, params.contactId);
  await assertCommercialAllowed(dbContactId, params.commercialPurpose, params);
  const { deregisterInflight } = await import("../outbound-control-service");
  const { tokenId, epoch } = await assertPauseAllowed("sendSmsReply");
  try {
    return await sdrGhlFetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify({
        type: "SMS",
        contactId: params.contactId,
        message: params.message,
      }),
      pauseEpoch: epoch,
    }) as unknown as SendMessageResult;
  } finally {
    deregisterInflight(tokenId);
  }
}

export async function sendEmailReply(params: {
  contactId: string;
  subject: string;
  htmlBody: string;
  /** From email address (e.g. "onboarding@libertybancard.com"). */
  fromEmail?: string;
  /** From display name (combined with fromEmail as "Name <email>" when both present). */
  fromName?: string;
  /**
   * DB (integer) contact ID used to generate a signed CAN-SPAM unsubscribe token.
   * When provided, the injected footer includes a functional /unsubscribe?t=… link.
   * When absent, a reply-to-unsubscribe instruction is used instead.
   */
  dbContactId?: number;
  commercialPurpose?: "marketing_outreach" | "transactional_response";
  inboundRequestId?: string;
  intendedRecipientContactId?: number;
}): Promise<SendMessageResult> {
  const dbContactId = await resolveLocalContactId(params.dbContactId, params.contactId);
  await assertCommercialAllowed(dbContactId, params.commercialPurpose, params);
  const { deregisterInflight } = await import("../outbound-control-service");
  const { tokenId, epoch } = await assertPauseAllowed("sendEmailReply");
  try {
    const payload: Record<string, unknown> = {
      type: "Email",
      contactId: params.contactId,
      subject: params.subject,
      html: await injectCanSpamFooter(params.htmlBody, dbContactId),
    };
    if (params.fromEmail) {
      payload.emailFrom = params.fromName
        ? `${params.fromName} <${params.fromEmail}>`
        : params.fromEmail;
      payload.emailReplyMode = "custom";
    }
    return await sdrGhlFetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify(payload),
      pauseEpoch: epoch,
    }) as unknown as SendMessageResult;
  } finally {
    deregisterInflight(tokenId);
  }
}

export async function disableConversationAi(contactId: string): Promise<void> {
  try {
    await sdrGhlFetch(`/conversations/ai/toggle`, {
      method: "PUT",
      body: JSON.stringify({ contactId, enabled: false }),
    });
  } catch {
    await sdrGhlFetch(`/contacts/${contactId}`, {
      method: "PUT",
      body: JSON.stringify({
        dnd: true,
        dndSettings: { all: { status: "active", message: "Handed off to human agent" } },
      }),
    });
  }
}

export async function enableConversationAi(contactId: string): Promise<void> {
  try {
    await sdrGhlFetch(`/conversations/ai/toggle`, {
      method: "PUT",
      body: JSON.stringify({ contactId, enabled: true }),
    });
  } catch {
    await sdrGhlFetch(`/contacts/${contactId}`, {
      method: "PUT",
      body: JSON.stringify({
        dnd: false,
      }),
    });
  }
}

export interface SdrGhlConfigStatus {
  configured: boolean;
  hasToken: boolean;
  hasLocationId: boolean;
  hasWebhookSecret: boolean;
  baseUrl: string;
}

export function getSdrGhlConfig(): SdrGhlConfigStatus {
  return {
    configured: isSdrGhlConfigured(),
    hasToken: !!getAuthToken(),
    hasLocationId: !!getLocationId(),
    hasWebhookSecret: !!getWebhookSecret(),
    baseUrl: getBaseUrl(),
  };
}

export const REQUIRED_CUSTOM_FIELDS = [
  { key: "lb_merchant_id", name: "LB Merchant ID", dataType: "TEXT" },
  { key: "lb_current_stage", name: "LB Current Stage", dataType: "TEXT" },
  { key: "lb_fit_score", name: "LB Fit Score", dataType: "NUMERICAL" },
  { key: "lb_revenue_score", name: "LB Revenue Score", dataType: "NUMERICAL" },
  { key: "lb_reachability_score", name: "LB Reachability Score", dataType: "NUMERICAL" },
  { key: "lb_priority_score", name: "LB Priority Score", dataType: "NUMERICAL" },
  { key: "lb_vertical", name: "LB Vertical", dataType: "TEXT" },
  { key: "lb_best_channel", name: "LB Best Channel", dataType: "TEXT" },
  { key: "lb_statement_status", name: "LB Statement Status", dataType: "TEXT" },
  { key: "lb_proposal_status", name: "LB Proposal Status", dataType: "TEXT" },
  { key: "lb_last_ai_outcome", name: "LB Last AI Outcome", dataType: "TEXT" },
  { key: "lb_owner_type", name: "LB Owner Type", dataType: "TEXT" },
  { key: "lb_do_not_sdr", name: "LB Do Not SDR", dataType: "TEXT" },
  { key: "lb_monthly_volume", name: "LB Monthly Volume", dataType: "TEXT" },
  { key: "lb_current_processor", name: "LB Current Processor", dataType: "TEXT" },
  { key: "lb_pain_points", name: "LB Pain Points", dataType: "TEXT" },
  { key: "lb_terminal_need", name: "LB Terminal Need", dataType: "TEXT" },
  { key: "lb_preferred_program", name: "LB Preferred Program", dataType: "TEXT" },
  { key: "lb_interested_0_percent", name: "LB Interested 0%", dataType: "TEXT" },
  { key: "lb_avg_ticket", name: "LB Avg Ticket", dataType: "TEXT" },
  { key: "lb_utm_source", name: "LB UTM Source", dataType: "TEXT" },
  { key: "lb_utm_medium", name: "LB UTM Medium", dataType: "TEXT" },
  { key: "lb_utm_campaign", name: "LB UTM Campaign", dataType: "TEXT" },
  { key: "lb_promo_code", name: "LB Promo Code", dataType: "TEXT" },
  { key: "lb_lead_source", name: "LB Lead Source", dataType: "TEXT" },
  { key: "lb_consent_sms", name: "LB Consent SMS", dataType: "TEXT" },
  { key: "lb_consent_email", name: "LB Consent Email", dataType: "TEXT" },
  { key: "lb_business_type", name: "LB Business Type", dataType: "TEXT" },
  { key: "lb_recommended_program", name: "LB Recommended Program", dataType: "TEXT" },
  { key: "lb_referral_code", name: "LB Referral Code", dataType: "TEXT" },
  { key: "lb_landing_page", name: "LB Landing Page", dataType: "TEXT" },
  { key: "lb_deal_stage", name: "LB Deal Stage", dataType: "TEXT" },
  { key: "lb_deal_pipeline", name: "LB Deal Pipeline", dataType: "TEXT" },
  { key: "lb_ein_last4", name: "LB EIN Last 4", dataType: "TEXT" },
  { key: "lb_current_rate", name: "LB Current Rate", dataType: "TEXT" },
  { key: "lb_terminal_type", name: "LB Terminal Type", dataType: "TEXT" },
  { key: "lb_ecommerce_needed", name: "LB E-Commerce Needed", dataType: "TEXT" },
  { key: "lb_affiliate_code", name: "LB Affiliate Code", dataType: "TEXT" },
  { key: "lb_estimated_savings", name: "LB Estimated Savings", dataType: "TEXT" },
  { key: "lb_vertical_benchmark", name: "LB Vertical Benchmark", dataType: "TEXT" },
  { key: "lb_opportunity_score", name: "LB Opportunity Score", dataType: "NUMERICAL" },
] as const;

export const REQUIRED_TAGS = [
  "LB-AI-SDR", "LB-AUTO", "LB-MEDSPA", "LB-DENTAL", "LB-BOOKING-READY",
  "LB-STATEMENT-PENDING", "LB-PROPOSAL-SENT", "LB-HUMAN-HANDOFF", "LB-DO-NOT-AUTO",
  "LB-CHAT-LEAD", "LB-CHAT-HANDOFF", "LB-ACTIVE-PIPELINE",
  "LB-AFFILIATE", "LB-SUPPORT", "LB-SUPPORT-REQUEST", "LB-STATEMENT-RECEIVED", "LB-EQUIPMENT-ORDER",
  "LB-QUIZ-LEAD", "LB-ESTIMATE", "LB-CALLBACK", "LB-MERCHANT-APP",
] as const;

let bootstrapCompleted = false;

export async function ensureGhlBootstrapped(): Promise<void> {
  if (bootstrapCompleted || !isSdrGhlConfigured()) return;
  try {
    console.log("[SDR GHL] First sync detected — bootstrapping custom fields and tags...");
    const result = await bootstrapGhlCustomFieldsAndTags();
    if (result.errors.length === 0) {
      bootstrapCompleted = true;
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[SDR GHL] Bootstrap failed:", errMsg);
  }
}

export async function bootstrapGhlCustomFieldsAndTags(): Promise<{
  fieldsCreated: string[];
  fieldsExisting: string[];
  tagsCreated: string[];
  errors: string[];
}> {
  if (!isSdrGhlConfigured()) {
    return { fieldsCreated: [], fieldsExisting: [], tagsCreated: [], errors: ["GHL not configured"] };
  }

  const locationId = getLocationId()!;
  const fieldsCreated: string[] = [];
  const fieldsExisting: string[] = [];
  const tagsCreated: string[] = [];
  const errors: string[] = [];

  let existingFields: GhlApiResponse[] = [];
  try {
    const result = await sdrGhlFetch(`/locations/${locationId}/customFields`);
    existingFields = (result.customFields as GhlApiResponse[]) || [];
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    errors.push(`Failed to fetch existing custom fields: ${errMsg}`);
  }

  const existingFieldKeys = new Set(existingFields.map(f => f.fieldKey as string));

  for (const field of REQUIRED_CUSTOM_FIELDS) {
    if (existingFieldKeys.has(field.key)) {
      fieldsExisting.push(field.key);
      continue;
    }
    try {
      await sdrGhlFetch(`/locations/${locationId}/customFields`, {
        method: "POST",
        body: JSON.stringify({
          name: field.name,
          fieldKey: field.key,
          dataType: field.dataType,
          model: "contact",
        }),
      });
      fieldsCreated.push(field.key);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to create field ${field.key}: ${errMsg}`);
    }
  }

  for (const tag of REQUIRED_TAGS) {
    try {
      await sdrGhlFetch(`/locations/${locationId}/tags`, {
        method: "POST",
        body: JSON.stringify({ name: tag }),
      });
      tagsCreated.push(tag);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("already exists") || errMsg.includes("duplicate")) {
        continue;
      }
      errors.push(`Failed to create tag ${tag}: ${errMsg}`);
    }
  }

  console.log(`[SDR GHL Bootstrap] Fields created: ${fieldsCreated.length}, existing: ${fieldsExisting.length}, tags: ${tagsCreated.length}, errors: ${errors.length}`);
  return { fieldsCreated, fieldsExisting, tagsCreated, errors };
}

const RESPONSE_TEMPLATES: Record<string, string> = {
  booking_cta: "Great to hear you're interested! Here's a link to book a quick call with our team: {{booking_link}}",
  value_message_with_link: "Thanks for your interest! I'll send over some details about how we help businesses like yours save on processing. In the meantime, here's a link to chat: {{booking_link}}",
  pricing_review_explanation: "Great question! Our pricing is based on a free statement analysis — we compare your current rates and show you exactly where we can save you money. No obligation. Want me to set up a quick call? {{booking_link}}",
  booking_link_or_call: "I'd love to connect! Here's a link to pick a time that works: {{booking_link}} — or I can have one of our reps call you shortly.",
  snooze_acknowledgment: "No problem at all! I'll follow up in about a month. Feel free to reach out anytime if things change.",
  thank_you_suppress: "Understood — thanks for letting me know. We won't reach out again. If you ever need anything, don't hesitate to contact us.",
  wrong_person_apology: "Sorry about that! If you could point me to the right person, I'd appreciate it. Otherwise, we won't bother you again.",
  booking_confirmation: "Awesome — looking forward to our call! You'll get a reminder before the meeting. If anything changes, just let me know.",
  statement_received_acknowledgment: "Got it — thanks for sending that over! Our team will review it and get back to you with a savings analysis shortly.",
};

export async function sendTemplateResponse(
  merchantId: number,
  templateKey: string,
  channel: string
): Promise<void> {
  const { db } = await import("../../db");
  const { sdrMerchants, sdrLeadEvents, contacts } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");

  const template = RESPONSE_TEMPLATES[templateKey];
  if (!template) {
    console.warn(`[GHL Client] Unknown response template: ${templateKey}`);
    return;
  }

  const [merchant] = await db.select().from(sdrMerchants).where(eq(sdrMerchants.id, merchantId));
  if (!merchant?.ghlContactId) {
    console.warn(`[GHL Client] Cannot send template — no GHL contact for merchant ${merchantId}`);
    return;
  }
  const [localContact] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.ghlContactId, merchant.ghlContactId))
    .limit(1);
  if (!localContact) {
    console.warn(`[GHL Client] Template "${templateKey}" blocked — no classified local contact for merchant ${merchantId}`);
    return;
  }
  try {
    await assertCommercialAllowed(localContact.id, "marketing_outreach");
  } catch (commercialErr: unknown) {
    console.warn(`[GHL Client] Template "${templateKey}" blocked by commercial classification for merchant ${merchantId}: ${String(commercialErr)}`);
    return;
  }

  const complianceChannel = (channel === "email" ? "email" : "sms") as "sms" | "email";
  try {
    const { checkAndLogCompliance } = await import("./compliance-engine");
    const complianceResult = await checkAndLogCompliance(merchantId, complianceChannel);
    if (!complianceResult.allowed) {
      console.warn(`[GHL Client] Template "${templateKey}" blocked for merchant ${merchantId}: ${complianceResult.reason}`);
      await db.insert(sdrLeadEvents).values({
        merchantId,
        eventType: "template_response_blocked",
        channel,
        actorType: "system",
        payloadJson: { templateKey, reason: complianceResult.reason },
        decisionReason: `Template blocked: ${complianceResult.reason}`,
      });
      return;
    }
  } catch (compErr: unknown) {
    console.error(`[GHL Client] Compliance check failed for template send, failing closed:`, compErr);
    return;
  }

  if (!isSdrGhlConfigured()) {
    console.warn(`[GHL Client] GHL not configured — logging template send for merchant ${merchantId}`);
    await db.insert(sdrLeadEvents).values({
      merchantId,
      eventType: "template_response_queued",
      channel,
      actorType: "system",
      payloadJson: { templateKey, template, ghlNotConfigured: true },
      decisionReason: `Template "${templateKey}" queued (GHL not configured)`,
    });
    return;
  }

  try {
    const workflowId = process.env[`GHL_WORKFLOW_TEMPLATE_${templateKey.toUpperCase()}`] || process.env.GHL_WORKFLOW_TEMPLATE_RESPONSE;
    // triggerWorkflow already carries the pause gate; for the direct-message
    // fallback path, assertPauseAllowed() is required before the network call.
    if (workflowId) {
      await triggerWorkflow({
        workflowId,
        contactId: merchant.ghlContactId,
        metadata: { templateKey, message: template, channel },
      });
    } else {
      const { deregisterInflight } = await import("../outbound-control-service");
      const { tokenId: pauseTokenId, epoch: pauseEpoch } = await assertPauseAllowed("sendTemplateResponse");
      try {
        await sdrGhlFetch(`/conversations/messages`, {
          method: "POST",
          body: JSON.stringify({
            type: channel === "email" ? "Email" : "SMS",
            contactId: merchant.ghlContactId,
            message: template.replace("{{booking_link}}", process.env.GHL_DEFAULT_BOOKING_LINK || process.env.SALES_CALENDAR_URL || "https://calendly.com/libertybancard"),
          }),
          pauseEpoch,
        });
      } finally {
        deregisterInflight(pauseTokenId);
      }
    }

    await db.insert(sdrLeadEvents).values({
      merchantId,
      eventType: "template_response_sent",
      channel,
      actorType: "system",
      payloadJson: { templateKey, channel },
      decisionReason: `Template "${templateKey}" sent via ${channel}`,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[GHL Client] Failed to send template response: ${errMsg}`);
    await db.insert(sdrLeadEvents).values({
      merchantId,
      eventType: "template_response_failed",
      channel,
      actorType: "system",
      payloadJson: { templateKey, error: errMsg },
      decisionReason: `Template "${templateKey}" send failed: ${errMsg}`,
    });
  }
}
