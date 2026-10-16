/**
 * Task #1540A — ZeroBounce batch validation correctness tests.
 *
 * Exercises the PRODUCTION helpers used by the routes in server/routes/contacts.ts:
 *   - UNVALIDATED_EMAIL_PREDICATE / VALID_EMAIL_ELIGIBILITY (candidate SQL)
 *   - resolveZbExplicitCandidates (explicit-ID dedupe + eligibility gate)
 *   - runZbValidationBatch (the batch loop itself, with injected fake provider)
 *   - isPlaceholderEmail / isRetryableZbFailure
 *
 * NO real ZeroBounce network call is made — verifyEmail and claimCredit are
 * injected fakes that record every call.
 */
import { pool } from "../server/db";
import {
  UNVALIDATED_EMAIL_PREDICATE,
  VALID_EMAIL_ELIGIBILITY,
  isPlaceholderEmail,
  isRetryableZbFailure,
  resolveZbExplicitCandidates,
  runZbValidationBatch,
} from "../server/routes/contacts";
import type { ZeroBounceResult } from "../server/services/sdr/zerobounce";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`); }
}

const TAG = `zb1540-${Date.now()}`;
const mkEmail = (slug: string) => `${TAG}-${slug}@example-test.com`;
const now = new Date().toISOString();

async function insertContact(
  email: string,
  emailStatus: string | null,
  archived = false,
  validatedAt: Date | null = null,
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO contacts (first_name, last_name, email, phone, email_status, lead_score, archived_at, email_validation_updated_at)
     VALUES ($1, $2, $3, $4, $5, 50, $6, $7) RETURNING id`,
    ["ZB1540", "Test", email,
     `+1555${String(Date.now() + Math.floor(Math.random() * 1000000)).slice(-7)}`,
     emailStatus, archived ? new Date() : null, validatedAt],
  );
  return r.rows[0].id;
}

async function getStatus(id: number): Promise<string | null> {
  const r = await pool.query(`SELECT email_status FROM contacts WHERE id = $1`, [id]);
  return r.rows[0]?.email_status ?? null;
}

/** Fake provider: records calls, returns programmed results per email. */
function makeFakeDeps(results: Record<string, ZeroBounceResult>, hasKey = true) {
  const verifyCalls: string[] = [];
  let creditsClaimed = 0;
  const deps = {
    verifyEmail: async (email: string) => {
      verifyCalls.push(email);
      const r = results[email];
      if (!r) throw new Error(`fake verifyEmail: no stub for ${email}`);
      return r;
    },
    claimCredit: async () => { creditsClaimed++; return true; },
    hasProviderKey: () => hasKey,
  };
  return { deps, verifyCalls, credits: () => creditsClaimed };
}

const OK_VALID: ZeroBounceResult  = { status: "valid", provider: "zerobounce", verifiedAt: now, subStatus: null };
const OK_UNSAFE: ZeroBounceResult = { status: "unsafe", provider: "zerobounce", verifiedAt: now, subStatus: "spamtrap" };
const FAIL_HTTP: ZeroBounceResult = { status: "unknown", provider: "zerobounce", verifiedAt: now, reason: "http_500" };
const FAIL_TIMEOUT: ZeroBounceResult = { status: "unknown", provider: "zerobounce", verifiedAt: now, reason: "TimeoutError" };

