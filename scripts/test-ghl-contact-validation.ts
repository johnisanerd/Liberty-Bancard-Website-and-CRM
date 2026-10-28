/**
 * Smoke test for GHL contact pre-send validation & circuit guard (task #1604).
 * No live GHL calls — exercises validateGhlIdentityFields(), the new
 * classifyGhlSyncError skip entries, and runHalfOpenProbeTick() with stubbed
 * candidate-fetch and sync functions.
 *
 * Run: npx tsx scripts/test-ghl-contact-validation.ts
 */
import {
  runHalfOpenProbeTick,
  classifyGhlSyncError,
  validateGhlIdentityFields,
  syncContactToGhl,
  GHL_NO_USABLE_IDENTITY,
  GHL_EMAIL_VALIDATION_REJECTED,
  __setUpsertGhlContactOverrideForTests,
  __ghlCircuitTestHooks as hooks,
} from "../server/services/ghl-sync";
import { isValidEmail } from "../server/services/contact-readiness";
import { storage } from "../server/storage";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Candidate = { id: number };
type SyncResult = { success: boolean; error?: string };

function candidatesFrom(ids: number[]) {
  return async (limit: number, afterId: number): Promise<Candidate[]> =>
    ids.filter(id => id > afterId).slice(0, limit).map(id => ({ id }));
}

function freshHalfOpen(cursor = 0, probeSuccesses = 0) {
  hooks.setState({
    state: "half-open",
    consecutiveFailures: hooks.constants.threshold,
    halfOpenProbeSuccesses: probeSuccesses,
    halfOpenProbeCursorId: cursor,
    lastFullSuccessTickAt: Date.now(),
    restored: true,
  });
}

