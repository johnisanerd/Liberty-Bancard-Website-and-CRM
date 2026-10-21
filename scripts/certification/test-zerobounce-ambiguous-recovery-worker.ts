import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "zerobounce ambiguous recovery real-worker certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { pool } = await import("../../server/db");
const { prepareCanonicalRecipient } = await import("../../server/services/canonical-recipient-preparation");
const { processValidationIntent } = await import("../../server/services/provider-readiness-control");
const { previewContactBusinessSystemLinks, applyContactBusinessSystemLink } =
  await import("../../server/services/contact-business-system-links");
const recovery = await import("../../server/services/zerobounce-ambiguous-recovery");
const prefix = `cert_zbrec_${randomUUID().replaceAll("-","").slice(0,16)}`;
const actor = { role: "admin" as const, actorId: `system:${prefix}`, email: null };
let checks = 0;
const check = (value: unknown, message: string) => { assert(value, message); checks++; };

await pool.query(`INSERT INTO provider_controls (provider,capability,enabled,circuit_state,local_budget_units,reserved_units,consumed_units,version)
  VALUES('zerobounce','email_validation',TRUE,'closed',100000,0,0,1)
  ON CONFLICT (provider) DO UPDATE SET enabled=TRUE,circuit_state='closed'`);
const programId = randomUUID();
await pool.query(`INSERT INTO sfp_programs (id,name,county_fips,vertical_ids,taxonomy_version,is_active,created_by)
  VALUES($1,$2,ARRAY['12086'],ARRAY['Automotive'],2,TRUE,$3)`, [programId, prefix, actor.actorId]);
const sequenceId = Number((await pool.query(`INSERT INTO follow_up_sequences (name,status,trigger_type,trigger_config)
  VALUES($1,'paused','contact_created',$2::jsonb) RETURNING id`,
  [prefix, JSON.stringify({ canonicalProgramId: programId, canonicalVerticals: ["Automotive"] })])).rows[0].id);

async function fixture() {
  const label = randomUUID().replaceAll("-","");
  const place = `${prefix}_${label}_place`;
  const business = (await pool.query(`INSERT INTO businesses (canonical_name,normalized_name,record_class,google_place_id,vertical,city,state,postal_code)
    VALUES($1,$2,'canonical',$3,'Automotive','Miami','FL','33130') RETURNING *`,
    [`${prefix} ${label}`, `${prefix}${label}`, place])).rows[0];
  await pool.query(`INSERT INTO canonical_source_links (business_id,source_system,source_type,stable_key) VALUES($1,'google_maps','place',$2)`, [business.id, place]);
  const contact = (await pool.query(`INSERT INTO contacts (first_name,last_name,email,phone,company_name,record_class)
    VALUES('Recovery','Fixture',$1,'',$2,'production') RETURNING id`,
    [`${prefix.slice(0,22)}.${label.slice(0,20)}@gmail.com`, `${business.canonical_name} LLC`])).rows[0];
  await pool.query(`INSERT INTO contact_source_events (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata)
    VALUES($1,$2,'import','google_maps_outscraper',$2,'system',$3,$4::jsonb)`,
    [contact.id, `${prefix}_${label}_event`, actor.actorId, JSON.stringify({ place_id: business.google_place_id })]);
  const preview = await previewContactBusinessSystemLinks({ afterContactId: Number(contact.id) - 1, limit: 1 });
  const candidate = preview.rows[0];
  const outcome = await applyContactBusinessSystemLink({ contactId: Number(contact.id), businessId: Number(business.id),
    sourceLinkId: candidate.sourceLinkId!, sourceEntityId: candidate.sourceEntityId, snapshotHash: candidate.snapshotHash });
  assert.equal(outcome.status, "applied");
  const prepared = await prepareCanonicalRecipient({ contactId: Number(contact.id), sequenceId, programId, actor, source: prefix });
  assert.equal(prepared.preparationState, "pending_validation");
  const intent = (await pool.query(`SELECT id,normalized_email_token_hash h FROM validation_intents WHERE contact_id=$1`, [contact.id])).rows[0];
  return { contactId: Number(contact.id), intentId: String(intent.id), hash: String(intent.h) };
}

