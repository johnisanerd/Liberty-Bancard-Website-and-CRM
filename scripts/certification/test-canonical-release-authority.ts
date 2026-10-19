import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {sql} from "drizzle-orm";
import { assertDisposableTestInfrastructure } from "../test-infrastructure-guard";
import { applyCertificationProviderDenyBoundary,
  getBlockedCertificationNetworkAttemptCount } from "../certification-provider-deny";
await assertDisposableTestInfrastructure({ operation: "canonical release authority certification" });
process.env.VG_PROVIDER_DENY_MODE = "1";
applyCertificationProviderDenyBoundary({ fatal: true });
const { db,pool } = await import("../../server/db");
const { prepareCanonicalRecipient,currentCanonicalValidationSelection } =
  await import("../../server/services/canonical-recipient-preparation");
const {processValidationIntent,evaluateMarketingEmailEligibility,delegateSelectedAddressValidation} =
  await import("../../server/services/provider-readiness-control");
const release = await import("../../server/services/sfp-canonical-release");
const { hashEmailToken } = await import("../../server/services/provider-readiness-control");
const { COLD_OUTREACH_FROM } = await import("../../server/services/sender-policy");
const { previewContactBusinessSystemLinks, applyContactBusinessSystemLink } =
  await import("../../server/services/contact-business-system-links");
