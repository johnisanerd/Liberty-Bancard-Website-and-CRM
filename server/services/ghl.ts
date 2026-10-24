import crypto from "crypto";
import { storage } from "../storage";
import type { Contact, Deal } from "@shared/schema";
import OpenAI from "openai";
import { checkAiGate, recordAiSpend } from "./ai-audit-logger";
import { renderEmailHtmlForPurpose } from "./can-spam-footer";
import { isValidEmail } from "./contact-readiness";
import { applyConsentCommand } from "./consent-authority";
import { denyCro03OrCro08aForbiddenEffect as denyCro03cForbiddenEffect } from "./cro03/cro08a-effect-fence";
import { canExecute } from "./outbound-queue-coordinator";
import { classifyGhlOperation, isKnownPermissionCustomFieldKey } from "./ghl-capability-policy";
import type { GhlCrmDecision, NativeWorkflowEvidence } from "./ghl-sync-control";

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
}

const GHL_API_BASE = "https://services.leadconnectorhq.com";

interface GhlConfig {
  apiKey: string;
  locationId: string;
  calendarId?: string;
}

function getConfig(): GhlConfig | null {
  const apiKey = process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!apiKey || !locationId) return null;
  return {
    apiKey,
    locationId,
    calendarId: process.env.GHL_CALENDAR_ID || undefined,
  };
}

// Per-request timeout for all GHL API calls. Without this, a hung TCP
// connection from a stale keep-alive socket can block a BullMQ worker
// indefinitely — exhausting the lock duration and causing "could not renew lock".
const GHL_REQUEST_TIMEOUT_MS = parseInt(process.env.GHL_REQUEST_TIMEOUT_MS ?? "20000", 10);

// Options type that carries the authorized pause epoch through retry loops.
// Strip `pauseEpoch` before passing to the native fetch() call.
type GhlFetchOptions = RequestInit & {
  pauseEpoch?: bigint;
  ghlCrmPauseEpoch?: bigint;
  ghlCrmDecision?: GhlCrmDecision;
};

const GHL_MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Read-only inventory adapter used by the explicit native-trigger safety review.
 * It refuses APIs that do not return complete workflow identity/status/version
 * evidence; a workflow list is never treated as proof of action safety.
 */
export async function getGhlNativeWorkflowInventory(locationId?: string | null): Promise<NativeWorkflowEvidence[]> {
  const config = getConfig();
  const location = locationId || config?.locationId;
  if (!config || !location || location !== config.locationId) {
    throw new Error("GHL_NATIVE_INVENTORY_LOCATION_UNAVAILABLE");
  }
  const query = new URLSearchParams({ locationId: location });
  const response = await fetch(`${GHL_API_BASE}/workflows/?${query.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    signal: AbortSignal.timeout(GHL_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GHL_NATIVE_INVENTORY_HTTP_${response.status}`);
  const payload: any = await response.json();
  const rows = Array.isArray(payload?.workflows) ? payload.workflows
    : Array.isArray(payload?.data?.workflows) ? payload.data.workflows
    : Array.isArray(payload?.data) ? payload.data
    : null;
  if (!rows) throw new Error("GHL_NATIVE_INVENTORY_RESPONSE_UNSUPPORTED");
  return rows.map((workflow: any) => {
    const id = typeof workflow?.id === "string" ? workflow.id : "";
    const providerLocationId = typeof workflow?.locationId === "string" ? workflow.locationId : "";
    const status = typeof workflow?.status === "string" ? workflow.status : "";
    const updatedAt = typeof workflow?.updatedAt === "string" ? workflow.updatedAt
      : typeof workflow?.updated_at === "string" ? workflow.updated_at : "";
    const normalizedStatus = status.toLowerCase();
    const knownStatuses = new Set(["active", "published", "draft", "inactive", "unpublished", "paused", "disabled", "deleted"]);
    const version = typeof workflow?.version === "string" || typeof workflow?.version === "number"
      ? String(workflow.version) : "";
    if (!id || providerLocationId !== location || !knownStatuses.has(normalizedStatus)
        || !updatedAt || !Number.isFinite(Date.parse(updatedAt)) || !version) {
      throw new Error("GHL_NATIVE_INVENTORY_EVIDENCE_INCOMPLETE");
    }
    return { locationId: providerLocationId, id, status: normalizedStatus, updatedAt, version };
  });
}

export interface GhlProviderCustomField {
  id: string;
  key: string;
}

/** Read-only custom-field identity map. Unknown response shapes are unsupported. */
export async function getGhlCustomFieldInventory(locationId?: string | null): Promise<GhlProviderCustomField[]> {
  const config = getConfig();
  const location = locationId || config?.locationId;
  if (!config || !location || location !== config.locationId) throw new Error("GHL_CUSTOM_FIELD_LOCATION_UNAVAILABLE");
  const response = await fetch(`${GHL_API_BASE}/locations/${encodeURIComponent(location)}/customFields`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    signal: AbortSignal.timeout(GHL_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GHL_CUSTOM_FIELD_INVENTORY_HTTP_${response.status}`);
  const payload: any = await response.json();
  const rows = Array.isArray(payload?.customFields) ? payload.customFields
    : Array.isArray(payload?.data?.customFields) ? payload.data.customFields
    : null;
  if (!rows) throw new Error("GHL_CUSTOM_FIELD_INVENTORY_RESPONSE_UNSUPPORTED");
  const fields: GhlProviderCustomField[] = rows.map((field: any) => {
    const key = typeof field?.fieldKey === "string" ? field.fieldKey
      : typeof field?.key === "string" ? field.key : "";
    return {
      id: typeof field?.id === "string" ? field.id : "",
      // Provider semantic keys are contact-namespaced, unlike display titles.
      // Non-contact namespaces remain intact and cannot masquerade as consent.
      key: key.startsWith("contact.") ? key.slice("contact.".length) : key,
    };
  });
  if (fields.some(field => !field.id || !field.key)
      || new Set(fields.map(field => field.id)).size !== fields.length
      || new Set(fields.map(field => field.key)).size !== fields.length) {
    throw new Error("GHL_CUSTOM_FIELD_INVENTORY_EVIDENCE_INCOMPLETE");
  }
  return fields;
}

async function ghlFetch(path: string, options: GhlFetchOptions = {}, retries = 3): Promise<any> {
  const config = getConfig();
  if (!config) throw new Error("GHL not configured. Set GHL_API_KEY and GHL_LOCATION_ID.");

  // ── Canonical pause boundary (fetch-level enforcement) ────────────────────
  // Any mutation whose caller did not already run the pause protocol
  // (signalled by a supplied pauseEpoch) gets the full authorize →
  // register(epoch) → recheck → I/O → deregister protocol here. Reads are
  // never gated.
  const method = (options.method || "GET").toUpperCase();
  let bodyValue = typeof options.body === "string"
    ? (() => { try { return JSON.parse(options.body as string); } catch { return undefined; } })()
    : undefined;
  if (bodyValue && typeof bodyValue === "object" && !Array.isArray(bodyValue)
      && Array.isArray((bodyValue as any).customFields)) {
    const { getGhlCustomFieldInventory } = await import("./ghl");
    const fields = await getGhlCustomFieldInventory(config.locationId);
    const byKey = new Map(fields.map(field => [field.key, field.id]));
    bodyValue = {
      ...(bodyValue as Record<string, unknown>),
      customFields: (bodyValue as any).customFields.map((field: any) => {
        if (!field || typeof field !== "object") throw new Error("GHL_CUSTOM_FIELD_PAYLOAD_INVALID");
        const id = typeof field.id === "string" ? field.id : byKey.get(String(field.key ?? ""));
        const verified = fields.find(candidate => candidate.id === id);
        if (!verified || (field.key !== undefined && field.key !== verified.key)) {
          throw new Error("GHL_CUSTOM_FIELD_ID_UNVERIFIED");
        }
        return { ...field, id, key: verified.key };
      }),
    };
    options = { ...options, body: JSON.stringify(bodyValue) };
  }
  const capability = classifyGhlOperation(method, path, bodyValue);
  // Unknown operations do not become safe merely because they use GET.
  const outboundMutation = capability === "unknown" || capability === "communication";
  let crmDecision = options.ghlCrmDecision;
  if (GHL_MUTATION_METHODS.has(method) &&
      (capability === "crm_write" || capability === "permission_write")) {
    if (!crmDecision) {
      const { authorizeGhlCrmOperation } = await import("./ghl-sync-control");
      crmDecision = await authorizeGhlCrmOperation({
        method, path, body: bodyValue, locationId: config.locationId,
      });
    }
    if (!crmDecision.allowed) {
      throw new Error(`GHL CRM operation blocked: ${crmDecision.reasonCode} (${method} ${path.split("?")[0]})`);
    }
  }
  if ((capability === "crm_write" || capability === "permission_write")
      && options.ghlCrmPauseEpoch === undefined) {
    const {
      captureGhlCrmPauseEpoch, registerGhlCrmInflight, recheckGhlCrmPauseEpoch,
      recheckGhlCrmOperation, deregisterGhlCrmInflight,
    } = await import("./ghl-sync-control");
    const globalEpoch = await captureGhlCrmPauseEpoch();
    const token = await registerGhlCrmInflight(crmDecision!.epoch);
    try {
      if (!await recheckGhlCrmOperation(crmDecision!)
          || !await recheckGhlCrmPauseEpoch(globalEpoch)) {
        throw new Error("GHL_CRM_CONTROL_OR_PAUSE_EPOCH_CHANGED");
      }
      return await ghlFetch(path, {
        ...options, ghlCrmPauseEpoch: globalEpoch, ghlCrmDecision: crmDecision,
      }, retries);
    } finally {
      deregisterGhlCrmInflight(token);
    }
  }
  if (outboundMutation && options.pauseEpoch === undefined) {
    const { authorize, recheckEpoch } = await import("./outbound-pause-authority");
    const { registerInflight, deregisterInflight } = await import("./outbound-control-service");
    const decision = await authorize({});
    if (!decision.allowed) {
      throw new Error(`GHL mutation blocked by pause authority: ${decision.reasonCode} (${method} ${path.split("?")[0]})`);
    }
    const tokenId = crypto.randomUUID();
    await registerInflight(tokenId, decision.epoch);
    try {
      const epochOk = await recheckEpoch(decision.epoch);
      if (!epochOk) {
        throw new Error(`GHL mutation blocked by pause authority: epoch_changed (${method} ${path.split("?")[0]})`);
      }
      return await ghlFetch(path, { ...options, pauseEpoch: decision.epoch }, retries);
    } finally {
      deregisterInflight(tokenId);
    }
  }

  // Extract pause epoch before building the fetch-compatible options
  const { pauseEpoch, ghlCrmPauseEpoch, ghlCrmDecision: _ghlCrmDecision, ...rawFetchOptions } = options;
  const fetchOptions: RequestInit = bodyValue && typeof bodyValue === "object"
      && Array.isArray((bodyValue as any).customFields)
    ? {
      ...rawFetchOptions,
      body: JSON.stringify({
        ...(bodyValue as Record<string, unknown>),
        customFields: (bodyValue as any).customFields.map(({ key: _key, ...field }: any) => field),
      }),
    }
    : rawFetchOptions;

  const url = `${GHL_API_BASE}${path}`;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    "Version": "2021-07-28",
    ...(fetchOptions.headers as Record<string, string> || {}),
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    // ── Per-attempt cross-process epoch recheck ────────────────────────────
    // Called at the TOP of every iteration (including after backoff waits) so
    // a pause committed in any process blocks subsequent retry attempts even
    // when the initial authorize() + recheckEpoch() already passed.
    if (pauseEpoch !== undefined) {
      const { recheckEpochFromDB } = await import("./outbound-pause-authority");
      const epochOk = await recheckEpochFromDB(pauseEpoch);
      if (!epochOk) {
        throw new Error(
          `[GHL] Outbound blocked: pause was activated after authorization ` +
          `(epoch ${pauseEpoch} no longer current). Aborting retry.`,
        );
      }
    }
    if (crmDecision) {
      const { recheckGhlCrmOperation, recheckGhlCrmPauseEpoch } = await import("./ghl-sync-control");
      if (!await recheckGhlCrmOperation(crmDecision)
          || ghlCrmPauseEpoch === undefined
          || !await recheckGhlCrmPauseEpoch(ghlCrmPauseEpoch)) {
        throw new Error(`GHL CRM operation blocked: control_or_native_review_changed (${method} ${path.split("?")[0]})`);
      }
    }
    // Fresh AbortController per attempt so a previous timeout signal doesn't
    // leak into the next retry.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GHL_REQUEST_TIMEOUT_MS);
    try {
      if (outboundMutation) {
        const coordinatorAllowed = await canExecute("ghl-sync");
        if (!coordinatorAllowed) {
          throw new Error(
            `[GHL] Outbound blocked by queue coordinator (${method} ${path.split("?")[0]})`,
          );
        }
      }
      const response = await fetch(url, { ...fetchOptions, headers, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("retry-after") || "5", 10);
        const waitMs = retryAfter * 1000;
        console.warn(`[GHL] 429 rate limited, retrying after ${waitMs}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }

      if (response.status >= 500 && attempt < retries - 1) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 15000);
        console.warn(`[GHL] Server error ${response.status}, retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
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
      clearTimeout(timeoutId);
      if (attempt === retries - 1) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      // AbortError = our own 20 s timeout fired; treat like any other transient error.
      const isAbort = err instanceof Error && err.name === "AbortError";
      const isRetryable = isAbort || errMsg.includes("429") || errMsg.includes("ECONNRESET") || errMsg.includes("ETIMEDOUT") || errMsg.includes("fetch failed");
      if (isRetryable) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 15000);
        const reason = isAbort ? `timeout (${GHL_REQUEST_TIMEOUT_MS}ms)` : errMsg.substring(0, 100);
        console.warn(`[GHL] Transient error, retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${retries}): ${reason}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`GHL API request to ${path} failed after ${retries} retries`);
}