let calls = 0;
const fake = (result: any) => ({ verifyEmail: async () => { calls++; return result; } });
const TIMEOUT = { status: "unknown", reason: "timeout", outcome: "unavailable" };
const UNKNOWN_COMPLETED = { status: "unknown", outcome: "completed" };
const HTTP_FAIL = { status: "unknown", reason: "http_5xx", outcome: "unavailable" };
const VALID = { provider: "zerobounce", status: "valid", verifiedAt: new Date().toISOString(), outcome: "completed" };

type Fx = Awaited<ReturnType<typeof fixture>>;
async function ambiguate(f: Fx, ageHours: number) {
  const before = calls;
  assert.equal(await processValidationIntent(f.intentId, fake(TIMEOUT) as any), "deferred");
  assert.equal(calls, before + 1);
  const op = (await pool.query(`SELECT operation_id FROM canonical_address_validation_claims WHERE email_token_hash=$1`, [f.hash])).rows[0].operation_id;
  await pool.query(`UPDATE provider_attempts SET dispatch_marked_at=now()-make_interval(hours=>$2),started_at=now()-make_interval(hours=>$2),
    completed_at=now()-make_interval(hours=>$2) WHERE operation_id=$1`, [op, ageHours]);
  await pool.query(`UPDATE canonical_address_validation_claims SET lease_expires_at=now()-interval '1 minute',
    dispatched_at=now()-make_interval(hours=>$2) WHERE email_token_hash=$1`, [f.hash, ageHours]);
  return String(op);
}
async function receipt(f: Fx, ageDays = 1, expiresInSeconds: number | null = null) {
  const op = (await pool.query(`INSERT INTO provider_operations(provider,operation_type,purpose,idempotency_key,actor_type,target_fingerprint,state,requested_units,reserved_units,billing_state)
    VALUES('zerobounce','email_validation','marketing_outreach',$1,'system',$2,'completed',1,1,'committed') RETURNING id`, [`rcpt-${randomUUID()}`, f.hash])).rows[0].id;
  await pool.query(`INSERT INTO provider_observations(provider,operation_id,subject_type,subject_id,email_token_hash,outcome,retryable,observed_at,expires_at)
    VALUES('zerobounce',$1,'contact',$2,$3,'valid',false,now()-make_interval(days=>$4),
      CASE WHEN $5::int IS NULL THEN NULL ELSE now()+make_interval(secs=>$5::int) END)`, [op, f.contactId, f.hash, ageDays, expiresInSeconds]);
  return String(op);
}
const intentRow = async (id: string) => (await pool.query(`SELECT state,terminal_code FROM validation_intents WHERE id=$1`, [id])).rows[0];
const dispatchesSince = async (hash: string) => (await pool.query(`SELECT count(*)::int n FROM zerobounce_ambiguous_recoveries r
  JOIN provider_operations op ON op.target_fingerprint=r.email_token_hash JOIN provider_attempts a ON a.operation_id=op.id
  WHERE r.email_token_hash=$1 AND a.dispatch_marked_at>=r.consumed_at`, [hash])).rows[0].n;
const snap = async (op: string) => JSON.stringify([
  (await pool.query(`SELECT to_jsonb(o) v FROM provider_operations o WHERE id=$1`, [op])).rows[0].v,
  (await pool.query(`SELECT to_jsonb(a) v FROM provider_attempts a WHERE operation_id=$1 ORDER BY attempt_number`, [op])).rows.map(r => r.v),
  (await pool.query(`SELECT to_jsonb(f) v FROM provider_observations f WHERE operation_id=$1 ORDER BY id`, [op])).rows.map(r => r.v)]);

