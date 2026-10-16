/**
 * Managed Publish delivers tables/columns/indexes/FKs but NOT PL/pgSQL bodies or triggers. This certification
 * reproduces the production state after such a Publish (legacy reviewed-link routine, no immutable-evidence
 * function/trigger) inside private disposable infrastructure and proves:
 *   - the new application fails closed for first-party writes instead of weakening any guard;
 *   - every pre-existing link writer keeps its guard (legacy body stays acceptable for them);
 *   - the generated owner-console SQL installs exactly the reviewed routine + trigger, idempotently;
 *   - it refuses to overwrite an unrecognized routine or run before the Publish prerequisites exist.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary, getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
import { firstPartyNativeOwnerSql, firstPartyNativeConsoleSql, firstPartyNativeVerificationSql,
  firstPartyNativeManifestModuleSource, FIRST_PARTY_NATIVE_MANIFEST_MODULE,
  FIRST_PARTY_PRE_ROUTINE_INVERSE_MD5, FIRST_PARTY_CURRENT_ROUTINE_INVERSE_MD5 } from "../generate-first-party-staged-email-native-repair";
await assertDisposableTestInfrastructure({ operation: "first-party staged-email native install certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { pool, db } = await import("../../server/db");
const { seal } = await import("../../server/services/cro03/candidate-evidence-service");
const { assertFirstPartyLinkDatabaseGuard, assertSystemLinkDatabaseGuard } =
  await import("../../server/services/commercial-link-authority");
const { assertCanonicalAddressReceiptContract, CANONICAL_ADDRESS_RECEIPT_CLAUSE, ORIGINAL_ADDRESS_RECEIPT_CLAUSE } =
  await import("../../server/services/canonical-address-receipt-contract");
const { reconcileNativeObjects, shouldReconcileNativeObjects, NATIVE_OBJECT_MANIFEST } =
  await import("../../server/native-objects/reconciler");
const { runStagedEmailMaterialization } = await import("../../server/services/free-discovery/staged-email-materialization");

const prefix = `cert_fpdelivery_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const actorId = `system:${prefix}`;
let checks = 0;
const check = (value: unknown, label: string) => { assert(value, label); checks++; };
const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;
const one = async (text: string, params: unknown[] = []) => (await q(text, params))[0];
const ownerSql = firstPartyNativeOwnerSql();
const consoleSql = firstPartyNativeConsoleSql();
const verifySql = firstPartyNativeVerificationSql();
const verified = async () => (await one(verifySql)).repair_verified as boolean;
const routineState = () => one(`SELECT md5(prosrc) body,
  md5(replace(prosrc,$1,$2)) inverse FROM pg_proc
  WHERE oid='public.enforce_reviewed_contact_business_link()'::regprocedure`,
  [CANONICAL_ADDRESS_RECEIPT_CLAUSE, ORIGINAL_ADDRESS_RECEIPT_CLAUSE]);

try {
  // ── Static properties of the delivered files ────────────────────────────────
  check(!/\bDROP\s+(?:TABLE|COLUMN|TRIGGER|CONSTRAINT|FUNCTION)\b/i.test(ownerSql), "Owner delivery never drops guards, data or schema");
  check(!/^(?:BEGIN|COMMIT);$/m.test(consoleSql), "Console batch has no outer client transaction");
  check(/FIRST_PARTY_NATIVE_REPAIR_INCOMPLETE/.test(consoleSql) && /repair_verified/.test(consoleSql),
    "Console batch rejects an incomplete installation");
  for (const [file, content] of [
    ["docs/certification/first-party-staged-email-native-repair-v1.sql", ownerSql],
    ["docs/certification/first-party-staged-email-console-batch-v1.sql", consoleSql],
    ["docs/certification/first-party-staged-email-native-verify-v1.sql", verifySql + ";\n"],
  ] as const) {
    check(fs.existsSync(file) && fs.readFileSync(file, "utf8") === content, `${file} is current with the generator`);
  }

  // ── Automatic delivery wiring ────────────────────────────────────────────────
  check(fs.readFileSync(FIRST_PARTY_NATIVE_MANIFEST_MODULE, "utf8") === firstPartyNativeManifestModuleSource(),
    "Deployed manifest entry is byte-equal to the SQL generated from the reviewed migrations");
  check(NATIVE_OBJECT_MANIFEST.length >= 1 && NATIVE_OBJECT_MANIFEST.every((e) => e.installSql && e.verifySql),
    "Manifest entries carry install and verification SQL");
  check(shouldReconcileNativeObjects("production", {}) && !shouldReconcileNativeObjects("production", { NATIVE_OBJECT_RECONCILE: "off" })
    && !shouldReconcileNativeObjects("development", {}) && !shouldReconcileNativeObjects("test", {}),
    "Reconciliation runs only in production and honors the emergency kill switch");
  const indexSource = fs.readFileSync("server/index.ts", "utf8");
  check(/Production startup migrations skipped[\s\S]{0,800}reconcileNativeObjects\(\)/.test(indexSource),
    "Production startup invokes the reconciler right after the Publish-managed schema notice, before workers");

  // ── The managed-production routine, byte-exact ──────────────────────────────
  // Fixture = prosrc read from the production catalog (read-only query; function source, no data). Its md5 is
  // the production fingerprint recorded when the first-party change was prepared.
  const legacyBody = fs.readFileSync("scripts/certification/fixtures/production-reviewed-link-routine-pre-first-party.plpgsql", "utf8");
  const md5 = async (text: string) => (await one(`SELECT md5($1::text) h`, [text])).h as string;
  check(await md5(legacyBody) === "2d38f8614320afbf936c529662e2c684",
    "Fixture matches the byte-exact production routine body (md5 observed read-only in production)");
  check(await md5(legacyBody.replace(CANONICAL_ADDRESS_RECEIPT_CLAUSE, ORIGINAL_ADDRESS_RECEIPT_CLAUSE)) === FIRST_PARTY_PRE_ROUTINE_INVERSE_MD5,
    "Fixture's inverse-transform fingerprint is the pre-first-party pin the owner SQL accepts");

  const effectsBefore = await one(`SELECT (SELECT count(*) FROM provider_operations)::int ops,
    (SELECT count(*) FROM communication_events)::int msgs`);

  // ── Put the disposable database into the post-Publish, pre-owner-console state ──
  await q(`DROP TRIGGER contact_business_first_party_link_evidence_append_only ON contact_business_first_party_link_evidence`);
  await q(`DROP FUNCTION cro02_first_party_link_evidence_append_only()`);
  await pool.query(`CREATE OR REPLACE FUNCTION public.enforce_reviewed_contact_business_link() RETURNS trigger LANGUAGE plpgsql AS $legacy$${legacyBody}$legacy$`);
  const legacyState = await routineState();
  check(legacyState.body === "2d38f8614320afbf936c529662e2c684" && legacyState.inverse === FIRST_PARTY_PRE_ROUTINE_INVERSE_MD5,
    "Disposable database now holds the exact production routine body and no immutable-evidence trigger");
  check(await verified() === false, "Read-only verification reports the native objects as NOT installed");

  // Fixture: one staged business email waiting for materialization.
  const generationId = (await one(`INSERT INTO free_discovery_generations(run_key,actor_id,reason)
    VALUES($1,$2,'native install certification') RETURNING id`, [prefix, actorId])).id;
  const domain = `${prefix.replace(/_/g, "")}.net`;
  const place = `${prefix}_place`;
  const biz = await one(`INSERT INTO businesses(canonical_name,normalized_name,record_class,google_place_id,vertical,city,state,postal_code,website_domain)
    VALUES('Native Delivery Shop','nativedeliveryshop','canonical',$1,'Automotive','Miami','FL','33130',$2) RETURNING id`, [place, domain]);
  await q(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key) VALUES($1,'google_maps','place',$2)`, [biz.id, place]);
  const email = `info@${domain}`;
  const sealed = seal("email", email);
  const cand = (await one(`INSERT INTO free_discovery_candidates
    (generation_id,field,subject_type,business_id,domain,source,attribution_scope,disposition,confidence,envelope_ciphertext,
     envelope_nonce,envelope_tag,envelope_key_version,normalized_value_hash,masked_value)
    VALUES($1,'email','business',$2,$3,'first_party_contact_page','role','staged',80,$4,$5,$6,1,$7,$8) RETURNING id`,
    [generationId, biz.id, domain, sealed.ciphertext, sealed.nonce, sealed.tag, sealed.normalizedValueHash, sealed.maskedValue])).id as string;

  // ── Before the owner install: fail closed for the new writer, legacy writers untouched ──
  await assert.rejects(assertFirstPartyLinkDatabaseGuard(db),
    /COMMERCIAL_FIRST_PARTY_LINK_DATABASE_GUARD_MISSING:.*immutable_evidence_trigger.*native_branch/);
  checks++;
  await assertSystemLinkDatabaseGuard(db); checks++;
  await assertCanonicalAddressReceiptContract(db); checks++;
  const blocked = await runStagedEmailMaterialization({ limit: 50, actorId, candidateIds: [cand] });
  check(blocked.nativeBlocked && /DATABASE_GUARD_MISSING/.test(blocked.nativeBlocked) && blocked.examined === 0
    && blocked.created === 0 && blocked.failed === 0,
    "Materializer blocks once, cleanly, with the missing native objects named (no per-candidate failures)");
  check(!(await one(`SELECT 1 FROM contacts WHERE lower(email)=$1`, [email]))
    && !(await one(`SELECT 1 FROM free_discovery_materialization_outcomes WHERE candidate_id=$1`, [cand])),
    "Blocked pass created no contact and recorded no outcome/hold for the candidate");
  // A forged first-party decision is rejected by the legacy routine as well: the evidence kind is unknown to it.
  const contact = await one(`INSERT INTO contacts(first_name,last_name,email,phone,company_name,record_class,email_token_hash)
    VALUES('N','D',$1,'','N Co','production',encode(sha256(convert_to($1::text,'UTF8')),'hex')) RETURNING *`, [`other@${domain}`]);
  const ev = await one(`INSERT INTO contact_business_first_party_link_evidence
    (decision_key,contact_id,business_id,candidate_id,candidate_hash,contact_email_token_hash,address_domain,domain_basis,
     attribution_scope,candidate_source,rule_version,facts_hash,facts,crawl_domain,business_site_domain,site_relation)
    SELECT $1,$2,$3,fc.id,fc.normalized_value_hash,$4,$5,'business_domain','role',fc.source,'x','x','{}'::jsonb,$5,$5,'business_website_domain'
      FROM free_discovery_candidates fc WHERE fc.id=$6 RETURNING id`,
    [`${prefix}:legacy-forge`, contact.id, biz.id, contact.email_token_hash, domain, cand]);
  await assert.rejects(q(`INSERT INTO contact_business_link_decisions
    (contact_id,business_id,decision,decision_key,actor_id,revision,first_party_evidence_id)
    VALUES($1,$2,'verified',$3,'system',1,$4)`, [contact.id, biz.id, `${prefix}:legacy-forge`, ev.id]),
    /COMMERCIAL_SYSTEM_LINK_CONTRACT_REQUIRED/);
  checks++;

  // ── Owner delivery refuses to run before Publish created its prerequisites ─────
  await q(`ALTER TABLE contact_business_first_party_link_evidence DROP COLUMN site_relation`);
  await assert.rejects(pool.query(ownerSql), /FIRST_PARTY_NATIVE_REPAIR_PUBLISH_PREREQUISITE_MISSING/); checks++;
  await pool.query("ROLLBACK");
  await q(`ALTER TABLE contact_business_first_party_link_evidence ADD COLUMN site_relation text`);
  check((await routineState()).body === "2d38f8614320afbf936c529662e2c684", "Aborted delivery left the routine untouched");

  // ── Owner delivery refuses to overwrite an unrecognized routine ───────────────
  await pool.query(`CREATE OR REPLACE FUNCTION public.enforce_reviewed_contact_business_link() RETURNS trigger LANGUAGE plpgsql AS $drift$${legacyBody}\n-- drift$drift$`);
  await assert.rejects(pool.query(ownerSql), /FIRST_PARTY_NATIVE_REPAIR_ROUTINE_DRIFT/); checks++;
  await pool.query("ROLLBACK");
  check(!(await one(`SELECT 1 FROM pg_proc WHERE proname='cro02_first_party_link_evidence_append_only'`)),
    "Drift aborted the whole delivery (no partial trigger/function install)");
  await pool.query(`CREATE OR REPLACE FUNCTION public.enforce_reviewed_contact_business_link() RETURNS trigger LANGUAGE plpgsql AS $legacy$${legacyBody}$legacy$`);

  // ── Automatic install at deploy time (the reconciler production startup runs) ──
  const entryId = NATIVE_OBJECT_MANIFEST[0].id;
  const routineXmin = async () => (await one(`SELECT xmin::text x FROM pg_proc
    WHERE oid='public.enforce_reviewed_contact_business_link()'::regprocedure`)).x as string;
  const quick = { attempts: 2, retryDelayMs: 50 };
  // 1. A held advisory lock (another replica mid-install) is skipped, not raced.
  const holder = await pool.connect();
  await holder.query(`SELECT pg_advisory_lock(hashtextextended($1,0))`, [`native_object_reconcile:${entryId}`]);
  const lockedResult = (await reconcileNativeObjects(quick))[0];
  await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [`native_object_reconcile:${entryId}`]);
  holder.release();
  check(lockedResult.status === "skipped_locked" && (await routineState()).body === "2d38f8614320afbf936c529662e2c684",
    "Reconciler skips an entry another replica is installing and changes nothing");
  // 2. Busy table: bounded retries, then a clean rollback with the legacy routine intact (still fail-closed).
  const blocker = await pool.connect();
  await blocker.query("BEGIN");
  await blocker.query(`LOCK TABLE contact_business_first_party_link_evidence IN ACCESS EXCLUSIVE MODE`);
  const busy = (await reconcileNativeObjects(quick))[0];
  await blocker.query("ROLLBACK");
  blocker.release();
  check(busy.status === "failed" && busy.attempts === 2 && /lock timeout|55P03|canceling statement/i.test(busy.detail ?? "")
    && (await routineState()).body === "2d38f8614320afbf936c529662e2c684"
    && !(await one(`SELECT 1 FROM pg_proc WHERE proname='cro02_first_party_link_evidence_append_only'`)),
    "Lock contention retries a bounded number of times and rolls the whole install back");
  // 3. Publish prerequisites missing: refused, nothing installed.
  await q(`ALTER TABLE contact_business_first_party_link_evidence DROP COLUMN site_relation`);
  const noPrereq = (await reconcileNativeObjects(quick))[0];
  await q(`ALTER TABLE contact_business_first_party_link_evidence ADD COLUMN site_relation text`);
  check(noPrereq.status === "prerequisites_missing" && (await routineState()).body === "2d38f8614320afbf936c529662e2c684",
    "Reconciler refuses to run before Publish created its columns");
  // 4. An unrecognized routine body is never overwritten.
  await pool.query(`CREATE OR REPLACE FUNCTION public.enforce_reviewed_contact_business_link() RETURNS trigger LANGUAGE plpgsql AS $drift$${legacyBody}\n-- drift$drift$`);
  const driftBody = (await routineState()).body;
  const drifted = (await reconcileNativeObjects(quick))[0];
  check(drifted.status === "drift_refused" && (await routineState()).body === driftBody
    && !(await one(`SELECT 1 FROM pg_proc WHERE proname='cro02_first_party_link_evidence_append_only'`)),
    "Reconciler refuses to replace a drifted routine and installs nothing");
  await pool.query(`CREATE OR REPLACE FUNCTION public.enforce_reviewed_contact_business_link() RETURNS trigger LANGUAGE plpgsql AS $legacy$${legacyBody}$legacy$`);
  // 5. Two replicas starting at once: exactly one installs.
  const both = await Promise.all([reconcileNativeObjects(quick), reconcileNativeObjects(quick)]);
  const statuses = both.map((r) => r[0].status).sort();
  check(statuses.filter((x) => x === "installed").length === 1
    && statuses.every((x) => ["installed", "skipped_locked", "already_current"].includes(x)),
    `Concurrent startups install exactly once (${statuses.join(",")})`);
  const installed = await routineState();
  check(installed.inverse === FIRST_PARTY_CURRENT_ROUTINE_INVERSE_MD5 && await verified() === true,
    "Automatic install produced exactly the reviewed routine and immutability trigger; verification SQL passes");
  await assertFirstPartyLinkDatabaseGuard(db); checks++;
  await assertCanonicalAddressReceiptContract(db); checks++;
  // 6. Every later startup is a read-only no-op.
  const xminBefore = await routineXmin();
  const again = (await reconcileNativeObjects(quick))[0];
  check(again.status === "already_current" && await routineXmin() === xminBefore,
    "Next startup detects the current objects and writes nothing");
  const audited = await q(`SELECT details->>'status' status FROM audit_logs WHERE action='native_object_reconcile' ORDER BY created_at`);
  check(["failed", "prerequisites_missing", "drift_refused", "installed"].every((x) => audited.some((r: any) => r.status === x))
    && !audited.some((r: any) => r.status === "already_current" || r.status === "skipped_locked"),
    "Installs and refusals are audited; routine no-ops are not");
  // The owner-console files stay valid as a manual fallback and replay safely.
  await pool.query(ownerSql);
  const replayConsole = await pool.query(consoleSql) as unknown as Array<{ rows: any[] }>;
  check(replayConsole.at(-1)?.rows[0]?.repair_verified === true && (await routineState()).body === installed.body,
    "Owner SQL and the console batch remain a safe manual fallback against an already installed state");
  const anyEvidence = await one(`SELECT id FROM contact_business_first_party_link_evidence LIMIT 1`);
  if (anyEvidence) {
    await assert.rejects(q(`UPDATE contact_business_first_party_link_evidence SET rule_version='y' WHERE id=$1`, [anyEvidence.id]),
      /COMMERCIAL_FIRST_PARTY_LINK_EVIDENCE_IMMUTABLE/);
    checks++;
  }

  // ── After install the same candidate links through the native branch ─────────
  const linked = await runStagedEmailMaterialization({ limit: 50, actorId, candidateIds: [cand] });
  check(!linked.nativeBlocked && linked.created === 1 && linked.failed === 0,
    "After the owner install the automatic handoff links the staged email natively");
  check(getBlockedCertificationNetworkAttemptCount() === 0, "No attempted provider/network transport");
  const effectsAfter = await one(`SELECT (SELECT count(*) FROM provider_operations)::int ops,
    (SELECT count(*) FROM communication_events)::int msgs`);
  check(effectsAfter.ops === effectsBefore.ops && effectsAfter.msgs === effectsBefore.msgs, "No provider operations or communications");
  console.log(`PASS: ${checks} first-party native install checks; disposable only, no provider calls or messages`);
} finally { await pool.end(); }