export function isGhlConfigured(): boolean {
  return getConfig() !== null;
}

export function getGhlStatus() {
  const config = getConfig();
  const hasToken = !!(process.env.GHL_PRIVATE_INTEGRATION_TOKEN || process.env.GHL_API_KEY);
  return {
    configured: !!config,
    hasToken,
    hasApiKey: !!process.env.GHL_API_KEY,
    hasPrivateToken: !!process.env.GHL_PRIVATE_INTEGRATION_TOKEN,
    hasLocationId: !!process.env.GHL_LOCATION_ID,
    hasCalendarId: !!process.env.GHL_CALENDAR_ID,
    hasWebhookSecret: !!process.env.GHL_WEBHOOK_SECRET,
    missingConfig: [
      ...(!hasToken ? ["GHL_PRIVATE_INTEGRATION_TOKEN or GHL_API_KEY"] : []),
      ...(!process.env.GHL_LOCATION_ID ? ["GHL_LOCATION_ID"] : []),
      ...(!process.env.GHL_CALENDAR_ID ? ["GHL_CALENDAR_ID"] : []),
      ...(!process.env.GHL_WEBHOOK_SECRET ? ["GHL_WEBHOOK_SECRET"] : []),
    ],
  };
}

function isLocalhostEnv(): boolean {
  const appUrl = process.env.APP_URL || "";
  const host = process.env.HOST || "";
  // Only use host/URL signals — never NODE_ENV, which can be "development" on deployed Replit envs
  return (
    appUrl.includes("localhost") ||
    appUrl.includes("127.0.0.1") ||
    host === "localhost" ||
    host === "127.0.0.1"
  );
}