try {
  const T = await fixture(), U = await fixture(), H = await fixture(), D = await fixture(),
    P = await fixture(), R = await fixture(), X = await fixture(), C = await fixture(), Q = await fixture();
  const original = new Map<string, string>();
  for (const [f, age] of [[T,48],[U,48],[H,48],[D,48],[P,48],[R,48],[X,48],[C,2],[Q,48]] as [Fx,number][]) {
    const op = await ambiguate(f, age);
    original.set(f.hash, op);
    check((await intentRow(f.intentId)).terminal_code === "ambiguous_billing", "The real worker produced an ambiguous held address");
  }
  const originalSnap = new Map<string, string>();
  for (const [h, op] of original) originalSnap.set(h, await snap(op));
  check(calls === 9, "One original physical attempt per address");
  await receipt(R); await receipt(X, 1, 12);

  const p1 = await recovery.previewAmbiguousRecovery();
  check(p1.distinctEligibleAddresses === 9 && p1.authorizableAddresses === 8, "Eight authorizable, one in cooldown");
  check(p1.freshReceiptReuse === 2 && p1.maxAuthorizedPurchases === 6, "Canonical receipts: two reuse, six possible purchases");

  // Changed purchase exposure requires a refreshed preview.
  await receipt(Q);
  const p2 = await recovery.previewAmbiguousRecovery();
  check(p2.maxAuthorizedPurchases === 5 && p2.readyFingerprint !== p1.readyFingerprint, "A new fresh receipt changes the binding");
  await assert.rejects(() => recovery.authorizeAmbiguousRecovery({ authorizationKey: `${prefix}_stale`, expectedAuthorizableAddresses: 8,
    expectedMaxAuthorizedPurchases: 6, expectedReadyFingerprint: p1.readyFingerprint, actor: "cert" }), /PREVIEW_STALE/); checks++;
  await assert.rejects(() => recovery.authorizeAmbiguousRecovery({ authorizationKey: `${prefix}_max`, expectedAuthorizableAddresses: 8,
    expectedMaxAuthorizedPurchases: 6, expectedReadyFingerprint: p2.readyFingerprint, actor: "cert" }), /PREVIEW_STALE/); checks++;
  check((await pool.query(`SELECT count(*)::int n FROM zerobounce_ambiguous_recoveries`)).rows[0].n === 0, "Refused authorizations write nothing");
  const p3 = p2;

  const auth = await recovery.authorizeAmbiguousRecovery({ authorizationKey: `${prefix}_ok`, expectedAuthorizableAddresses: 8,
    expectedMaxAuthorizedPurchases: 5, expectedReadyFingerprint: p3.readyFingerprint, actor: "cert" });
  check(auth.authorized === 8 && auth.providerCallsMade === 0, "Authorization binds eight addresses and calls no provider");
  const rows = (await pool.query(`SELECT email_token_hash h,evidence FROM zerobounce_ambiguous_recoveries`)).rows;
  check(rows.filter(r => r.evidence.authorizedAs === "purchase").length === 5 && rows.filter(r => r.evidence.authorizedAs === "reuse").length === 3,
    "Authorization records purchase versus reuse");

  // R: fresh receipt reused first; no physical call.
  calls = 0;
  await processValidationIntent(R.intentId, fake(VALID) as any);
  check(calls === 0 && (await intentRow(R.intentId)).terminal_code === "fresh_address_receipt_reused", "Fresh receipt reused without a provider call");
  // X: authorized for reuse only; receipt expires before execution -> never purchases.
  await new Promise(resolve => setTimeout(resolve, 12500)); // X's receipt expires after authorization
  await processValidationIntent(X.intentId, fake(VALID) as any);
  check(calls === 0 && (await intentRow(X.intentId)).terminal_code === "ambiguous_recovery_reuse_only", "A reuse-only authorization cannot become a purchase");

  // T: second uncertainty stays held.
  await processValidationIntent(T.intentId, fake(TIMEOUT) as any);
  check(calls === 1 && await dispatchesSince(T.hash) === 1, "T: exactly one additional physical attempt");
  await pool.query(`UPDATE validation_intents SET state='pending',claim_token=NULL,lease_expires_at=NULL WHERE id=$1`, [T.intentId]);
  await processValidationIntent(T.intentId, fake(VALID) as any);
  check(calls === 1 && await dispatchesSince(T.hash) === 1, "T: held after a second uncertainty; no third call");

  // U: completed unknown response must not allow another paid retry.
  calls = 0;
  await processValidationIntent(U.intentId, fake(UNKNOWN_COMPLETED) as any);
  check(calls === 1, "U: one additional attempt");
  for (let i = 0; i < 3; i++) await processValidationIntent(U.intentId, fake(VALID) as any);
  check(calls === 1 && await dispatchesSince(U.hash) === 1, "U: completed-unknown response permits no further paid retry");
  check((await intentRow(U.intentId)).terminal_code === "ambiguous_recovery_exhausted", "U: intent blocked as exhausted");

  // H: HTTP failure must not allow another paid retry.
  calls = 0;
  await processValidationIntent(H.intentId, fake(HTTP_FAIL) as any);
  check(calls === 1, "H: one additional attempt");
  for (let i = 0; i < 3; i++) await processValidationIntent(H.intentId, fake(VALID) as any);
  check(calls === 1 && await dispatchesSince(H.hash) === 1, "H: HTTP failure permits no further paid retry");
  check((await intentRow(H.intentId)).terminal_code === "ambiguous_recovery_exhausted", "H: intent blocked as exhausted");

  // D: a pre-dispatch deferral keeps the recovery usable.
  calls = 0;
  await pool.query(`UPDATE provider_controls SET enabled=FALSE WHERE provider='zerobounce'`);
  await processValidationIntent(D.intentId, fake(VALID) as any);
  check(calls === 0 && await dispatchesSince(D.hash) === 0, "D: deferred before dispatch, no physical call");
  check((await pool.query(`SELECT state FROM zerobounce_ambiguous_recoveries WHERE email_token_hash=$1`, [D.hash])).rows[0].state === "consumed", "D: claim lifted");
  await pool.query(`UPDATE provider_controls SET enabled=TRUE,circuit_state='closed' WHERE provider='zerobounce'`);
  check(await processValidationIntent(D.intentId, fake(VALID) as any) === "completed" && calls === 1, "D: resumes and performs its one attempt");
  await processValidationIntent(D.intentId, fake(VALID) as any);
  check(calls === 1 && await dispatchesSince(D.hash) === 1, "D: no second attempt after resumption");

  // P: ordinary purchase path with a new operation identity.
  calls = 0;
  check(await processValidationIntent(P.intentId, fake(VALID) as any) === "completed" && calls === 1, "P: additional attempt completes");
  const pRow = (await pool.query(`SELECT new_operation_id FROM zerobounce_ambiguous_recoveries WHERE email_token_hash=$1`, [P.hash])).rows[0];
  check(pRow.new_operation_id && pRow.new_operation_id !== original.get(P.hash), "P: new operation identity");

  // C: cooldown address is not authorized and not purchased.
  calls = 0;
  await pool.query(`UPDATE validation_intents SET state='pending',claim_token=NULL,lease_expires_at=NULL,terminal_code=NULL WHERE id=$1`, [C.intentId]);
  await processValidationIntent(C.intentId, fake(VALID) as any);
  check(calls === 0, "C: cooldown address is never purchased");

  for (const [h, op] of original) check(await snap(op) === originalSnap.get(h), "Original operation, attempts, observations and billing rows are unchanged");
  const total = (await pool.query(`SELECT count(*)::int n FROM zerobounce_ambiguous_recoveries r JOIN provider_operations op ON op.target_fingerprint=r.email_token_hash
    JOIN provider_attempts a ON a.operation_id=op.id WHERE a.dispatch_marked_at>=r.consumed_at`)).rows[0].n;
  check(total === 5, "Across all addresses T,U,H,D,P each dispatched exactly once after authorization");
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider network attempt");
  console.log(`ZeroBounce ambiguous recovery real-worker: ${checks} checks passed; fake provider only`);
} finally { await pool.end(); }