const prefix = `cert_canonical_release_${randomUUID().replaceAll("-","")}`;
const actor = { role: "admin" as const, actorId: `system:${prefix}`, email: null };
let checks = 0;
const check = (value: unknown, message: string) => { assert(value,message); checks++; };
async function fixture(businessId?: number) {
  const label = randomUUID().replaceAll("-","");
  const place = `${prefix}_${businessId ?? label}_place`;
  let business;
  if (businessId) business = (await pool.query("SELECT * FROM businesses WHERE id=$1",[businessId])).rows[0];
  else {
    business = (await pool.query(`INSERT INTO businesses
      (canonical_name,normalized_name,record_class,google_place_id,vertical,city,state,postal_code)
      VALUES($1,$2,'canonical',$3,'Automotive','Miami','FL','33130') RETURNING *`,
      [`${prefix} ${label}`, `${prefix}${label}`, place])).rows[0];
    await pool.query(`INSERT INTO canonical_source_links
      (business_id,source_system,source_type,stable_key)
      VALUES($1,'google_maps','place',$2)`, [business.id,place]);
  }
  const contact = (await pool.query(`INSERT INTO contacts
    (first_name,last_name,email,phone,company_name,record_class)
    VALUES('Canonical','Fixture',$1,'',$2,'production') RETURNING id`,
    [`${prefix.slice(0,30)}.${label.slice(0,24)}@gmail.com`, `${business.canonical_name} LLC`])).rows[0];
  await pool.query(`INSERT INTO contact_source_events
    (contact_id,event_key,source_category,source_type,source_external_id,actor_type,actor_id,metadata)
    VALUES($1,$2,'import','google_maps_outscraper',$2,'system',$3,$4::jsonb)`,
    [contact.id,`${prefix}_${label}_event`,actor.actorId,JSON.stringify({ place_id: business.google_place_id })]);
  const preview = await previewContactBusinessSystemLinks({ afterContactId: Number(contact.id)-1,limit: 1 });
  const candidate = preview.rows[0];
  check(candidate?.eligible, "Independent stable Maps evidence supports affiliation without a website/corporate email");
  const outcome = await applyContactBusinessSystemLink({
    contactId: Number(contact.id), businessId: Number(business.id),
    sourceLinkId: candidate.sourceLinkId!,sourceEntityId: candidate.sourceEntityId,
    snapshotHash: candidate.snapshotHash,
  });
  check(outcome.status === "applied", "Use the real reviewed native relationship writer");
  const email = (await pool.query("SELECT email FROM contacts WHERE id=$1",[contact.id])).rows[0].email as string;
  const opId = randomUUID(); const tokenHash = hashEmailToken(email);
  await pool.query(`INSERT INTO provider_operations (id,provider,operation_type,purpose,idempotency_key,actor_type,target_fingerprint,state)
    VALUES($1,'zerobounce','email_validation','certification',$2,'system',$3,'completed')`,[opId,`${prefix}-${opId}`,`business:${business.id}`]);
  await pool.query(`INSERT INTO provider_observations (provider,operation_id,subject_type,subject_id,email_token_hash,subject_generation,outcome,retryable,observed_at,expires_at)
    VALUES('zerobounce',$1,'contact',$2,$3,0,'valid',false,NOW()-INTERVAL '1 hour',NOW()+INTERVAL '29 days')`,[opId,contact.id,tokenHash]);
  await pool.query(`UPDATE contacts SET email_status='valid',email_token_hash=$2,email_validation_updated_at=NOW() WHERE id=$1`,[contact.id,tokenHash]);
  return { contactId: Number(contact.id), businessId: Number(business.id) };
}
try {
  const programId = randomUUID();
  await pool.query(`INSERT INTO sfp_programs
    (id,name,county_fips,vertical_ids,taxonomy_version,is_active,created_by)
    VALUES($1,$2,ARRAY['12086'],ARRAY['Automotive'],2,TRUE,$3)`,[programId,prefix,actor.actorId]);
  const sequenceId = Number((await pool.query(`INSERT INTO follow_up_sequences
    (name,status,trigger_type,trigger_config) VALUES($1,'paused','contact_created',$2::jsonb) RETURNING id`,
    [prefix,JSON.stringify({canonicalProgramId:programId,canonicalVerticals:["Automotive"]})])).rows[0].id);
  await pool.query(`INSERT INTO sequence_steps (sequence_id,step_order,action_type,delay_days,delay_hours,subject,body)
    VALUES($1,1,'email',0,0,'Fixture subject','Hello, fixture body')`,[sequenceId]);
  await pool.query("UPDATE follow_up_sequences SET total_steps=1 WHERE id=$1",[sequenceId]);
  await pool.query("DELETE FROM system_settings WHERE key=$1",[release.CANONICAL_RELEASE_CONTROL_KEY]);
  const sequence = (await pool.query("SELECT * FROM follow_up_sequences WHERE id=$1",[sequenceId])).rows[0];
  const sequenceView = { retiredAt: sequence.retired_at, triggerConfig: sequence.trigger_config };

  const made = [];
  for (let n = 0; n < 2; n++) {
    const f = await fixture();
    const prepared = await prepareCanonicalRecipient({ contactId: f.contactId, sequenceId, programId, actor, source: prefix });
    check(prepared.enrollmentId != null, "Preparation creates an owned paused membership");
        made.push({ ...f, intentId: String(prepared.intentId), enrollmentId: Number(prepared.enrollmentId) });
  }
  // The real selector and the real capacity definition: a sender that can send exactly one message today.
  await pool.query(`DELETE FROM sending_identities WHERE lower(email_address)=lower($1)`,[COLD_OUTREACH_FROM]);
  await pool.query(`INSERT INTO sending_identities (label,domain,email_address,is_active,warmup_status,daily_limit,sent_today)
    VALUES('cert','mail.libertybancard.com',$1,TRUE,'warm',1,0)`,[COLD_OUTREACH_FROM]);
  const enrollment = async (id: number) => (await pool.query("SELECT * FROM sequence_enrollments WHERE id=$1",[id])).rows[0];
  const view = (row: any) => ({ id: row.id, status: row.status, metadata: row.metadata });

  // Disabled by default: nothing is admitted.
  check(!(await release.isCanonicalReleaseAdmitted(view(await enrollment(made[0].enrollmentId)), sequenceView)),
    "With no release, a paused canonical membership is not admitted");

  // Capacity bounds the batch size.
  const preview = await release.previewCanonicalRelease(5);
  check(preview.size === 1 && preview.dailyCapacityRemaining === 1, "Release size is capped by remaining sender capacity");
  await assert.rejects(release.executeCanonicalRelease({ requestedLimit: 5, snapshotHash: "wrong", commandKey: "k-1",
    expiresInHours: 1, actorId: "admin:test" }), { code: "RELEASE_SNAPSHOT_DRIFT" }); checks++;
  check((await enrollment(made[0].enrollmentId)).status === "paused", "A stale snapshot releases nothing");
  await assert.rejects(release.executeCanonicalRelease({ requestedLimit: 5, snapshotHash: preview.snapshotHash, commandKey: "k-1",
    expiresInHours: 999, actorId: "admin:test" }), { code: "RELEASE_EXPIRY_INVALID" }); checks++;

  const executed = await release.executeCanonicalRelease({ requestedLimit: 5, snapshotHash: preview.snapshotHash,
    commandKey: "k-1", expiresInHours: 1, actorId: "admin:test" });
  check(!executed.replayed && executed.release.enrollmentIds.length === 1, "Execute releases exactly the capped selection");
  const released = await enrollment(made[0].enrollmentId);
  const heldBack = await enrollment(made[1].enrollmentId);
  check(released.status === "active" && released.metadata.canonicalRelease.releaseId === executed.release.releaseId,
    "The selected membership is active and marked with the release");
  check(heldBack.status === "paused" && !heldBack.metadata.canonicalRelease, "Everything outside the cap stays paused");
  check((await pool.query("SELECT status FROM follow_up_sequences WHERE id=$1",[sequenceId])).rows[0].status === "paused",
    "The sequence itself stays paused");
  check(await release.isCanonicalReleaseAdmitted(view(released), sequenceView), "The released membership is admitted");
  check(!(await release.isCanonicalReleaseAdmitted(view(heldBack), sequenceView)), "An unreleased membership is not admitted");
  check(!(await release.isCanonicalReleaseAdmitted(view(released), { ...sequenceView, triggerConfig: {} })),
    "A non-canonical sequence is never admitted");
  check(!(await release.isCanonicalReleaseAdmitted({ ...view(released), metadata: { ...released.metadata,
    canonicalRelease: { releaseId: randomUUID() } } }, sequenceView)), "A marker from a different release is not admitted");

  const replay = await release.executeCanonicalRelease({ requestedLimit: 5, snapshotHash: preview.snapshotHash,
    commandKey: "k-1", expiresInHours: 1, actorId: "admin:test" });
  check(replay.replayed && replay.release.releaseId === executed.release.releaseId, "Replaying the same command is idempotent");
  await assert.rejects(release.executeCanonicalRelease({ requestedLimit: 5, snapshotHash: preview.snapshotHash, commandKey: "k-2",
    expiresInHours: 1, actorId: "admin:test" }), (e: any) => e.code === "ACTIVE_RELEASE_EXISTS" || e.code === "RELEASE_SNAPSHOT_DRIFT"); checks++;

  // The admission window closing stops new admissions; reconcile returns the unsent membership to paused.
  const control = (await pool.query("SELECT value FROM system_settings WHERE key=$1",[release.CANONICAL_RELEASE_CONTROL_KEY])).rows[0].value;
  control.releases.forEach((r: any) => { r.admissionClosesAt = new Date(Date.now()-60_000).toISOString(); });
  await pool.query("UPDATE system_settings SET value=$2::jsonb WHERE key=$1",[release.CANONICAL_RELEASE_CONTROL_KEY,JSON.stringify(control)]);
  check(!(await release.isCanonicalReleaseAdmitted(view(released), sequenceView)), "A closed admission window admits no unsent first touch");
  await release.reconcileCanonicalReleases();
  const after = await enrollment(made[0].enrollmentId);
  check(after.status === "paused" && !after.metadata.canonicalRelease && after.metadata.outboundAuthorized === false,
    "Reconciliation returns the unsent membership to its paused state");

  // Revoke after a fresh release.
  const preview2 = await release.previewCanonicalRelease(1);
  const second = await release.executeCanonicalRelease({ requestedLimit: 1, snapshotHash: preview2.snapshotHash,
    commandKey: "k-3", expiresInHours: 1, actorId: "admin:test" });
  check(second.release.releaseId !== executed.release.releaseId, "A new release gets a new identity");
  const revoked = await release.revokeCanonicalRelease("admin:test");
  check(revoked.revoked && revoked.repaused === 1, "Revoke re-pauses every released membership");
  check(!(await release.isCanonicalReleaseAdmitted(view(await enrollment(made[0].enrollmentId)), sequenceView)), "Nothing is admitted after revoke");

  check(getBlockedCertificationNetworkAttemptCount() === 0, "No provider or network call was attempted");
  console.log(`PASS canonical release authority (${checks} checks)`);
} finally {
  await pool.query("DELETE FROM system_settings WHERE key=$1",[release.CANONICAL_RELEASE_CONTROL_KEY]).catch(()=>{});
  await pool.end().catch(()=>{});
}