async function main() {
  const ids: number[] = [];
  try {
    console.log("── Setup ──");
    const emNull = mkEmail("null"), emActive = mkEmail("active"), emUnval = mkEmail("unvalidated");
    const emValid = mkEmail("already-valid"), emArch = mkEmail("archived");
    const emPlaceholder = `no-email-${crypto.randomUUID()}@no-email.libertybancard.internal`;
    const idNull        = await insertContact(emNull, null);
    const idActive      = await insertContact(emActive, "active");
    const idUnvalidated = await insertContact(emUnval, "unvalidated");
    // A real "valid" always carries a validation date; undated "valid" is legacy and now counts as unvalidated.
    const idValid       = await insertContact(emValid, "valid", false, new Date());
    const idArchived    = await insertContact(emArch, "unvalidated", true);
    const idPlaceholder = await insertContact(emPlaceholder, "unvalidated");
    ids.push(idNull, idActive, idUnvalidated, idValid, idArchived, idPlaceholder);

    console.log("── Test 1: candidate filter SQL (same constants as batch route) ──");
    const rows = await pool.query(`
      SELECT id FROM contacts
      WHERE ${VALID_EMAIL_ELIGIBILITY}
        AND (${UNVALIDATED_EMAIL_PREDICATE})
        AND id = ANY($1::int[])
    `, [[...ids]]);
    const candidates = new Set(rows.rows.map((r: any) => r.id));
    check("NULL status contact is a candidate", candidates.has(idNull));
    check("'active' status contact is a candidate", candidates.has(idActive));
    check("'unvalidated' status contact is a candidate (KILL LINE)", candidates.has(idUnvalidated));
    check("'valid' status contact is NOT a candidate", !candidates.has(idValid));
    check("archived contact is NOT a candidate", !candidates.has(idArchived));
    check("placeholder address is NOT a candidate", !candidates.has(idPlaceholder));

    console.log("── Test 2: resolveZbExplicitCandidates (production explicit-ID gate) ──");
    const resolved = await resolveZbExplicitCandidates(
      [idUnvalidated, idUnvalidated, idUnvalidated, idPlaceholder, idArchived, idValid, idActive],
      100,
    );
    check("duplicates collapsed to one entry", resolved.filter((i) => i === idUnvalidated).length === 1);
    check("placeholder excluded from explicit IDs", !resolved.includes(idPlaceholder));
    check("archived excluded from explicit IDs", !resolved.includes(idArchived));
    check("terminal 'valid' allowed for deliberate re-validation", resolved.includes(idValid));
    check("limit respected", (await resolveZbExplicitCandidates([idUnvalidated, idActive], 1)).length === 1);

    console.log("── Test 3: missing provider key — no credits, no writes (production loop) ──");
    const noKey = makeFakeDeps({}, false);
    const r3 = await runZbValidationBatch([idNull, idActive, idUnvalidated], "test", noKey.deps);
    check("all queued counted as retryableErrors", r3.retryableErrors === 3 && r3.processed === 0);
    check("zero credits claimed with missing key", noKey.credits() === 0);
    check("zero provider calls with missing key", noKey.verifyCalls.length === 0);
    check("statuses unchanged (null)", (await getStatus(idNull)) === null);
    check("statuses unchanged (unvalidated)", (await getStatus(idUnvalidated)) === "unvalidated");

    console.log("── Test 4: transport failures leave status unchanged (production loop) ──");
    const f4 = makeFakeDeps({ [emUnval]: FAIL_HTTP, [emActive]: FAIL_TIMEOUT });
    const r4 = await runZbValidationBatch([idUnvalidated, idActive], "test", f4.deps);
    check("both counted retryable, none processed", r4.retryableErrors === 2 && r4.processed === 0 && r4.errors === 0);
    check("email_status still 'unvalidated' after http_500", (await getStatus(idUnvalidated)) === "unvalidated");
    check("email_status still 'active' after timeout", (await getStatus(idActive)) === "active");

    console.log("── Test 5: successful decisions write mapped status (production loop) ──");
    const f5 = makeFakeDeps({ [emUnval]: OK_VALID, [emActive]: OK_UNSAFE });
    const r5 = await runZbValidationBatch([idUnvalidated, idActive], "test", f5.deps);
    check("processed=2, valid=1, blocked=1", r5.processed === 2 && r5.valid === 1 && r5.blocked === 1);
    check("'valid' written", (await getStatus(idUnvalidated)) === "valid");
    check("'unsafe' written", (await getStatus(idActive)) === "unsafe");
    check("one credit claimed per provider call", f5.credits() === 2 && f5.verifyCalls.length === 2);

    console.log("── Test 6: placeholder in work list — no provider call, no credit ──");
    const f6 = makeFakeDeps({});
    const r6 = await runZbValidationBatch([idPlaceholder], "test", f6.deps);
    check("placeholder skipped entirely", r6.processed === 0 && f6.credits() === 0 && f6.verifyCalls.length === 0);
    check("placeholder status unchanged", (await getStatus(idPlaceholder)) === "unvalidated");

    console.log("── Test 7: guard helpers ──");
    check("no_key result is retryable", isRetryableZbFailure({ skipped: true, reason: "no_key" }));
    check("http/timeout/exception results are retryable",
      [FAIL_HTTP, FAIL_TIMEOUT, { reason: "TypeError: fetch failed" }].every(isRetryableZbFailure));
    check("completed 'unknown' decision (no reason) is NOT retryable", !isRetryableZbFailure({ status: "unknown" } as any));
    check("isPlaceholderEmail flags .internal / no-email- / blank",
      isPlaceholderEmail(emPlaceholder) && isPlaceholderEmail("no-email-x@a.com") && isPlaceholderEmail(" ") && !isPlaceholderEmail("owner@business.com"));
  } finally {
    if (ids.length) {
      await pool.query(`DELETE FROM contacts WHERE id = ANY($1::int[])`, [ids]).catch(() => {});
    }
    await pool.end().catch(() => {});
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