export function validateGhlWebhookSignature(payload: string, signature: string): boolean {
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) {
    if (!isLocalhostEnv()) {
      console.error("[GHL] GHL_WEBHOOK_SECRET not set in non-localhost environment — rejecting webhook");
      return false;
    }
    console.warn("[GHL] GHL_WEBHOOK_SECRET not set — skipping signature verification (localhost dev mode only)");
    return true;
  }

  try {
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    const sigToCompare = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    if (sigToCompare.length !== expectedSig.length) return false;
    return crypto.timingSafeEqual(Buffer.from(sigToCompare, "hex"), Buffer.from(expectedSig, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify a GHL webhook signed with the current Ed25519 public-key standard.
 *
 * GHL signs the raw request body with their private Ed25519 key and sets
 *   X-GHL-Signature: <base64-encoded-signature>
 *
 * Configure GHL_WEBHOOK_PUBLIC_KEY in Replit Secrets with the base64-encoded
 * DER-SPKI public key (or PEM) obtained from your GHL account →
 * Settings → Integrations → Webhooks → Public Key.
 *
 * Returns true on localhost when the key is not set (dev permissive mode).
 * Always returns false in production when the key is not configured.
 */
export function validateGhlWebhookSignatureEd25519(
  payload: string,
  signature: string,
): boolean {
  // Accept both env var names for backward compatibility.
  // GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY is the current standard name (matches the
  // SDR/ghl-client path and GHL's Marketplace SDK naming convention).
  // GHL_WEBHOOK_PUBLIC_KEY is the legacy name kept for existing deployments.
  const pubKeyRaw =
    process.env.GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY ||
    process.env.GHL_WEBHOOK_PUBLIC_KEY;
  if (!pubKeyRaw) {
    if (!isLocalhostEnv()) {
      console.error(
        "[GHL] Neither GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY nor GHL_WEBHOOK_PUBLIC_KEY is set — " +
        "cannot verify Ed25519 signature in production. Set GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY " +
        "to the Ed25519 public key from GHL → Settings → Integrations → Webhooks → Public Key."
      );
      return false;
    }
    console.warn("[GHL] GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY not set — skipping Ed25519 verification (localhost dev mode only)");
    return true;
  }

  try {
    let publicKey: crypto.KeyObject;
    if (pubKeyRaw.trim().startsWith("-----")) {
      publicKey = crypto.createPublicKey(pubKeyRaw.trim());
    } else {
      publicKey = crypto.createPublicKey({
        key: Buffer.from(pubKeyRaw, "base64"),
        format: "der",
        type: "spki",
      });
    }
    return crypto.verify(
      null,
      Buffer.from(payload, "utf8"),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch (err: any) {
    console.error("[GHL] Ed25519 signature verification error:", err.message);
    return false;
  }
}

export async function checkGhlHealth(): Promise<{
  connected: boolean;
  latencyMs: number;
  locationName?: string;
  error?: string;
  configStatus?: ReturnType<typeof getGhlStatus>;
}> {
  const status = getGhlStatus();
  const config = getConfig();
  if (!config) {
    return {
      connected: false,
      latencyMs: 0,
      error: `GHL not configured. Missing: ${status.missingConfig.filter(k => ["GHL_API_KEY", "GHL_LOCATION_ID"].includes(k)).join(", ")}`,
      configStatus: status,
    };
  }

  const start = Date.now();
  try {
    const data = await ghlFetch(`/locations/${config.locationId}`);
    const latencyMs = Date.now() - start;
    return {
      connected: true,
      latencyMs,
      locationName: data?.location?.name || data?.name || "Unknown",
      configStatus: status,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    return {
      connected: false,
      latencyMs,
      error: err.message,
      configStatus: status,
    };
  }
}

type GhlContactInput = Pick<Contact,
  "id" | "firstName" | "lastName" | "email" | "phone" | "ghlContactId"
> & Partial<Pick<Contact,
  "companyName" | "tags" | "vertical" | "monthlyVolume" | "primaryOfferPath" |
  "currentProvider" | "painPoints" | "interestedIn0Percent" | "needTerminal" |
  "utmSource" | "utmMedium" | "utmCampaign" | "promoCode" | "consentSms" |
  "consentEmail" | "landingPage" | "referralSource" |
  "doNotContact" | "doNotAutoContact" | "consentTier" | "lifecycleStage" |
  "smsStatus" | "emailStatus" | "sourceCategory" | "leadSource" | "state" | "city" | "phoneType" | "timezone"
>> & {
  referralPartnerCode?: string;
  ghlPermissionPayload?: {
    lb_email_allowed: boolean;
    lb_manual_call_allowed: boolean;
    lb_sms_allowed: boolean;
    lb_voice_ai_allowed: boolean;
    lb_ringless_vm_allowed: boolean;
    lb_channel_block_reason: string | null;
    lb_next_best_action: string | null;
  };
};

/**
 * Look up an existing GHL contact by email. Returns the GHL contact ID if found,
 * or null if no match exists. Never creates a contact.
 */
export async function lookupGhlContactByEmail(email: string): Promise<string | null> {
  const config = getConfig();
  if (!config) throw new Error("GHL not configured");
  try {
    const result = await ghlFetch(
      `/contacts/search/duplicate?locationId=${encodeURIComponent(config.locationId)}&email=${encodeURIComponent(email)}`,
      { method: "GET" }
    );
    const id = result?.contact?.id ?? result?.contacts?.[0]?.id ?? null;
    return id ?? null;
  } catch {
    return null;
  }
}

/**
 * Thrown when `upsertGhlContact` detects that the GHL ID returned by a 400
 * "duplicate contact" response is already owned by a *different* local contact.
 * Callers should treat this as a safe data-skip — not a GHL API failure.
 */
export class GhlIdentityConflictError extends Error {
  readonly ghlContactId: string;
  readonly localContactId: number;
  readonly owningContactId: number;
  constructor(opts: { ghlContactId: string; localContactId: number; owningContactId: number }) {
    super(`ghl_identity_conflict: GHL ID ${opts.ghlContactId} is already owned by local contact ${opts.owningContactId} — cannot relink to contact ${opts.localContactId}`);
    this.name = "GhlIdentityConflictError";
    this.ghlContactId = opts.ghlContactId;
    this.localContactId = opts.localContactId;
    this.owningContactId = opts.owningContactId;
  }
}

/**
 * Terminal-skip codes for contact-level data-quality failures (task #1604).
 * These are thrown as GhlInvalidContactError.message so every caller's error
 * string classifies as "skip" and no raw provider response body leaks into logs.
 */
export const GHL_NO_USABLE_IDENTITY = "ghl_contact_no_usable_identity";
export const GHL_EMAIL_VALIDATION_REJECTED = "ghl_contact_email_validation_rejected";

/**
 * Thrown by `upsertGhlContact` when a contact is terminally un-syncable due to
 * data quality: no usable identity fields, or GHL rejected the email with a
 * known field-validation 422. A sanitized audit has ALREADY been written by
 * the time this is thrown — callers must treat it as a skip: no retry, no
 * `ghl_sync_failed` logging, no circuit-breaker counting.
 */
export class GhlInvalidContactError extends Error {
  readonly code: string;
  readonly contactId: number | null;
  constructor(code: string, contactId: number | null) {
    super(code);
    this.name = "GhlInvalidContactError";
    this.code = code;
    this.contactId = contactId;
  }
}

/**
 * Pure pre-send validation of the GHL identity fields (email/phone).
 * - Valid email → proceed normally.
 * - Invalid email but usable phone (≥10 digits) → omit email from payload.
 * - Neither usable → terminal skip; no provider call may be made.
 */
export function validateGhlIdentityFields(fields: { email?: string | null; phone?: string | null }):
  | { ok: true; emailOmitted: boolean }
  | { ok: false; reason: typeof GHL_NO_USABLE_IDENTITY } {
  if (isValidEmail(fields.email)) return { ok: true, emailOmitted: false };
  const digits = (fields.phone ?? "").replace(/\D/g, "");
  if (digits.length >= 10) return { ok: true, emailOmitted: true };
  return { ok: false, reason: GHL_NO_USABLE_IDENTITY };
}

/**
 * Returns true when the error string is a GHL 422 whose body matches a known
 * email field-validation error. Unknown 422 bodies do NOT match and remain
 * "retryable" (conservative classification preserved).
 */
export function isGhlEmailValidation422(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  if (!/GHL API error 422/i.test(errorMessage)) return false;
  return /email[^"]*invalid|invalid[^"]*email|CONTACT_EMAIL_INVALID|email_invalid|email must be a valid/i.test(errorMessage);
}

async function writeInvalidContactSkipAudit(contactId: number | null, reason: string, stage: string): Promise<void> {
  // Sanitized: internal id + normalized reason + stage only. Never the email,
  // phone, GHL payload, token, or provider response body.
  await storage.createAuditLog({
    action: "ghl_sync_skipped_invalid_contact",
    entityType: "contact",
    entityId: contactId ?? undefined,
    details: { reason, stage, retryable: false },
  }).catch(() => {});
}

/**
 * Shared validated boundary for ALL GHL contact upserts (sync loop, contact
 * writer create/update flows, proposals). Performs pre-send identity
 * validation, strips an invalid email when a usable phone exists, and converts
 * known email-validation 422s from GHL into sanitized terminal skips.
 */
/** Shared permission-projection entry point for server adapters. It accepts only
 * the canonical reviewed permission keys; provider field IDs are resolved from
 * a fresh read-only location field map before the transport authorization. */
export async function syncGhlPermissionFields(input: {
  ghlContactId: string;
  fields: Array<{ key: string; field_value: string }>;
  locationId?: string;
}): Promise<void> {
  const config = getConfig();
  if (!config || (input.locationId && input.locationId !== config.locationId)) {
    throw new Error("GHL_PERMISSION_LOCATION_MISMATCH");
  }
  if (!input.ghlContactId || !Array.isArray(input.fields) || input.fields.length === 0
      || input.fields.some(field => !isKnownPermissionCustomFieldKey(field.key))) {
    throw new Error("GHL_PERMISSION_FIELD_PAYLOAD_INVALID");
  }
  await ghlFetch(`/contacts/${encodeURIComponent(input.ghlContactId)}`, {
    method: "PUT",
    body: JSON.stringify({ customFields: input.fields }),
  });
}

export async function upsertGhlContact(contact: GhlContactInput): Promise<string> {
  await denyCro03cForbiddenEffect("ghl_mutation");
  const identity = validateGhlIdentityFields({ email: contact.email, phone: contact.phone });
  if (!identity.ok) {
    console.warn(`[GHL] Contact ${contact.id || "(new)"} skipped — no usable identity fields (invalid email, no valid phone)`);
    await writeInvalidContactSkipAudit(contact.id || null, GHL_NO_USABLE_IDENTITY, "pre_send_validation");
    throw new GhlInvalidContactError(GHL_NO_USABLE_IDENTITY, contact.id || null);
  }
  const toSend = identity.emailOmitted
    ? ({ ...contact, email: undefined } as unknown as GhlContactInput)
    : contact;
  if (identity.emailOmitted) {
    console.warn(`[GHL] Contact ${contact.id || "(new)"} has invalid email — syncing phone-only (email omitted from payload)`);
  }
  try {
    return await doUpsertGhlContact(toSend);
  } catch (err: any) {
    if (err instanceof GhlInvalidContactError || err instanceof GhlIdentityConflictError) throw err;
    if (isGhlEmailValidation422(err?.message)) {
      console.warn(`[GHL] Contact ${contact.id || "(new)"} rejected by GHL email validation (422) — terminal skip, not retried`);
      await writeInvalidContactSkipAudit(contact.id || null, GHL_EMAIL_VALIDATION_REJECTED, "provider_422_email_validation");
      throw new GhlInvalidContactError(GHL_EMAIL_VALIDATION_REJECTED, contact.id || null);
    }
    throw err;
  }
}

async function doUpsertGhlContact(contact: GhlContactInput): Promise<string> {
  const config = getConfig();
  if (!config) throw new Error("GHL not configured");
  // CRM identity upserts use the independent GHL CRM control and transport
  // in-flight epoch barrier. Do not route them through the outbound-send pause:
  // messaging/workflow/enrollment paths retain that separate full protocol.
  return doUpsertGhlContactInner(contact, config);
}

async function doUpsertGhlContactInner(contact: GhlContactInput, config: NonNullable<ReturnType<typeof getConfig>>): Promise<string> {

  const customFields: Array<{ key: string; field_value: string }> = [];
  const addCF = (key: string, value: string) => customFields.push({ key, field_value: value });

  if (contact.vertical) {
    addCF("vertical", contact.vertical);
    addCF("lb_vertical", contact.vertical);
  }
  if (contact.monthlyVolume) {
    addCF("monthly_volume", contact.monthlyVolume);
    addCF("lb_monthly_volume", contact.monthlyVolume);
  }
  if (contact.primaryOfferPath) {
    addCF("offer_path", contact.primaryOfferPath);
    addCF("lb_preferred_program", contact.primaryOfferPath);
  }
  if (contact.currentProvider) {
    addCF("current_provider", contact.currentProvider);
    addCF("lb_current_processor", contact.currentProvider);
  }
  if (contact.primaryOfferPath) {
    addCF("lb_offer_route", contact.primaryOfferPath);
  }
  const contactAny = contact as any;
  if (contactAny.offerConfidence != null) {
    addCF("lb_offer_confidence", String(contactAny.offerConfidence));
  }
  if (contactAny.recommendedNextAction) {
    addCF("lb_recommended_action", contactAny.recommendedNextAction);
  }
  if (contactAny.offerReasoning) {
    addCF("lb_offer_reasoning", contactAny.offerReasoning.slice(0, 500));
  }
  if (contactAny.processorDetected) {
    addCF("lb_processor_detected", contactAny.processorDetected);
  }
  if (contact.painPoints && Array.isArray(contact.painPoints) && contact.painPoints.length > 0) {
    addCF("lb_pain_points", contact.painPoints.join(", "));
  }
  if (contact.interestedIn0Percent !== undefined && contact.interestedIn0Percent !== null) {
    addCF("lb_interested_0_percent", contact.interestedIn0Percent ? "Yes" : "No");
  }
  if (contact.needTerminal !== undefined && contact.needTerminal !== null) {
    addCF("lb_terminal_need", contact.needTerminal ? "Yes" : "No");
  }
  if (contact.utmSource) addCF("lb_utm_source", contact.utmSource);
  if (contact.utmMedium) addCF("lb_utm_medium", contact.utmMedium);
  if (contact.utmCampaign) addCF("lb_utm_campaign", contact.utmCampaign);
  if (contact.promoCode) addCF("lb_promo_code", contact.promoCode);
  if (contact.referralSource) addCF("lb_referral_source", contact.referralSource);
  const partnerCodeForGhl = contact.referralPartnerCode || contact.promoCode;
  if (partnerCodeForGhl) addCF("lb_partner_code", partnerCodeForGhl);
  if (contact.consentSms !== undefined && contact.consentSms !== null) {
    addCF("lb_consent_sms", contact.consentSms ? "Yes" : "No");
  }
  if (contact.consentEmail !== undefined && contact.consentEmail !== null) {
    addCF("lb_consent_email", contact.consentEmail ? "Yes" : "No");
  }
  if (contact.landingPage) {
    const sourceMap: Record<string, string> = {
      "/free-analysis": "free-analysis",
      "/get-started": "get-started",
      "/upload-statement": "statement-upload",
      "/support": "support",
      "/merchant-application": "merchant-app",
      "/affiliate": "affiliate",
      "/estimate": "estimate",
    };
    addCF("lb_lead_source", sourceMap[contact.landingPage] || contact.landingPage);
  }

  const payload: Record<string, unknown> = {
    locationId: config.locationId,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    companyName: contact.companyName || undefined,
    tags: contact.tags || [],
  };
  if (customFields.length > 0) {
    payload.customFields = customFields;
  }

  // GHL only accepts locationId on contact CREATE (POST), not UPDATE (PUT).
  // Build a separate update payload without locationId to avoid 422 errors.
  const { locationId: _loc, ...updatePayload } = payload;

  let resolvedGhlId: string;

  if (contact.ghlContactId) {
    await ghlFetch(`/contacts/${contact.ghlContactId}`, {
      method: "PUT",
      body: JSON.stringify(updatePayload),
    });
    resolvedGhlId = contact.ghlContactId;
  } else {
    try {
      const result = await ghlFetch("/contacts/", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      resolvedGhlId = result.contact?.id;
      if (resolvedGhlId && contact.id) {
        await storage.updateContact(contact.id, { ghlContactId: resolvedGhlId });
      }
    } catch (err: any) {
      // GHL returns 400 with the existing contact ID when a duplicate is detected.
      // Parse it out, link, and update — this turns a hard error into a successful upsert.
      const msg = String(err?.message || "");
      if (msg.includes("400") && /duplicat|already exist/i.test(msg)) {
        const idMatch = msg.match(/"(?:id|contactId)"\s*:\s*"([a-zA-Z0-9]+)"/);
        const existingId = idMatch?.[1];
        if (existingId) {
          // ── Ownership pre-check ──────────────────────────────────────────────
          // Before relinking, verify that existingId is not already owned by a
          // *different* local contact. If it is, updating contact.id would hit
          // the contacts_ghl_contact_id_unique constraint and crash sync —
          // tripping the circuit breaker on every tick. Detect and skip instead.
          if (contact.id) {
            const currentOwner = await storage.getContactByGhlContactId(existingId).catch(() => null);
            if (currentOwner && currentOwner.id !== contact.id) {
              console.warn(
                `[GHL] Identity conflict: GHL ID ${existingId} is already owned by local contact ${currentOwner.id} — will not relink contact ${contact.id}`
              );
              await storage.createAuditLog({
                action: "ghl_sync_identity_conflict",
                entityType: "contact",
                entityId: contact.id,
                details: {
                  ghlContactId: existingId,
                  owningContactId: currentOwner.id,
                  message: "GHL returned duplicate ID that is already owned by another local contact — relinking skipped",
                },
              }).catch(() => {});
              throw new GhlIdentityConflictError({
                ghlContactId: existingId,
                localContactId: contact.id,
                owningContactId: currentOwner.id,
              });
            }
          }
          // ────────────────────────────────────────────────────────────────────
          try {
            await ghlFetch(`/contacts/${existingId}`, {
              method: "PUT",
              body: JSON.stringify(updatePayload),
            });
            if (contact.id) {
              await storage.updateContact(contact.id, { ghlContactId: existingId });
            }
            resolvedGhlId = existingId;
          } catch (putErr: any) {
            if (putErr instanceof GhlIdentityConflictError) throw putErr;
            console.warn(`[GHL] Linked existing contact ${existingId} but PUT update failed:`, putErr?.message);
            if (contact.id) {
              await storage.updateContact(contact.id, { ghlContactId: existingId });
            }
            resolvedGhlId = existingId;
          }
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }

  // ── Wave 7: Write Replit permission fields to GHL as a SEPARATE call ──────
  // Isolated so a 422 (missing GHL custom field definition) never aborts the
  // base contact identity sync. GHL requires the lb_* fields to be created in
  // GHL Location Settings before they can be written — log 422 clearly.
  if (resolvedGhlId) {
    try {
      let permPayload = contact.ghlPermissionPayload;

      if (!permPayload && contact.id) {
        try {
          // Five-channel dry-run matrix — never use enforcement mode here
          const { evaluateContactability } = await import("./contactability");
          const channels = ["email", "sms", "voice_ai", "ringless_vm", "manual_call"] as const;
          const results = await Promise.allSettled(
            channels.map(ch => evaluateContactability({ contactId: contact.id!, channel: ch, mode: "dryRun" }))
          );
          const [emailR, smsR, voiceR, rvmR, callR] = results;
          // Prefer the email result's ghlPermissionPayload shape as the base (it has all keys)
          const emailPayload = emailR.status === "fulfilled" ? emailR.value.ghlPermissionPayload : undefined;
          if (emailPayload) {
            permPayload = {
              ...emailPayload,
              lb_sms_allowed: smsR.status === "fulfilled" ? (smsR.value.ghlPermissionPayload?.lb_sms_allowed ?? false) : false,
              lb_voice_ai_allowed: voiceR.status === "fulfilled" ? (voiceR.value.ghlPermissionPayload?.lb_voice_ai_allowed ?? false) : false,
              lb_ringless_vm_allowed: rvmR.status === "fulfilled" ? (rvmR.value.ghlPermissionPayload?.lb_ringless_vm_allowed ?? false) : false,
              lb_manual_call_allowed: callR.status === "fulfilled" ? (callR.value.ghlPermissionPayload?.lb_manual_call_allowed ?? false) : false,
            };
          }
        } catch {
          // Non-fatal — contactability may not have the contact yet
        }
      }

      const permFields: Array<{ key: string; field_value: string }> = [
        { key: "lb_do_not_contact", field_value: contact.doNotContact ? "true" : "false" },
        { key: "lb_do_not_autocontact", field_value: contact.doNotAutoContact ? "true" : "false" },
        { key: "lb_lifecycle_stage", field_value: contact.lifecycleStage || "prospect" },
        { key: "lb_channel_permissions_updated_at", field_value: new Date().toISOString() },
      ];

      if (contact.consentTier) {
        permFields.push({ key: "lb_consent_tier", field_value: contact.consentTier });
      }

      if (permPayload) {
        permFields.push(
          { key: "lb_can_email", field_value: permPayload.lb_email_allowed ? "true" : "false" },
          { key: "lb_can_manual_call", field_value: permPayload.lb_manual_call_allowed ? "true" : "false" },
          { key: "lb_can_sms", field_value: permPayload.lb_sms_allowed ? "true" : "false" },
          { key: "lb_can_ai_voice", field_value: permPayload.lb_voice_ai_allowed ? "true" : "false" },
          { key: "lb_can_ringless_vm", field_value: permPayload.lb_ringless_vm_allowed ? "true" : "false" },
        );
        const channelPermJson = JSON.stringify({
          email: permPayload.lb_email_allowed,
          manual_call: permPayload.lb_manual_call_allowed,
          sms: permPayload.lb_sms_allowed,
          voice_ai: permPayload.lb_voice_ai_allowed,
          ringless_vm: permPayload.lb_ringless_vm_allowed,
        });
        permFields.push({ key: "lb_channel_permissions", field_value: channelPermJson });
        if (permPayload.lb_channel_block_reason) {
          permFields.push({ key: "lb_channel_block_reason", field_value: permPayload.lb_channel_block_reason });
        }
      }

      const attemptedFields = permFields.map(f => f.key);
      try {
        await syncGhlPermissionFields({
          ghlContactId: resolvedGhlId,
          locationId: config.locationId,
          fields: permFields,
        });
      } catch (permErr: any) {
        const permMsg = String(permErr?.message || "");
        const httpStatus = permMsg.match(/GHL API error (\d+)/)?.[1] || "unknown";
        console.warn(`[GHL Wave7] Permission field write failed (${httpStatus}) for contact ${resolvedGhlId}:`, permMsg.slice(0, 200));
        // Log to ghlActivityLog — never abort base sync
        if (contact.id) {
          storage.createGhlActivityLog({
            contactId: contact.id,
            dealId: null,
            direction: "outbound",
            channel: "sync_error",
            templateId: null,
            subject: null,
            body: null,
            status: "error",
            ghlMessageId: resolvedGhlId,
            metadata: {
              operation: "permission_field_write",
              attemptedFields,
              httpStatus: Number(httpStatus) || null,
              errorBody: permMsg.slice(0, 500),
            },
          }).catch(() => {});
        }
      }
    } catch (outerPermErr: any) {
      console.warn("[GHL Wave7] Unexpected error in permission field write (non-fatal):", outerPermErr?.message);
    }
  }

  return resolvedGhlId;
}

export async function sendGhlEmail(params: {
  contactId: number;
  dealId?: number;
  subject: string;
  body: string;
  templateId?: number;
  fromEmail?: string;
  fromName?: string;
  /**
   * Reply-To address. GHL's conversation API does not expose a dedicated
   * Reply-To header at enrollment time; this field is recorded in the
   * activity log for audit purposes but is not forwarded to the wire payload.
   * Use SMTP when a true Reply-To header is required.
   */
  replyTo?: string;
  /**
   * When true, skips the `createGhlActivityLog` DB write on both success and failure.
   * Used by deliver-only helpers (e.g. `sendConfirmationEmail`) that must remain
   * side-effect free — the caller is responsible for all audit/activity logging.
   */
  skipActivityLog?: boolean;
  /** Defaults fail-closed to marketing. Only trusted server flows may opt into transactional responses. */
  commercialPurpose?: "marketing_outreach" | "transactional_response";
  inboundRequestId?: string;
  intendedRecipientContactId?: number;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  await denyCro03cForbiddenEffect("email");
  // ── Unavoidable commercial-classification gate (transport boundary) ───────
  try {
    const { authorizeCommercialUse } = await import("./commercial-resolution");
    const hasInboundBinding = params.commercialPurpose === "transactional_response"
      && !!params.inboundRequestId?.trim()
      && params.intendedRecipientContactId === params.contactId;
    const commercial = await authorizeCommercialUse({
      subjectType: "contact", subjectId: params.contactId,
      effect: params.commercialPurpose === "transactional_response"
        ? hasInboundBinding ? "inbound_transactional_acknowledgement" : "account_transactional"
        : "marketing_outreach",
      inboundRequestId: hasInboundBinding ? params.inboundRequestId : undefined,
      intendedRecipientId: hasInboundBinding ? params.intendedRecipientContactId : undefined,
    });
    if (!commercial.effectiveDecision.allowed) {
      return { success: false, error: commercial.effectiveDecision.reasonCode };
    }
  } catch (error: any) {
    console.error(`[GHL:sendGhlEmail] Commercial authorization error — fail closed: ${error.message}`);
    return { success: false, error: "COMMERCIAL_CLASS_UNKNOWN" };
  }
  let renderedBody: string;
  try {
    renderedBody = await renderEmailHtmlForPurpose({
      html: params.body,
      purpose: params.commercialPurpose ?? "marketing_outreach",
      contactId: params.contactId,
    });
  } catch (error: any) {
    return { success: false, error: error.message ?? "COMPLIANCE_CONFIGURATION_UNAVAILABLE" };
  }
  // ── Unavoidable pause authority gate (transport boundary) ────────────────
  // Every provider send must clear the canonical pause authority BEFORE any
  // network I/O. This is the final enforcement boundary — caller-level checks
  // are defense-in-depth; this gate cannot be bypassed.
  try {
    const { authorize, recheckEpoch } = await import("./outbound-pause-authority");
    const { registerInflight, deregisterInflight } = await import("./outbound-control-service");
    const decision = await authorize({});
    if (!decision.allowed) {
      console.warn(
        `[GHL:sendGhlEmail] Blocked by pause authority: ${decision.reasonCode} ` +
        `(contactId=${params.contactId}, subject="${params.subject}")`,
      );
      return { success: false, error: `Outbound paused: ${decision.reasonCode}` };
    }
    // Register in-flight token so pause barrier can drain us
    const token = crypto.randomUUID();
    await registerInflight(token, decision.epoch);
    try {
      // Final epoch recheck immediately before network I/O
      const epochOk = await recheckEpoch(decision.epoch);
      if (!epochOk) {
        return { success: false, error: "Outbound paused: epoch changed before send (pause activated)" };
      }
      return await _sendGhlEmailInner({ ...params, body: renderedBody }, decision.epoch);
    } finally {
      deregisterInflight(token);
    }
  } catch (gateErr: any) {
    // Gate itself failed (DB down, module error) — fail closed
    console.error(`[GHL:sendGhlEmail] Pause authority gate error — fail closed: ${gateErr.message}`);
    return { success: false, error: `Pause gate error: ${gateErr.message}` };
  }
}

/**
 * The exact provider payload for a conversation email. The transport sends this object as JSON; it carries an HTML body
 * only (there is no plain-text field), which is why previews label any generated plain text as reference text.
 * emailFrom / emailReplyTo are present only when the calling path supplies them; otherwise the provider's configured
 * sender applies and this code does not know its address.
 */
export function buildGhlEmailPayload(input: {
  ghlContactId: string; subject: string; html: string; fromEmail?: string; fromName?: string; replyTo?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = { type: "Email", contactId: input.ghlContactId, subject: input.subject, html: input.html };
  // NOTE: emailReplyMode is NOT included — "custom" is not a valid GHL enum value and causes 422
  // CONVERSATIONS_VALIDATION_ERROR. emailFrom alone is sufficient to override the sender address.
  if (input.fromEmail) payload.emailFrom = input.fromName ? `${input.fromName} <${input.fromEmail}>` : input.fromEmail;
  // Critical for dedicated-mailbox outreach so replies land in a monitored inbox.
  if (input.replyTo) payload.emailReplyTo = input.replyTo;
  return payload;
}

async function _sendGhlEmailInner(params: {
  contactId: number;
  dealId?: number;
  subject: string;
  body: string;
  templateId?: number;
  fromEmail?: string;
  fromName?: string;
  replyTo?: string;
  skipActivityLog?: boolean;
  commercialPurpose?: "marketing_outreach" | "transactional_response";
}, _pauseEpoch: bigint): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const contact = await storage.getContact(params.contactId);
    if (!contact) throw new Error("Contact not found");
    if (!contact.email) throw new Error("Contact has no email");

    let ghlContactId = contact.ghlContactId;
    if (!ghlContactId) {
      ghlContactId = await upsertGhlContact(contact);
    }

    const config = getConfig();
    if (!config) throw new Error("GHL not configured");

    const emailPayload = buildGhlEmailPayload({
      ghlContactId, subject: params.subject, html: params.body,
      fromEmail: params.fromEmail, fromName: params.fromName, replyTo: params.replyTo,
    });

    const result = await ghlFetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify(emailPayload),
      pauseEpoch: _pauseEpoch,
    });

    if (result?.messageId) trackOutboundMessageId(result.messageId);

    if (!params.skipActivityLog) {
      await storage.createGhlActivityLog({
        contactId: params.contactId,
        dealId: params.dealId || null,
        direction: "outbound",
        channel: "email",
        templateId: params.templateId || null,
        subject: params.subject,
        body: params.body,
        status: "sent",
        ghlMessageId: result?.messageId || null,
      });
    }

    return { success: true, messageId: result?.messageId };
  } catch (err: any) {
    if (!params.skipActivityLog) {
      await storage.createGhlActivityLog({
        contactId: params.contactId,
        dealId: params.dealId || null,
        direction: "outbound",
        channel: "email",
        templateId: params.templateId || null,
        subject: params.subject,
        body: params.body,
        status: "failed",
        ghlMessageId: null,
        metadata: { error: err.message },
      });
    }
    return { success: false, error: err.message };
  }
}

export async function sendGhlEmailForMerchant(params: {
  email: string;
  subject: string;
  body: string;
  fromEmail?: string;
  fromName?: string;
  /**
   * DB contact ID used to generate a signed CAN-SPAM unsubscribe token.
   * When provided, the injected footer contains a functional `/unsubscribe?t=…` link.
   */
  contactId?: number;
  commercialPurpose?: "marketing_outreach" | "transactional_response";
  internalNotification?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  if (!params.contactId && !params.internalNotification) {
    return { success: false, error: "COMMERCIAL_CLASS_UNKNOWN" };
  }
  if (!params.internalNotification) try {
    const { authorizeCommercialUse } = await import("./commercial-resolution");
    const commercial = await authorizeCommercialUse({
      subjectType: "contact", subjectId: params.contactId!,
      effect: params.commercialPurpose === "transactional_response"
        ? "account_transactional" : "marketing_outreach",
    });
    if (!commercial.effectiveDecision.allowed) {
      return { success: false, error: commercial.effectiveDecision.reasonCode };
    }
  } catch (error: any) {
    console.error(`[GHL:sendGhlEmailForMerchant] Commercial authorization error — fail closed: ${error.message}`);
    return { success: false, error: "COMMERCIAL_CLASS_UNKNOWN" };
  }
  let renderedBody: string;
  try {
    renderedBody = await renderEmailHtmlForPurpose({
      html: params.body,
      purpose: params.internalNotification || params.commercialPurpose === "transactional_response"
        ? "transactional_response"
        : "marketing_outreach",
      contactId: params.contactId,
    });
  } catch (error: any) {
    return { success: false, error: error.message ?? "COMPLIANCE_CONFIGURATION_UNAVAILABLE" };
  }
  // ── Unavoidable pause authority gate (transport boundary) ────────────────
  try {
    const { authorize, recheckEpoch } = await import("./outbound-pause-authority");
    const { registerInflight, deregisterInflight } = await import("./outbound-control-service");
    const decision = await authorize({});
    if (!decision.allowed) {
      console.warn(
        `[GHL:sendGhlEmailForMerchant] Blocked by pause authority: ${decision.reasonCode} ` +
        `(email=${params.email}, subject="${params.subject}")`,
      );
      return { success: false, error: `Outbound paused: ${decision.reasonCode}` };
    }
    const token = crypto.randomUUID();
    await registerInflight(token, decision.epoch);
    try {
      const epochOk = await recheckEpoch(decision.epoch);
      if (!epochOk) {
        return { success: false, error: "Outbound paused: epoch changed before send" };
      }
      return await _sendGhlEmailForMerchantInner({ ...params, body: renderedBody }, decision.epoch);
    } finally {
      deregisterInflight(token);
    }
  } catch (gateErr: any) {
    console.error(`[GHL:sendGhlEmailForMerchant] Pause gate error — fail closed: ${gateErr.message}`);
    return { success: false, error: `Pause gate error: ${gateErr.message}` };
  }
}

/** Server-only operational/security delivery. Never use for recipient marketing. */
export async function sendGhlInternalNotification(params: Omit<Parameters<typeof sendGhlEmailForMerchant>[0], "contactId" | "commercialPurpose">): Promise<{ success: boolean; error?: string }> {
  return sendGhlEmailForMerchant({ ...params, internalNotification: true });
}

/** Server-owned partner account activation/reset delivery; never for outreach. */
export async function sendGhlPartnerTransactionalEmail(params: Omit<Parameters<typeof sendGhlEmailForMerchant>[0], "contactId" | "commercialPurpose">): Promise<{ success: boolean; error?: string }> {
  return sendGhlEmailForMerchant({ ...params, internalNotification: true });
}

async function _sendGhlEmailForMerchantInner(params: {
  email: string;
  subject: string;
  body: string;
  fromEmail?: string;
  fromName?: string;
  contactId?: number;
  commercialPurpose?: "marketing_outreach" | "transactional_response";
  internalNotification?: boolean;
}, _pauseEpoch: bigint): Promise<{ success: boolean; error?: string }> {
  try {
    const config = getConfig();
    if (!config) throw new Error("GHL not configured");

    const emailPayload: Record<string, unknown> = {
      type: "Email",
      email: params.email,
      subject: params.subject,
      html: params.body,
    };

    if (params.fromEmail) {
      // NOTE: emailReplyMode is NOT included — "custom" is not a valid GHL enum
      // value and causes 422 CONVERSATIONS_VALIDATION_ERROR. emailFrom alone
      // is sufficient to override the sender address.
      emailPayload.emailFrom = params.fromName
        ? `${params.fromName} <${params.fromEmail}>`
        : params.fromEmail;
    }

    const result = await ghlFetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify(emailPayload),
      pauseEpoch: _pauseEpoch,
    });

    if (result?.messageId) trackOutboundMessageId(result.messageId);

    console.log(`[GHL] Email sent to ${params.email} from ${params.fromEmail || "GHL-location-default"} — Subject: ${params.subject}`);

    return { success: true };
  } catch (err: any) {
    console.error(`[GHL] Welcome email failed for ${params.email}:`, err.message);
    return { success: false, error: err.message };
  }
}

export async function sendGhlSms(params: {
  contactId: number;
  dealId?: number;
  body: string;
  templateId?: number;
  /** Defaults fail-closed to marketing. Only trusted server flows may opt into transactional responses. */
  commercialPurpose?: "marketing_outreach" | "transactional_response";
  inboundRequestId?: string;
  intendedRecipientContactId?: number;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  await denyCro03cForbiddenEffect("sms");
  // ── Unavoidable commercial-classification gate (transport boundary) ───────
  try {
    const { authorizeCommercialUse } = await import("./commercial-resolution");
    const hasInboundBinding = params.commercialPurpose === "transactional_response"
      && !!params.inboundRequestId?.trim()
      && params.intendedRecipientContactId === params.contactId;
    const commercial = await authorizeCommercialUse({
      subjectType: "contact", subjectId: params.contactId,
      effect: params.commercialPurpose === "transactional_response"
        ? hasInboundBinding ? "inbound_transactional_acknowledgement" : "account_transactional"
        : "marketing_outreach",
      inboundRequestId: hasInboundBinding ? params.inboundRequestId : undefined,
      intendedRecipientId: hasInboundBinding ? params.intendedRecipientContactId : undefined,
    });
    if (!commercial.effectiveDecision.allowed) {
      return { success: false, error: commercial.effectiveDecision.reasonCode };
    }
  } catch (error: any) {
    console.error(`[GHL:sendGhlSms] Commercial authorization error — fail closed: ${error.message}`);
    return { success: false, error: "COMMERCIAL_CLASS_UNKNOWN" };
  }
  // ── Unavoidable pause authority gate (transport boundary) ────────────────
  try {
    const { authorize, recheckEpoch } = await import("./outbound-pause-authority");
    const { registerInflight, deregisterInflight } = await import("./outbound-control-service");
    const decision = await authorize({});
    if (!decision.allowed) {
      console.warn(
        `[GHL:sendGhlSms] Blocked by pause authority: ${decision.reasonCode} ` +
        `(contactId=${params.contactId})`,
      );
      return { success: false, error: `Outbound paused: ${decision.reasonCode}` };
    }
    const token = crypto.randomUUID();
    await registerInflight(token, decision.epoch);
    try {
      const epochOk = await recheckEpoch(decision.epoch);
      if (!epochOk) {
        return { success: false, error: "Outbound paused: epoch changed before send" };
      }
      return await _sendGhlSmsInner(params, decision.epoch);
    } finally {
      deregisterInflight(token);
    }
  } catch (gateErr: any) {
    console.error(`[GHL:sendGhlSms] Pause gate error — fail closed: ${gateErr.message}`);
    return { success: false, error: `Pause gate error: ${gateErr.message}` };
  }
}

async function _sendGhlSmsInner(params: {
  contactId: number;
  dealId?: number;
  body: string;
  templateId?: number;
}, _pauseEpoch: bigint): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const contact = await storage.getContact(params.contactId);
    if (!contact) throw new Error("Contact not found");
    if (!contact.phone) throw new Error("Contact has no phone");
    if (!contact.consentSms) throw new Error("Contact has not consented to SMS");

    let ghlContactId = contact.ghlContactId;
    if (!ghlContactId) {
      ghlContactId = await upsertGhlContact(contact);
    }

    const smsPayload = {
      type: "SMS",
      contactId: ghlContactId,
      message: params.body,
    };

    const result = await ghlFetch("/conversations/messages", {
      method: "POST",
      body: JSON.stringify(smsPayload),
      pauseEpoch: _pauseEpoch,
    });

    if (result?.messageId) trackOutboundMessageId(result.messageId);

    await storage.createGhlActivityLog({
      contactId: params.contactId,
      dealId: params.dealId || null,
      direction: "outbound",
      channel: "sms",
      templateId: params.templateId || null,
      subject: null,
      body: params.body,
      status: "sent",
      ghlMessageId: result?.messageId || null,
    });

    return { success: true, messageId: result?.messageId };
  } catch (err: any) {
    await storage.createGhlActivityLog({
      contactId: params.contactId,
      dealId: params.dealId || null,
      direction: "outbound",
      channel: "sms",
      templateId: params.templateId || null,
      subject: null,
      body: params.body,
      status: "failed",
      ghlMessageId: null,
      metadata: { error: err.message },
    });
    return { success: false, error: err.message };
  }
}

export function getCalendarBookingUrl(params?: {
  contactEmail?: string;
  contactName?: string;
  source?: string;
}): string | null {
  const config = getConfig();
  if (!config?.calendarId) return null;

  let url = `https://api.leadconnectorhq.com/widget/booking/${config.calendarId}`;
  const queryParams: string[] = [];
  if (params?.contactEmail) queryParams.push(`email=${encodeURIComponent(params.contactEmail)}`);
  if (params?.contactName) queryParams.push(`name=${encodeURIComponent(params.contactName)}`);
  if (params?.source) queryParams.push(`source=${encodeURIComponent(params.source)}`);
  if (queryParams.length > 0) url += `?${queryParams.join("&")}`;

  return url;
}

export function resolveMergeFields(template: string, data: Record<string, any>): string {
  // #1136 — If a merge field resolves to undefined/null, replace with "" (empty string) so
  // raw {{agentEmail}}, {{agentPhone}} etc. never appear verbatim in sent emails.
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path) => {
    const keys = path.split(".");
    let value: any = data;
    for (const key of keys) {
      value = value?.[key];
      if (value === undefined || value === null) return ""; // blank out missing vars
    }
    return String(value);
  });
}

export async function sendTemplatedMessage(params: {
  templateId: number;
  contactId: number;
  dealId?: number;
  extraData?: Record<string, any>;
}): Promise<{ success: boolean; error?: string }> {
  const template = await storage.getMessageTemplate(params.templateId);
  if (!template) return { success: false, error: "Template not found" };
  if (!template.isActive) return { success: false, error: "Template is inactive" };

  const contact = await storage.getContact(params.contactId);
  if (!contact) return { success: false, error: "Contact not found" };

  let deal: Deal | undefined;
  if (params.dealId) {
    deal = await storage.getDeal(params.dealId);
  }

  // Same registry/renderer as publication checks and previews. Unsupported or unresolved tokens fail the send
  // before any provider call; values are escaped for the output format.
  const { renderMessage } = await import("./message-token-registry");
  const calendarLink = getCalendarBookingUrl({
    contactEmail: contact.email ?? undefined,
    contactName: `${contact.firstName} ${contact.lastName}`,
  });
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(params.extraData ?? {})) {
    if (typeof v === "string" || typeof v === "number") extra[k] = String(v);
  }
  const tokenSource = {
    contact: {
      firstName: contact.firstName, lastName: contact.lastName, email: contact.email, phone: contact.phone,
      companyName: contact.companyName, vertical: contact.vertical,
    },
    deal: deal ? {
      effectiveRate: deal.effectiveRate, totalVolume: deal.totalVolume, totalFees: deal.totalFees, avgTicket: deal.avgTicket,
      recommendedPath: deal.recommendedPath, terminalRecommendation: deal.terminalRecommendation, offerPath: deal.offerPath,
      stage: deal.stage, estimatedGrossProfitMonthly: deal.estimatedGrossProfitMonthly, merchantTier: deal.merchantTier,
    } : null,
    calendarLink,
    extra,
  };
  let resolvedBody: string;
  let resolvedSubject: string | undefined;
  try {
    const bodyFormat = template.channel === "email" ? "html" : "text";
    resolvedBody = renderMessage("template", template.body, tokenSource, bodyFormat).output;
    resolvedSubject = template.subject ? renderMessage("template", template.subject, tokenSource, "subject").output : undefined;
  } catch (err: any) {
    if (err?.name === "RenderError") return { success: false, error: err.message };
    throw err;
  }

  if (template.channel === "email") {
    return sendGhlEmail({
      contactId: params.contactId,
      dealId: params.dealId,
      subject: resolvedSubject || "Liberty Bancard",
      body: resolvedBody,
      templateId: template.id,
    });
  } else if (template.channel === "sms") {
    return sendGhlSms({
      contactId: params.contactId,
      dealId: params.dealId,
      body: resolvedBody,
      templateId: template.id,
    });
  }

  return { success: false, error: `Unknown channel: ${template.channel}` };
}

export async function handleGhlWebhook(payload: any): Promise<void> {
  const { type, contactId, messageId, direction, body, subject, status: deliveryStatus } = payload;
  const webhookOccurrenceId = String(messageId ?? payload.eventId ?? payload.id ?? crypto.randomUUID());

  if (type === "ContactUpdate" || type === "contact-updated" || type === "ContactCreate" || type === "contact-created") {
    const { reconcileGhlInboundWebhookContact } = await import("./ghl-inbound-sync");
    await reconcileGhlInboundWebhookContact(payload);
    return;
  }

  if (type === "OpportunityUpdated" || type === "opportunity-updated" || type === "OpportunityStageUpdate") {
    await handleOpportunityUpdated(payload);
    return;
  }

  if (type === "TaskCompleted" || type === "task-completed") {
    await handleTaskCompleted(payload);
    return;
  }

  if (type === "TaskUpdated" || type === "task-updated" || type === "TaskCreate" || type === "task-created") {
    await handleTaskUpdated(payload);
    return;
  }

  if (type === "NoteAdded" || type === "note-added" || type === "NoteCreate") {
    await handleNoteAdded(payload);
    return;
  }

  if (type === "TagAdded" || type === "tag-added" || type === "ContactTagUpdate") {
    await handleTagAdded(payload);
    return;
  }

  if (type === "TagRemoved" || type === "tag-removed") {
    await handleTagRemoved(payload);
    return;
  }

  if (type === "ContactDelete" || type === "contact-delete" || type === "contact-deleted" || type === "ContactDeleted") {
    const { handleContactDeleteWebhook } = await import("./ghl-delete-sync");
    await handleContactDeleteWebhook(payload);
    return;
  }

  if (type === "OpportunityDelete" || type === "opportunity-delete" || type === "opportunity-deleted" || type === "OpportunityDeleted") {
    const { handleOpportunityDeleteWebhook } = await import("./ghl-delete-sync");
    await handleOpportunityDeleteWebhook(payload);
    return;
  }

  if (type === "TaskDelete" || type === "task-delete" || type === "task-deleted" || type === "TaskDeleted") {
    const { handleTaskDeleteWebhook } = await import("./ghl-delete-sync");
    await handleTaskDeleteWebhook(payload);
    return;
  }

  if (deliveryStatus && contactId) {
    const { data: contacts } = await storage.getContacts({ limit: 500 });
    const contact = contacts.find(c => c.ghlContactId === contactId);
    if (contact) {
      const recentLogs = await storage.getGhlActivityLogs(contact.id);
      const matchingLog = recentLogs.find(l => l.ghlMessageId === messageId);
      if (matchingLog) {
        console.log(`[GHL Webhook] Delivery status update: ${deliveryStatus} for message ${messageId}`);
      }
    }
  }

  if (direction === "inbound") {
    if (messageId && isOurOutboundMessage(messageId)) {
      console.log(`[GHL Webhook] Ignoring echo of our own outbound message: ${messageId}`);
      return;
    }

    const { data: contacts } = await storage.getContacts({ limit: 500 });
    const contact = contacts.find(c => c.ghlContactId === contactId);
    if (contact) {
      const channel = type === "SMS" ? "sms" : "email";

      const { data: deals } = await storage.getDeals({ limit: 500 });
      const contactDeal = deals.find(d => d.contactId === contact.id);

      const inboundActivity = await storage.createGhlActivityLog({
        contactId: contact.id,
        dealId: contactDeal?.id || null,
        direction: "inbound",
        channel,
        templateId: null,
        subject: subject || null,
        body: body || null,
        status: "received",
        ghlMessageId: messageId || null,
      });

      // Inbound canonical persistence is acknowledged: webhook failure must be
      // retryable rather than later appearing as confirmed reply absence.
      const { recordInboundEvent } = await import("./communication-events");
      await recordInboundEvent({
        contactId: contact.id,
        dealId: contactDeal?.id ?? null,
        channel: channel as "email" | "sms",
        provider: "ghl",
        subject: subject || null,
        body: body || null,
        status: "received",
        ghlMessageId: messageId || null,
      });

      await storage.updateContact(contact.id, {
        lastContactedAt: new Date(),
        tags: Array.from(new Set([...(contact.tags || []), "replied", `replied_${channel}`])),
      });

      const messageClassification = classifyInboundMessage(body || "");

      await storage.createNotification({
        channel: "internal",
        title: `Inbound ${channel.toUpperCase()} from ${contact.firstName} ${contact.lastName}`,
        message: body?.substring(0, 200) || "New message received",
        type: messageClassification.priority === "high" ? "warning" : "info",
        metadata: {
          contactId: contact.id,
          dealId: contactDeal?.id,
          channel,
          classification: messageClassification,
        },
      });

      if (messageClassification.intent === "unsubscribe") {
        const inboundOccurrenceId = String(payload.id ?? payload.messageId ?? `activity:${inboundActivity.id}`);
        const withdrawalChannels = channel === "sms"
          ? ["sms", "automated_phone"] as const
          : ["email"] as const;
        await Promise.all(withdrawalChannels.map((withdrawalChannel) => applyConsentCommand({
          subject: { type: "contact", id: contact.id },
          kind: "opt_out",
          channel: withdrawalChannel,
          purpose: "outreach",
          eventNamespace: "ghl_inbound_message",
          eventKey: `${contact.id}:${channel}:${inboundOccurrenceId}:${withdrawalChannel}`,
          source: "ghl_inbound_message",
          evidence: { channel, withdrawalChannel, messageId: payload.id ?? payload.messageId ?? null, inboundOccurrenceId },
        })));
        await storage.createAuditLog({
          action: "contact_unsubscribed",
          entityType: "contact",
          entityId: contact.id,
          details: { source: "ghl_inbound_message", channel },
        });

      }

      if (messageClassification.intent === "positive_reply" && contactDeal) {
        if (["New Lead", "Contacted"].includes(contactDeal.stage)) {
          const { advanceDealStage } = await import("./deal-stage-service");
          await advanceDealStage(contactDeal.id, "Engaged", "ghl_inbound_interested");
          await storage.createAuditLog({
            action: "deal_auto_progressed",
            entityType: "deal",
            entityId: contactDeal.id,
            details: { from: contactDeal.stage, to: "Engaged", reason: "inbound_reply" },
          });
        }
      }

      if (messageClassification.intent === "support" || messageClassification.intent === "question") {
        await storage.createAuthorityTask({
          title: `Follow up: ${contact.firstName} ${contact.lastName} - ${messageClassification.intent}`,
          assignedTo: contactDeal?.owner || "Unassigned",
          priority: messageClassification.priority === "high" ? "high" : "medium",
          dueDate: new Date(Date.now() + 4 * 60 * 60 * 1000),
          dealId: contactDeal?.id,
          contactId: contact.id,
        });
      }

      if (messageClassification.intent === "booking_intent") {
        await storage.createAuthorityTask({
          title: `CALLBACK REQUEST: ${contact.firstName} ${contact.lastName}`,
          assignedTo: contactDeal?.owner || "Unassigned",
          priority: "high",
          dueDate: new Date(Date.now() + 1 * 60 * 60 * 1000),
          dealId: contactDeal?.id,
          contactId: contact.id,
        });
      }

      // ── Reply-stop: ANY inbound reply pauses active sequence enrollments ──────────────────
      // unsubscribe already called pauseAllActiveEnrollments above; this ensures ALL other
      // intents (positive_reply, booking_intent, question, support, objection, neutral) also
      // pause so prospects aren't double-touched by automation while a rep handles the reply.
      if (messageClassification.intent !== "unsubscribe") {
        const pausedCount = await storage.pauseAllActiveEnrollments(contact.id);
        if (pausedCount > 0) {
          await storage.createAuditLog({
            action: "enrollments_paused_on_reply",
            entityType: "contact",
            entityId: contact.id,
            details: {
              source: "ghl_inbound_message",
              channel,
              intent: messageClassification.intent,
              pausedCount,
            },
          });
        }
        // Create a rep review task for intents that don't already create one above
        const taskAlreadyCreated = ["support", "question", "booking_intent"].includes(
          messageClassification.intent
        );
        if (!taskAlreadyCreated && messageClassification.intent !== "neutral") {
          await storage.createAuthorityTask({
            title: `Review inbound reply: ${contact.firstName} ${contact.lastName} — ${messageClassification.intent}`,
            assignedTo: contactDeal?.owner || "Unassigned",
            priority: messageClassification.priority === "high" ? "high" : "medium",
            dueDate: new Date(Date.now() + 4 * 60 * 60 * 1000),
            dealId: contactDeal?.id,
            contactId: contact.id,
          });
        }
      }

      try {
        const { triggerWorkflowsByEvent } = await import("./workflow-executor");
        await triggerWorkflowsByEvent("inbound_message", {
          entityType: "contact",
          entityId: contact.id,
          data: { channel, body, subject, classification: messageClassification },
        });
      } catch (e) {
        console.error("[GHL Webhook] Workflow trigger error:", e);
      }

      await storage.createAuditLog({
        action: "inbound_message_processed",
        entityType: "contact",
        entityId: contact.id,
        details: {
          channel,
          classification: messageClassification,
          dealId: contactDeal?.id,
          messagePreview: (body || "").substring(0, 100),
        },
      });

      try {
        const autoReplyResult = await sendAiAutoReply({
          contact,
          deal: contactDeal,
          channel,
          inboundMessage: body || "",
          classification: messageClassification,
        });
        if (autoReplyResult.sent) {
          console.log(`[GHL Webhook] AI auto-reply sent to ${contact.firstName} ${contact.lastName} via ${channel}`);
        } else {
          console.log(`[GHL Webhook] AI auto-reply skipped: ${autoReplyResult.error}`);
        }
      } catch (autoReplyErr: any) {
        console.error("[GHL Webhook] AI auto-reply error:", autoReplyErr.message);
      }
    }
  }

  // ── Wave 7: GHL-native opt-out / DND event hardening ────────────────────
  // These events arrive when GHL workflows, native SMS STOP, or email
  // unsubscribe actions fire WITHOUT going through our inbound-message path.
  // We must honour them to prevent the "GHL auth bypass" kill line.

  const isDndEvent = type === "ContactDNDUpdated" || type === "contact-dnd-updated";
  const isEmailUnsub = type === "EmailUnsubscribed" || type === "email-unsubscribed" || type === "ContactEmailUnsubscribed";
  const isSmsDnd = type === "SMSDNDUpdated" || type === "sms-dnd-updated";

  if ((isDndEvent || isEmailUnsub || isSmsDnd) && contactId) {
    const contact = await storage.getContactByGhlContactId(contactId);

    if (!contact) {
      // Log evidence — do NOT silently drop; helps find GHL-only contacts
      console.warn(`[GHL Webhook] ${type}: no matching local contact for GHL ID ${contactId}`);
      await storage.createAuditLog({
        action: "ghl_optout_contact_not_found",
        entityType: "contact",
        details: { source: "ghl_webhook", eventType: type, ghlContactId: contactId, reason: "contact_not_found" },
      }).catch(() => {});
      // Also write to ghlActivityLog (contactId nullable) for activity-log-based monitoring
      await storage.createGhlActivityLog({
        contactId: undefined as any,
        dealId: null,
        direction: "inbound",
        channel: "opt_out_warning",
        templateId: null,
        subject: type,
        body: null,
        status: "unmatched",
        ghlMessageId: contactId,
        metadata: { eventType: type, ghlContactId: contactId, reason: "contact_not_found", source: "ghl_webhook" },
      }).catch(() => {});
    } else {
      const updatePayload: Record<string, any> = {};

      if (isDndEvent) {
        const emailDnd = payload.dndSettings?.email?.status === "active";
        const smsDnd = payload.dndSettings?.sms?.status === "active";
        const globalDnd = payload.dnd === true || payload.isDnd === true || (!emailDnd && !smsDnd && Object.keys(payload.dndSettings || {}).length === 0);

        if (emailDnd || smsDnd || globalDnd) {
          // Conservative global suppression for any DND event
          updatePayload.doNotAutoContact = true;
          if (globalDnd || (emailDnd && smsDnd)) {
            // Full global DND — suppress everything
            updatePayload.doNotContact = true;
            updatePayload.consentTier = "opted_out";
            updatePayload.consentEmail = false;
            updatePayload.consentSms = false;
            updatePayload.emailStatus = "opted_out";
            updatePayload.smsStatus = "opted_out";
          } else {
            if (emailDnd) {
              updatePayload.consentEmail = false;
              updatePayload.emailStatus = "opted_out";
            }
            if (smsDnd) {
              updatePayload.consentSms = false;
              updatePayload.smsStatus = "opted_out";
            }
          }
        }
      }

      if (isEmailUnsub) {
        updatePayload.doNotAutoContact = true;
        updatePayload.consentEmail = false;
        updatePayload.emailStatus = "opted_out";
        // Email unsub does not necessarily set global DNC — only email channel
      }

      if (isSmsDnd) {
        const smsDndActive = payload.dnd === true || payload.isDnd === true || payload.status === "active";
        if (smsDndActive) {
          updatePayload.doNotAutoContact = true;
          updatePayload.consentSms = false;
          updatePayload.smsStatus = "opted_out";
        }
      }

      if (Object.keys(updatePayload).length > 0) {
        const eventFingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
        const commands: Array<Promise<unknown>> = [];
        // Only an explicit contact-wide DND may create global suppression.
        // SMSDNDUpdated sets doNotAutoContact for compatibility, not doNotContact.
        const isExplicitGlobalDnd = updatePayload.doNotContact === true;
        if (isExplicitGlobalDnd) {
          commands.push(applyConsentCommand({
            subject: { type: "contact", id: contact.id },
            kind: "global_dnc",
            purpose: "outreach",
            eventNamespace: "ghl_inbound_dnd",
            eventKey: `${contact.id}:${type}:${eventFingerprint}:global`,
            source: "ghl_webhook",
            evidence: { eventType: type, providerPayload: payload },
            details: { eventType: type },
          }));
        } else {
          if (updatePayload.emailStatus === "opted_out") {
            commands.push(applyConsentCommand({
              subject: { type: "contact", id: contact.id },
              kind: "opt_out",
              channel: "email",
              purpose: "outreach",
              eventNamespace: "ghl_inbound_dnd",
              eventKey: `${contact.id}:${type}:${eventFingerprint}:email`,
              source: "ghl_webhook",
              evidence: { eventType: type, providerPayload: payload },
              details: { eventType: type },
            }));
          }
          if (updatePayload.smsStatus === "opted_out") {
            commands.push(applyConsentCommand({
              subject: { type: "contact", id: contact.id },
              kind: "opt_out",
              channel: "sms",
              purpose: "outreach",
              eventNamespace: "ghl_inbound_dnd",
              eventKey: `${contact.id}:${type}:${eventFingerprint}:sms`,
              source: "ghl_webhook",
              evidence: { eventType: type, providerPayload: payload },
              details: { eventType: type },
            }));
            commands.push(applyConsentCommand({
              subject: { type: "contact", id: contact.id },
              kind: "opt_out",
              channel: "automated_phone",
              purpose: "outreach",
              eventNamespace: "ghl_inbound_dnd",
              eventKey: `${contact.id}:${type}:${eventFingerprint}:automated_phone`,
              source: "ghl_webhook",
              evidence: { eventType: type, providerPayload: payload, channel: "automated_phone" },
              details: { eventType: type },
            }));
          }
        }
        await Promise.all(commands);
        await storage.pauseAllActiveEnrollments(contact.id);
        await storage.createAuditLog({
          action: "contact_dnd_set",
          entityType: "contact",
          entityId: contact.id,
          details: { source: "ghl_webhook", eventType: type, updatePayload },
        });
        console.log(`[GHL Webhook] ${type}: suppression applied to contact ${contact.id} (${contact.email}):`, Object.keys(updatePayload));
      }
    }
    return;
  }

  if (type === "unsubscribe" && contactId) {
    const contact = await storage.getContactByGhlContactId(contactId);
    if (contact) {
      await applyConsentCommand({
        subject: { type: "contact", id: contact.id },
        kind: "global_dnc",
        purpose: "outreach",
        eventNamespace: "ghl_inbound_unsubscribe",
        eventKey: `${contact.id}:unsubscribe:${webhookOccurrenceId}`,
        source: "ghl_webhook",
        evidence: { eventType: type, ghlContactId: contactId, webhookOccurrenceId },
        details: { eventType: type, ghlContactId: contactId, webhookOccurrenceId },
      });
      await storage.pauseAllActiveEnrollments(contact.id);
      await storage.createAuditLog({
        action: "contact_unsubscribed",
        entityType: "contact",
        entityId: contact.id,
        details: { source: "ghl_webhook", eventType: type },
      });
    }
  }
}

const recentAutoReplies = new Map<string, number>();
const outboundMessageIds = new Set<string>();

function trackOutboundMessageId(messageId: string) {
  if (!messageId) return;
  outboundMessageIds.add(messageId);
  setTimeout(() => outboundMessageIds.delete(messageId), 30 * 60 * 1000);
}

function isOurOutboundMessage(messageId: string): boolean {
  return messageId ? outboundMessageIds.has(messageId) : false;
}

async function hasRecentAutoReply(contactId: number, channel: string): Promise<boolean> {
  const key = `${contactId}_${channel}`;
  const lastReply = recentAutoReplies.get(key);
  if (lastReply && Date.now() - lastReply < 5 * 60 * 1000) {
    return true;
  }
  const logs = await storage.getGhlActivityLogs(contactId);
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  return logs.some(l =>
    l.direction === "outbound" &&
    l.channel === channel &&
    l.status === "sent" &&
    l.createdAt && new Date(l.createdAt) > fiveMinAgo &&
    l.metadata && (l.metadata as any).autoReply === true
  );
}

function markAutoReplySent(contactId: number, channel: string) {
  recentAutoReplies.set(`${contactId}_${channel}`, Date.now());
  setTimeout(() => recentAutoReplies.delete(`${contactId}_${channel}`), 5 * 60 * 1000);
}

async function generateAiAutoReply(params: {
  contact: Contact;
  deal: Deal | undefined;
  channel: "email" | "sms";
  inboundMessage: string;
  classification: { intent: string; priority: string; keywords: string[] };
}): Promise<{ subject?: string; body: string } | null> {
  const { contact, deal, channel, inboundMessage, classification } = params;

  const noReplyIntents = ["unsubscribe", "booking_intent", "neutral"];
  if (noReplyIntents.includes(classification.intent)) return null;

  if (contact.doNotContact) return null;

  if (channel === "sms" && !contact.consentSms) return null;

  if (await hasRecentAutoReply(contact.id, channel)) {
    console.log(`[AI Auto-Reply] Skipped: recent auto-reply already sent to contact ${contact.id} via ${channel}`);
    return null;
  }

  const isSms = channel === "sms";

  const systemPrompt = `You are a professional sales advisor for Liberty Bancard, a merchant payment processing company. Generate a helpful, compliant reply to an inbound ${channel} message from a business prospect.

RULES:
- Be warm, professional, and helpful
- NEVER make specific savings promises (like "save 30%") — use phrases like "many merchants find significant savings" or "we typically help businesses reduce processing costs"
- NEVER provide legal, tax, or PCI compliance advice
- NEVER ask for sensitive card data or bank account numbers
- Always include a clear next step (schedule a call, send a statement for review, etc.)
- If they asked a pricing question, explain that pricing depends on their specific processing profile and offer a free statement analysis
- Keep the tone conversational but professional
${isSms ? "- Keep response under 300 characters for SMS" : "- Keep response concise but thorough for email"}
- Sign off as "Liberty Bancard Team"

COMPLIANCE DISCLAIMER (must be included in every reply):
${isSms ? "Msg&data rates may apply. Reply STOP to opt out." : "This message is from Liberty Bancard. If you no longer wish to receive communications, please reply STOP or contact us to be removed from our list."}`;

  const contactContext = `Contact: ${contact.firstName} ${contact.lastName}
Company: ${contact.companyName || "Not specified"}
Industry: ${contact.vertical || "Not specified"}
Current Provider: ${contact.currentProvider || "Not specified"}
Monthly Volume: ${contact.monthlyVolume || "Not specified"}
Deal Stage: ${deal?.stage || "No active deal"}
Message Intent: ${classification.intent}
Message Keywords: ${classification.keywords.join(", ")}`;

  const slot = await checkAiGate("gpt-4o-mini");
  let completion;
  try {
    completion = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${contactContext}\n\nInbound message:\n"${inboundMessage}"\n\nGenerate a ${channel} reply. ${isSms ? "Keep it under 300 characters." : "Include a subject line on the first line prefixed with 'Subject: ' followed by the body."}` }
      ],
      max_tokens: isSms ? 150 : 500,
      temperature: 0.7,
    });
  } catch (providerErr) {
    slot.refund();
    throw providerErr;
  }

  try {
    slot.settle(recordAiSpend("gpt-4o-mini", completion.usage?.prompt_tokens ?? 0, completion.usage?.completion_tokens ?? 0, "ghl-reply"));
    const raw = completion.choices[0]?.message?.content?.trim() || "";
    if (!raw) return null;

    if (isSms) {
      const smsDisclaimer = "\nMsg&data rates may apply. Reply STOP to opt out.";
      const hasDisclaimer = raw.toLowerCase().includes("reply stop");
      if (hasDisclaimer) {
        const smsBody = raw.length > 300 ? raw.substring(0, 297) + "..." : raw;
        return { body: smsBody };
      }
      const maxContent = 300 - smsDisclaimer.length;
      const content = raw.length > maxContent ? raw.substring(0, maxContent - 3) + "..." : raw;
      return { body: content + smsDisclaimer };
    }

    const emailDisclaimer = "\n\nThis message is from Liberty Bancard. If you no longer wish to receive communications, please reply STOP or contact us to be removed from our list.";
    const subjectMatch = raw.match(/^Subject:\s*(.+?)[\n\r]/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : `Re: Your inquiry — Liberty Bancard`;
    let emailBody = subjectMatch ? raw.replace(/^Subject:\s*.+?[\n\r]+/i, "").trim() : raw;
    if (!emailBody.toLowerCase().includes("no longer wish to receive") && !emailBody.toLowerCase().includes("reply stop")) {
      emailBody += emailDisclaimer;
    }

    return { subject, body: emailBody };
  } catch (err: any) {
    console.error("[AI Auto-Reply] Generation failed:", err.message);
    return null;
  }
}

export async function sendAiAutoReply(params: {
  contact: Contact;
  deal: Deal | undefined;
  channel: "email" | "sms";
  inboundMessage: string;
  classification: { intent: string; priority: string; keywords: string[] };
}): Promise<{ sent: boolean; error?: string }> {
  try {
    if (!isGhlConfigured()) {
      return { sent: false, error: "GHL not configured" };
    }

    const reply = await generateAiAutoReply(params);
    if (!reply) {
      return { sent: false, error: "No reply generated (intent filtered or generation failed)" };
    }

    let result: { success: boolean; messageId?: string; error?: string };

    if (params.channel === "email") {
      result = await sendGhlEmail({
        contactId: params.contact.id,
        dealId: params.deal?.id,
        subject: reply.subject || "Re: Your inquiry — Liberty Bancard",
        body: reply.body,
      });
    } else {
      result = await sendGhlSms({
        contactId: params.contact.id,
        dealId: params.deal?.id,
        body: reply.body,
      });
    }

    if (result.success) {
      markAutoReplySent(params.contact.id, params.channel);

      await storage.createGhlActivityLog({
        contactId: params.contact.id,
        dealId: params.deal?.id || null,
        direction: "outbound",
        channel: params.channel,
        templateId: null,
        subject: params.channel === "email" ? (reply.subject || "Re: Your inquiry") : null,
        body: reply.body,
        status: "sent",
        ghlMessageId: result.messageId || null,
        metadata: { autoReply: true, intent: params.classification.intent },
      });

      await storage.createAuditLog({
        action: "ai_auto_reply_sent",
        entityType: "contact",
        entityId: params.contact.id,
        details: {
          channel: params.channel,
          intent: params.classification.intent,
          dealId: params.deal?.id,
          replyPreview: reply.body.substring(0, 150),
          messageId: result.messageId,
        },
      });

      await storage.createNotification({
        channel: "internal",
        title: `AI Auto-Reply Sent to ${params.contact.firstName} ${params.contact.lastName}`,
        message: `${params.channel.toUpperCase()} reply sent for "${params.classification.intent}" message. Preview: ${reply.body.substring(0, 100)}...`,
        type: "info",
        metadata: {
          contactId: params.contact.id,
          dealId: params.deal?.id,
          autoReply: true,
        },
      });
    } else {
      await storage.createAuditLog({
        action: "ai_auto_reply_failed",
        entityType: "contact",
        entityId: params.contact.id,
        details: {
          channel: params.channel,
          intent: params.classification.intent,
          error: result.error,
        },
      });
    }

    return { sent: result.success, error: result.error };
  } catch (err: any) {
    console.error("[AI Auto-Reply] Error:", err.message);
    return { sent: false, error: err.message };
  }
}

export async function sendDocumentForEsign(opts: {
  documentTemplateId: string;
  contactId?: string;
  recipientName: string;
  recipientEmail: string;
  applicationId: number;
}): Promise<{ success: boolean; documentId?: string; signingUrl?: string; error?: string }> {
  // ── Unavoidable pause authority gate (transport boundary) ──────────────────
  // Document send delivers a recipient-facing email via GHL — must clear the
  // canonical pause authority before any network I/O.
  try {
    const { authorize, recheckEpoch } = await import("./outbound-pause-authority");
    const { registerInflight, deregisterInflight } = await import("./outbound-control-service");
    const decision = await authorize({});
    if (!decision.allowed) {
      console.warn(`[GHL E-Sign] Blocked by pause authority: ${decision.reasonCode}`);
      return { success: false, error: `Outbound paused: ${decision.reasonCode}` };
    }
    const token = crypto.randomUUID();
    await registerInflight(token, decision.epoch);
    try {
      const epochOk = await recheckEpoch(decision.epoch);
      if (!epochOk) {
        return { success: false, error: "Outbound paused: epoch changed before document send" };
      }
      const config = getConfig();
      if (!config) {
        return { success: false, error: "GHL not configured. Set GHL_API_KEY and GHL_LOCATION_ID." };
      }

      const payload: Record<string, any> = {
        locationId: config.locationId,
        templateId: opts.documentTemplateId,
        name: `Merchant Processing Agreement - ${opts.recipientName}`,
        recipients: [
          {
            name: opts.recipientName,
            email: opts.recipientEmail,
            role: "signer",
          },
        ],
        emailSettings: {
          subject: "Liberty Bancard - Merchant Processing Agreement for E-Signature",
          fromName: "Liberty Bancard",
        },
      };

      if (opts.contactId) {
        payload.contactId = opts.contactId;
      }

      const result = await ghlFetch("/documents/", {
        method: "POST",
        body: JSON.stringify(payload),
        pauseEpoch: decision.epoch,
      });

      return {
        success: true,
        documentId: result?.id || result?.documentId,
        signingUrl: result?.signingUrl || result?.publicUrl || null,
      };
    } finally {
      deregisterInflight(token);
    }
  } catch (err: any) {
    console.error("[GHL E-Sign] Error sending document:", err.message);
    return { success: false, error: err.message };
  }
}

export async function getDocumentStatus(documentId: string): Promise<{
  status: string;
  signedAt?: string;
  error?: string;
}> {
  try {
    const result = await ghlFetch(`/documents/${documentId}`, { method: "GET" });
    return {
      status: result?.status || "unknown",
      signedAt: result?.completedAt || result?.signedAt,
    };
  } catch (err: any) {
    console.error("[GHL E-Sign] Error checking document status:", err.message);
    return { status: "error", error: err.message };
  }
}

export async function createGhlTask(params: {
  contactId: string;
  title: string;
  dueDate?: Date;
  description?: string;
  taskType?: "FOLLOW_UP" | "EMAIL" | "CALL";
  assignedTo?: string;
}): Promise<{ success: boolean; taskId?: string; error?: string }> {
  try {
    if (!isGhlConfigured()) return { success: false, error: "GHL not configured" };
    const dueDate = params.dueDate || new Date(Date.now() + 24 * 60 * 60 * 1000);
    // GHL Tasks API (v1/v2) only accepts: title, dueDate, assignedTo, completed.
    // Sending description / status / taskType causes 422 "Unprocessable Entity".
    const body: Record<string, unknown> = {
      title: params.title,
      dueDate: dueDate.toISOString(),
      completed: false,
    };
    if (params.assignedTo) body.assignedTo = params.assignedTo;
    const result = await ghlFetch(`/contacts/${params.contactId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { success: true, taskId: result?.id };
  } catch (err: any) {
    console.error("[GHL] createGhlTask failed:", err.message);
    return { success: false, error: err.message };
  }
}

async function handleContactUpdated(payload: any): Promise<void> {
  try {
    const contactData = payload.contact || payload;
    const ghlContactId = contactData.id || payload.contactId;

    if (!ghlContactId) return;

    const { syncContactFromGhl } = await import("./ghl-sync");
    // Use ?? not || so that explicit empty string from GHL is preserved.
    // For camelCase vs snake_case field names, prefer camelCase if present, fall back to
    // snake_case only when camelCase is undefined (not just falsy).
    const syncPayload: {
      id: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      companyName?: string;
      tags?: string[];
    } = { id: ghlContactId };
    const firstName = contactData.firstName !== undefined ? contactData.firstName : contactData.first_name;
    const lastName = contactData.lastName !== undefined ? contactData.lastName : contactData.last_name;
    const companyName = contactData.companyName !== undefined ? contactData.companyName : contactData.company_name;
    if (firstName !== undefined) syncPayload.firstName = firstName ?? "";
    if (lastName !== undefined) syncPayload.lastName = lastName ?? "";
    if (contactData.email !== undefined) syncPayload.email = contactData.email ?? "";
    if (contactData.phone !== undefined) syncPayload.phone = contactData.phone ?? "";
    if (companyName !== undefined) syncPayload.companyName = companyName ?? "";
    // Only pass tags when explicitly present in payload; omitting prevents accidental empty-array replace
    if (Array.isArray(contactData.tags)) syncPayload.tags = contactData.tags;
    const result = await syncContactFromGhl(syncPayload);

    if (result) {
      console.log(`[GHL Webhook] Contact ${result.created ? "created" : "updated"} from GHL: ${result.contactId}`);
    }
  } catch (err: any) {
    console.error("[GHL Webhook] Error handling contact update:", err.message);
  }
}

async function handleOpportunityUpdated(payload: any): Promise<void> {
  try {
    const { syncDealFromGhl, syncActivityFromGhl } = await import("./ghl-sync");
    const opportunityData = payload.opportunity || payload;
    const ghlContactId = opportunityData.contactId || opportunityData.contact?.id;

    if (opportunityData.id) {
      const result = await syncDealFromGhl(opportunityData);
      if (result) {
        console.log(`[GHL Webhook] Opportunity updated: deal ${result.dealId} (${result.created ? "created" : "updated"})`);
      }
    }

    if (ghlContactId) {
      await syncActivityFromGhl({
        contactId: ghlContactId,
        type: "opportunity_updated",
        channel: "sync",
        body: `Opportunity "${opportunityData.name || ""}" updated. Status: ${opportunityData.status || "unknown"}`,
        subject: "Opportunity Updated",
      });
    }
  } catch (err: any) {
    console.error("[GHL Webhook] Error handling opportunity update:", err.message);
  }
}

async function handleTaskUpdated(payload: any): Promise<void> {
  try {
    const taskData = payload.task || payload;
    const ghlContactId = taskData.contactId || payload.contactId;

    if (!ghlContactId) return;

    const { syncTaskFromGhl } = await import("./ghl-sync");
    await syncTaskFromGhl(taskData, ghlContactId);
    console.log(`[GHL Webhook] Task synced/updated from GHL for contact ${ghlContactId}`);
  } catch (err: any) {
    console.error("[GHL Webhook] Error handling task update:", err.message);
  }
}

async function handleTaskCompleted(payload: any): Promise<void> {
  try {
    const taskData = payload.task || payload;
    const ghlContactId = taskData.contactId || payload.contactId;

    if (!ghlContactId) return;

    const { syncTaskFromGhl, syncActivityFromGhl } = await import("./ghl-sync");
    await syncTaskFromGhl(
      { ...taskData, completed: true },
      ghlContactId
    );

    await syncActivityFromGhl({
      contactId: ghlContactId,
      type: "task_completed",
      channel: "sync",
      body: `Task "${taskData.title || ""}" completed`,
      subject: "Task Completed",
    });
  } catch (err: any) {
    console.error("[GHL Webhook] Error handling task completed:", err.message);
  }
}

async function handleNoteAdded(payload: any): Promise<void> {
  try {
    const noteData = payload.note || payload;
    const ghlContactId = noteData.contactId || payload.contactId;
    const ghlNoteId = noteData.id || payload.noteId;

    if (!ghlContactId) return;

    const { data: contacts } = await storage.getContacts({ limit: 500 });
    const contact = contacts.find(c => c.ghlContactId === ghlContactId);
    if (!contact) return;

    const noteContent = noteData.body || noteData.content || "Note from GHL";

    if (ghlNoteId) {
      const existingNotes = await storage.getNotes("contact", contact.id);
      const alreadySynced = existingNotes.some(n =>
        n.authorName === "GHL Sync" &&
        n.content === noteContent
      );
      if (alreadySynced) {
        console.log(`[GHL Webhook] Note already exists for contact ${contact.id}, skipping duplicate`);
        return;
      }
    }

    await storage.createNote({
      entityType: "contact",
      entityId: contact.id,
      content: noteContent,
      authorName: "GHL Sync",
    });

    const { syncActivityFromGhl } = await import("./ghl-sync");
    await syncActivityFromGhl({
      contactId: ghlContactId,
      type: "note_added",
      channel: "sync",
      body: noteContent,
      subject: "Note Added",
    });

    console.log(`[GHL Webhook] Note synced from GHL for contact ${contact.id}`);
  } catch (err: any) {
    console.error("[GHL Webhook] Error handling note added:", err.message);
  }
}

async function handleTagAdded(payload: any): Promise<void> {
  try {
    const ghlContactId = payload.contactId || payload.contact?.id;
    const tags = payload.tags || (payload.tag ? [payload.tag] : []);

    if (!ghlContactId || tags.length === 0) return;

    const { syncTagsFromGhl } = await import("./ghl-sync");
    await syncTagsFromGhl(ghlContactId, tags);
    console.log(`[GHL Webhook] Tags added from GHL: ${tags.join(", ")}`);

    // ── Auto-enrollment triggers based on GHL tag events ───────────────────
    // No-Show Recovery: when GHL calendar fires LB-NO-SHOW, auto-enroll
    if (tags.some((t: string) => t === "LB-NO-SHOW")) {
      autoEnrollNoShowRecovery(ghlContactId).catch(err =>
        console.error("[GHL Webhook] No-show auto-enroll error:", err.message)
      );
    }

    // DNC: when LB-DNC is added from GHL side, mark contact do-not-contact
    if (tags.some((t: string) => t === "LB-DNC")) {
      const tagOccurrenceId = String(payload.eventId ?? payload.id ?? payload.messageId ?? crypto.randomUUID());
      autoDncContact(ghlContactId, tagOccurrenceId).catch(err =>
        console.error("[GHL Webhook] DNC auto-flag error:", err.message)
      );
    }
  } catch (err: any) {
    console.error("[GHL Webhook] Error handling tag added:", err.message);
  }
}

async function autoEnrollNoShowRecovery(ghlContactId: string): Promise<void> {
  const { storage } = await import("../storage");
  const { data: contacts } = await storage.getContacts({ limit: 1000 });
  const contact = contacts.find((c: { ghlContactId?: string | null }) => c.ghlContactId === ghlContactId);
  if (!contact) {
    console.warn(`[GHL Webhook] No-show tag received for unknown GHL contact: ${ghlContactId}`);
    return;
  }
  if (contact.doNotContact) {
    console.log(`[GHL Webhook] No-show: contact ${contact.id} is DNC — skipping enrollment`);
    return;
  }
  const sequences = await (storage as any).getSequences();
  const seq = sequences.find((s: { name: string }) =>
    s.name === "SDR: No-Show Recovery" || s.name === "No-Show Reschedule"
  );
  if (!seq) {
    console.warn("[GHL Webhook] No-show: could not find 'SDR: No-Show Recovery' sequence in DB — skipping enrollment");
    return;
  }
  const { enrollContactInGhlWorkflow } = await import("./ghl-workflow-enrollment");
  const result = await enrollContactInGhlWorkflow({
    contactId: contact.id,
    sequenceName: seq.name,
    sequenceId: seq.id,
    outboundChannels: ["email"],
  });
  console.log(`[GHL Webhook] No-show auto-enrolled contact ${contact.id} — method: ${result.method}, enrolled: ${result.enrolled}`);
}

async function autoDncContact(ghlContactId: string, occurrenceId: string): Promise<void> {
  const { storage } = await import("../storage");
  const contact = await storage.getContactByGhlContactId(ghlContactId);
  if (!contact) return;
  await applyConsentCommand({
    subject: { type: "contact", id: contact.id },
    kind: "global_dnc",
    purpose: "outreach",
    eventNamespace: "ghl_dnc_tag",
    eventKey: `${contact.id}:${ghlContactId}:dnc:${occurrenceId}`,
    source: "ghl_webhook",
    evidence: { ghlContactId, occurrenceId, source: "dnc_tag" },
  });
  console.log(`[GHL Webhook] DNC auto-flagged contact ${contact.id} (${contact.email}) from GHL tag`);
}

async function handleTagRemoved(payload: any): Promise<void> {
  try {
    const ghlContactId = payload.contactId || payload.contact?.id;
    const tags = payload.tags || (payload.tag ? [payload.tag] : []);

    if (!ghlContactId || tags.length === 0) return;

    const { removeTagsFromLocal } = await import("./ghl-sync");
    await removeTagsFromLocal(ghlContactId, tags);
    console.log(`[GHL Webhook] Tags removed from GHL: ${tags.join(", ")}`);
  } catch (err: any) {
    console.error("[GHL Webhook] Error handling tag removed:", err.message);
  }
}

function classifyInboundMessage(message: string): {
  intent: "positive_reply" | "unsubscribe" | "question" | "support" | "booking_intent" | "objection" | "neutral";
  priority: "high" | "medium" | "low";
  keywords: string[];
} {
  const lower = message.toLowerCase();
  const keywords: string[] = [];

  const unsubWords = ["unsubscribe", "stop", "opt out", "remove me", "do not contact", "take me off", "don't contact", "stop contacting", "stop emailing", "stop texting"];
  const interestWords = ["interested", "tell me more", "sounds good", "let's talk", "sign me up", "ready", "i want", "let's do it", "i'm in", "yes please", "send it over", "want to switch", "looking to switch", "want to learn more", "open to it", "open to switching", "absolutely", "definitely interested", "yes i'm", "yes i am", "count me in", "move forward"];
  const bookingWords = ["call me", "give me a call", "phone me", "call back", "callback", "ring me", "book a call", "book a meeting", "schedule a call", "set up a call", "let's meet", "book a time", "calendar", "when can we talk", "let's schedule", "want to schedule", "set up a meeting", "schedule a meeting", "schedule time", "grab a time", "pick a time", "find a time", "set up a demo", "book a demo", "let's connect", "can we chat", "hop on a call"];
  const objectionWords = ["not interested", "too expensive", "too pricey", "too costly", "way too much", "happy with", "not looking", "already have", "no thanks", "no thank you", "pass", "not now", "maybe later", "do not have time", "don't have time", "not the right time", "can't afford", "not in the budget", "out of budget", "stick with", "staying with", "going to stay", "not ready", "not a good time", "wrong time"];
  const supportWords = ["problem", "issue", "not working", "broken", "help", "complaint", "frustrated", "error", "charge", "refund"];
  const questionWords = ["how much", "what is", "how does", "when can", "pricing", "rates", "cost", "?"];

  for (const w of unsubWords) { if (lower.includes(w)) keywords.push(w); }
  if (keywords.length > 0) return { intent: "unsubscribe", priority: "high", keywords };

  for (const w of bookingWords) { if (lower.includes(w)) keywords.push(w); }
  if (keywords.length > 0) return { intent: "booking_intent", priority: "high", keywords };

  for (const w of objectionWords) { if (lower.includes(w)) keywords.push(w); }
  if (keywords.length > 0) return { intent: "objection", priority: "medium", keywords };

  for (const w of supportWords) { if (lower.includes(w)) keywords.push(w); }
  if (keywords.length > 0) return { intent: "support", priority: "high", keywords };

  for (const w of interestWords) { if (lower.includes(w)) keywords.push(w); }
  if (keywords.length > 0) return { intent: "positive_reply", priority: "medium", keywords };

  for (const w of questionWords) { if (lower.includes(w)) keywords.push(w); }
  if (keywords.length > 0) return { intent: "question", priority: "medium", keywords };

  return { intent: "neutral", priority: "low", keywords: [] };
}