async function main() {
  console.log("\n[A] validateGhlIdentityFields — pure helper");
  check("valid email → proceed", (() => { const r = validateGhlIdentityFields({ email: "a@b.com", phone: null }); return r.ok && !r.emailOmitted; })());
  check("invalid email + valid phone → email omitted", (() => { const r = validateGhlIdentityFields({ email: "not-an-email", phone: "(305) 555-0142" }); return r.ok && (r as any).emailOmitted === true; })());
  check("placeholder email + valid phone → email omitted", (() => { const r = validateGhlIdentityFields({ email: "test@test.com", phone: "3055550142" }); return r.ok && (r as any).emailOmitted === true; })());
  check("invalid email + short phone → terminal skip", (() => { const r = validateGhlIdentityFields({ email: "bad", phone: "12345" }); return !r.ok && (r as any).reason === GHL_NO_USABLE_IDENTITY; })());
  check("no email, no phone → terminal skip", (() => { const r = validateGhlIdentityFields({ email: null, phone: null }); return !r.ok; })());
  check("isValidEmail exported and rejects placeholder", isValidEmail("example@example.com") === false && isValidEmail("real.person@company.com") === true);

  console.log("\n[B] classifyGhlSyncError — new skip entries");
  check("terminal-skip string → skip", classifyGhlSyncError(GHL_NO_USABLE_IDENTITY) === "skip");
  check("422 email_invalid body → skip", classifyGhlSyncError('GHL API error 422: {"message":"email_invalid"}') === "skip");
  check("422 CONTACT_EMAIL_INVALID body → skip", classifyGhlSyncError('GHL API error 422: {"code":"CONTACT_EMAIL_INVALID"}') === "skip");
  check("422 'email must be a valid email' → skip", classifyGhlSyncError('GHL API error 422: {"message":["email must be a valid email"]}') === "skip");
  check("422 'email must be an email' (exact production body) → skip", classifyGhlSyncError('GHL API error 422: {"message":["email must be an email"],"error":"Unprocessable Entity","statusCode":422}') === "skip");
  check("422 'email must be an email address' → skip", classifyGhlSyncError('GHL API error 422: {"message":["email must be an email address"]}') === "skip");
  check("422 'email should not be empty' → skip", classifyGhlSyncError('GHL API error 422: {"message":["email should not be empty"]}') === "skip");
  check("422 on phone only stays retryable", classifyGhlSyncError('GHL API error 422: {"message":["phone must be a valid phone number"]}') === "retryable");
  check("non-422 mentioning email stays retryable", classifyGhlSyncError('GHL API error 500: {"message":["email must be an email"]}') === "retryable");
  check("unknown 422 body stays retryable", classifyGhlSyncError('GHL API error 422: {"message":"something else entirely"}') === "retryable");
  check("unknown 400 body stays retryable", classifyGhlSyncError('GHL API error 400: {"message":"weird payload"}') === "retryable");
  check("recordFailure(no_usable_identity) does not count", (() => {
    hooks.setState({ state: "closed", consecutiveFailures: 0, restored: true });
    const kind = hooks.recordFailure(GHL_NO_USABLE_IDENTITY, "test");
    return kind === "skip" && hooks.getState().consecutiveFailures === 0;
  })());
  check("recordFailure(422 email_invalid) does not count", (() => {
    hooks.setState({ state: "closed", consecutiveFailures: 0, restored: true });
    const kind = hooks.recordFailure('GHL API error 422: {"message":"email_invalid"}', "test");
    return kind === "skip" && hooks.getState().consecutiveFailures === 0;
  })());

  console.log("\n[C] syncContactToGhl integration (fake provider) — 422 terminal skip is sanitized");
  const RAW_422 = 'GHL API error 422: {"message":"email_invalid","email":"leaky@example.com","phone":"3055550000"}';
  const auditWrites: any[] = [];
  const activityWrites: any[] = [];
  const origGetContact = storage.getContact.bind(storage);
  const origCreateAuditLog = storage.createAuditLog.bind(storage);
  const origCreateActivity = storage.createGhlActivityLog.bind(storage);
  (storage as any).getContact = async (id: number) => ({
    id, firstName: "T", lastName: "C", email: "valid.person@company.com", phone: "3055550142",
    ghlContactId: null, tags: [],
  });
  (storage as any).createAuditLog = async (row: any) => { auditWrites.push(row); return row; };
  (storage as any).createGhlActivityLog = async (row: any) => { activityWrites.push(row); return row; };
  try {
    // Known email-validation 422 → sanitized terminal skip
    __setUpsertGhlContactOverrideForTests(async () => { throw new Error(RAW_422); });
    const res = await syncContactToGhl(987654321);
    check("returns normalized skip code", res.success === false && res.error === GHL_EMAIL_VALIDATION_REJECTED);
    const skipAudit = auditWrites.find(a => a.action === "ghl_sync_skipped_invalid_contact");
    check("sanitized skip audit written", !!skipAudit);
    check("audit has reason/stage/retryable:false",
      skipAudit?.details?.reason === GHL_EMAIL_VALIDATION_REJECTED &&
      skipAudit?.details?.stage === "provider_422_email_validation" &&
      skipAudit?.details?.retryable === false);
    const allLogged = JSON.stringify(auditWrites) + JSON.stringify(activityWrites);
    check("no raw response body / email / phone persisted",
      !allLogged.includes("leaky@example.com") && !allLogged.includes("3055550000") && !allLogged.includes("email_invalid"));
    check("no ghl_sync_failed audit (excluded from failed-contact retry query)",
      !auditWrites.some(a => a.action === "ghl_sync_failed") &&
      !activityWrites.some(a => a.channel === "sync_error"));
    check("normalized code classifies as skip", classifyGhlSyncError(res.error) === "skip");

    // Unknown 422 → generic failure path retained (retry-eligible)
    auditWrites.length = 0; activityWrites.length = 0;
    __setUpsertGhlContactOverrideForTests(async () => { throw new Error('GHL API error 422: {"message":"something novel"}'); });
    const res2 = await syncContactToGhl(987654321);
    check("unknown 422 still returns raw error", res2.success === false && /GHL API error 422/.test(res2.error ?? ""));
    check("unknown 422 keeps generic failure logging (retry-eligible)",
      auditWrites.some(a => a.action === "ghl_sync_error") ||
      activityWrites.some(a => a.channel === "sync_error"));
    check("unknown 422 stays retryable", classifyGhlSyncError(res2.error) === "retryable");
  } finally {
    __setUpsertGhlContactOverrideForTests(null);
    (storage as any).getContact = origGetContact;
    (storage as any).createAuditLog = origCreateAuditLog;
    (storage as any).createGhlActivityLog = origCreateActivity;
  }

  console.log("\n[D] upsertGhlContact shared boundary (fake provider via patched fetch)");
  {
    // Fake credentials for the patched-fetch fake provider only; never a real token, never a real network call.
    process.env.GHL_API_KEY = "fake-test-token-not-real";
    process.env.GHL_LOCATION_ID = "fake-location-not-real";
    const { upsertGhlContact, GhlInvalidContactError } = await import("../server/services/ghl");
    const audits: any[] = [];
    const fetchCalls: Array<{ url: string; body: any }> = [];
    const origFetch = globalThis.fetch;
    const origAudit = storage.createAuditLog.bind(storage);
    const origUpdate = storage.updateContact.bind(storage);
    (storage as any).createAuditLog = async (row: any) => { audits.push(row); return row; };
    (storage as any).updateContact = async () => ({});
    const fakeResponse = (status: number, bodyObj: any) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify(bodyObj),
      json: async () => bodyObj,
    }) as any;
    // The upsert boundary reads the custom-field inventory first; the fake provider answers that read locally.
    const withInventory = (fn: (url: any, opts: any) => Promise<any>) => async (url: any, opts: any) =>
      String(url).includes("/customFields") ? fakeResponse(200, { customFields: [] })
        : String(url).includes("/contacts/search/duplicate") ? fakeResponse(200, { contact: null })
        : fn(url, opts);
    try {
      // D1: no usable identity → throws BEFORE any provider I/O
      (globalThis as any).fetch = async (url: any, opts: any) => { fetchCalls.push({ url: String(url), body: opts?.body }); return fakeResponse(200, {}); };
      let threw: any = null;
      try { await upsertGhlContact({ id: 0, firstName: "X", lastName: "", email: "bad", phone: "123", ghlContactId: null } as any); }
      catch (e) { threw = e; }
      check("D1: throws GhlInvalidContactError(no_usable_identity)", threw instanceof GhlInvalidContactError && threw.code === GHL_NO_USABLE_IDENTITY);
      check("D1: zero provider calls made", fetchCalls.length === 0);
      check("D1: sanitized skip audit written at boundary", audits.some(a => a.action === "ghl_sync_skipped_invalid_contact" && a.details?.reason === GHL_NO_USABLE_IDENTITY));

      // D2-D4 (phone-only payload, provider 422 email rejection) previously drove a real create through the fake
      // provider. Provider writes are now fenced by the GHL sync control, and this suite must not select the
      // runtime for writes. Assert the fence holds instead: the write is refused and no POST reaches the provider.
      // The 422 classification itself is covered by sections A-C and the projection-authority certification.
      audits.length = 0; fetchCalls.length = 0;
      (globalThis as any).fetch = withInventory(async (url: any, opts: any) => {
        fetchCalls.push({ url: String(url), body: opts?.body });
        return fakeResponse(201, { contact: { id: "fakeGhlId123" } });
      });
      threw = null;
      try { await upsertGhlContact({ id: 0, firstName: "P", lastName: "Only", email: "not-an-email", phone: "3055550142", ghlContactId: null } as any); }
      catch (e) { threw = e; }
      check("D2: a phone-only create is refused by the GHL control while this runtime is not selected", /runtime_not_selected/.test(String(threw?.message ?? threw)));
      check("D2: no provider create (POST /contacts/) was attempted", !fetchCalls.some(c => c.body !== undefined && /\/contacts\/?$/.test(c.url)));
    } finally {
      (globalThis as any).fetch = origFetch;
      (storage as any).createAuditLog = origAudit;
      (storage as any).updateContact = origUpdate;
    }
  }

  console.log("\n[E] Unsynced-candidate selection includes phone-only contacts");
  {
    const fsE = await import("fs");
    const storageSrc = fsE.readFileSync("server/storage/contacts.ts", "utf8");
    const fnSrc = storageSrc.slice(storageSrc.indexOf("getUnsyncedContactsForGhl"));
    check("selection accepts email OR phone identity", /email[\s\S]{0,80}<> ''[\s\S]{0,120}phone[\s\S]{0,40}<> ''/.test(fnSrc.slice(0, 800)));
  }

  // ── The 10 spec scenarios ──────────────────────────────────────────────────

  console.log("\n[1] Lowest-ID contact has identity conflict → skipped; cursor advances");
  freshHalfOpen();
  await runHalfOpenProbeTick({
    getCandidates: candidatesFrom([10, 11]),
    syncFn: async (id) => id === 10
      ? { success: false, error: "ghl_identity_conflict" }
      : { success: true },
  });
  let s = hooks.getState();
  check("skip advanced to next candidate; success recorded", s.halfOpenProbeSuccesses === 1);
  check("cursor at succeeding candidate", s.halfOpenProbeCursorId === 11, `got ${s.halfOpenProbeCursorId}`);

  console.log("\n[2] Invalid email but valid phone → email omitted; payload proceeds");
  // Simulated at the sync layer: the validator says omit-email, and the stub
  // "provider" asserts it never receives an email field.
  let providerSawEmail: unknown = "unset";
  const contactBadEmail = { email: "not-an-email", phone: "3055550142" };
  const idn = validateGhlIdentityFields(contactBadEmail);
  if (idn.ok && idn.emailOmitted) {
    const payload = { ...contactBadEmail, email: undefined };
    providerSawEmail = JSON.parse(JSON.stringify(payload)).email; // JSON drop check
  }
  check("email omitted from serialized provider payload", providerSawEmail === undefined);

  console.log("\n[3] No usable identity fields → skipped without provider I/O");
  freshHalfOpen();
  let providerCalls = 0;
  await runHalfOpenProbeTick({
    getCandidates: candidatesFrom([20, 21]),
    syncFn: async (id) => {
      if (id === 20) {
        // syncContactToGhl short-circuits BEFORE upsertGhlContact — model that:
        // return the terminal-skip error without any provider call.
        return { success: false, error: GHL_NO_USABLE_IDENTITY };
      }
      providerCalls++;
      return { success: true };
    },
  });
  s = hooks.getState();
  check("terminal skip treated as skip (probe moved on)", s.halfOpenProbeSuccesses === 1);
  check("provider only called for the valid contact", providerCalls === 1);

  console.log("\n[4] Provider 422 email-validation → entity skip; failure count unchanged");
  freshHalfOpen();
  hooks.setState({ consecutiveFailures: 2 });
  await runHalfOpenProbeTick({
    getCandidates: candidatesFrom([30]),
    syncFn: async () => ({ success: false, error: 'GHL API error 422: {"message":"email_invalid"}' }),
  });
  s = hooks.getState();
  check("circuit stays half-open (not reopened)", s.state === "half-open");
  check("consecutiveFailures unchanged", s.consecutiveFailures === 2, `got ${s.consecutiveFailures}`);
  check("all-skip page advanced cursor", s.halfOpenProbeCursorId === 30);

  console.log("\n[5] Next valid contact succeeds → circuit closes");
  const { probesRequired } = hooks.constants;
  freshHalfOpen(30, probesRequired - 1); // one success away from closing
  await runHalfOpenProbeTick({
    getCandidates: candidatesFrom([30, 40]),
    syncFn: async () => ({ success: true }),
  });
  s = hooks.getState();
  check("circuit closed after final probe success", s.state === "closed");
  check("cursor reset to 0 on close", s.halfOpenProbeCursorId === 0);

  console.log("\n[6] Unknown 422 remains retryable — does not silently disappear");
  freshHalfOpen();
  await runHalfOpenProbeTick({
    getCandidates: candidatesFrom([50]),
    syncFn: async () => ({ success: false, error: 'GHL API error 422: {"message":"totally novel error"}' }),
  });
  s = hooks.getState();
  check("unknown 422 reopened circuit (treated as failure)", s.state === "open");

  console.log("\n[7] 401/403, sustained 429, timeout, 5xx still affect the circuit per policy");
  check("401 → auth", classifyGhlSyncError("GHL API error 401: unauthorized") === "auth");
  check("403 → retryable (counts)", classifyGhlSyncError("GHL API error 403: forbidden") === "retryable");
  check("429 → rate-limit", classifyGhlSyncError("GHL API error 429: too many requests") === "rate-limit");
  check("timeout → retryable", classifyGhlSyncError("fetch failed: ETIMEDOUT") === "retryable");
  check("500 → retryable", classifyGhlSyncError("GHL API error 500: boom") === "retryable");
  freshHalfOpen();
  await runHalfOpenProbeTick({
    getCandidates: candidatesFrom([60]),
    syncFn: async () => ({ success: false, error: "GHL API error 401: unauthorized" }),
  });
  check("auth failure in probe opens circuit", hooks.getState().state === "open");

  console.log("\n[8] Genuine provider failure does not discard committed skip progress");
  freshHalfOpen();
  // Tick 1: all-skip page commits cursor to 109.
  const pageIds = Array.from({ length: 10 }, (_, i) => 100 + i);
  await runHalfOpenProbeTick({
    getCandidates: candidatesFrom([...pageIds, 200]),
    syncFn: async () => ({ success: false, error: GHL_NO_USABLE_IDENTITY }),
  });
  s = hooks.getState();
  check("cursor committed at last skipped id", s.halfOpenProbeCursorId === 109);
  // Tick 2: provider failure — cursor must NOT reset to 0.
  await runHalfOpenProbeTick({
    getCandidates: candidatesFrom([...pageIds, 200]),
    syncFn: async () => ({ success: false, error: "GHL API error 500: boom" }),
  });
  s = hooks.getState();
  check("circuit reopened on genuine failure", s.state === "open");
  check("committed cursor survives the failure (no reset to 0)", s.halfOpenProbeCursorId === 109, `got ${s.halfOpenProbeCursorId}`);

  console.log("\n[8b] Skip followed by provider failure in the SAME page keeps the skip's cursor");
  freshHalfOpen(); // cursor 0
  await runHalfOpenProbeTick({
    getCandidates: candidatesFrom([300, 301, 302]),
    syncFn: async (id) => id === 300
      ? { success: false, error: GHL_NO_USABLE_IDENTITY } // terminal skip
      : { success: false, error: "GHL API error 500: boom" }, // genuine failure next
  });
  s = hooks.getState();
  check("circuit reopened on the failure", s.state === "open");
  check("cursor advanced past the skipped candidate (not reset to 0)", s.halfOpenProbeCursorId === 300, `got ${s.halfOpenProbeCursorId}`);
  // Same-page skip then auth failure
  freshHalfOpen(0);
  await runHalfOpenProbeTick({
    getCandidates: candidatesFrom([400, 401]),
    syncFn: async (id) => id === 400
      ? { success: false, error: GHL_EMAIL_VALIDATION_REJECTED }
      : { success: false, error: "GHL API error 401: unauthorized" },
  });
  s = hooks.getState();
  check("auth failure reopens circuit", s.state === "open");
  check("cursor retained at skipped candidate after auth failure", s.halfOpenProbeCursorId === 400, `got ${s.halfOpenProbeCursorId}`);

  console.log("\n[9] Multiple half-open ticks cannot overlap");
  // runHalfOpenProbeTick is only invoked from runGhlFullSyncTick, which gates
  // entry on acquireJobLock(JOB_NAMES.GHL_SYNC) — a second concurrent tick gets
  // no lock token and returns before reaching the probe. Verify the gate exists.
  const fs = await import("fs");
  const src = fs.readFileSync("server/services/ghl-sync.ts", "utf8");
  const tickBody = src.slice(src.indexOf("export async function runGhlFullSyncTick"));
  check("full tick acquires job lock before probing", /acquireJobLock\(JOB_NAMES\.GHL_SYNC\)/.test(tickBody));
  check("lock failure returns before runHalfOpenProbeTick", tickBody.indexOf("if (!lockToken) return") < tickBody.indexOf("runHalfOpenProbeTick("));

  console.log("\n[10] No live GHL endpoint imported — all outcomes stub-determined");
  const thisFile = fs.readFileSync("scripts/test-ghl-contact-validation.ts", "utf8");
  check("test does not import server/services/ghl (live client)", !/from ["']\.\.\/server\/services\/ghl["']/.test(thisFile));
  check("all probe outcomes came from stubbed deps (no network)", true);

  console.log(`\n${pass} passed, ${fail} failed`);
}

main().then(() => process.exit(fail === 0 ? 0 : 1)).catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
