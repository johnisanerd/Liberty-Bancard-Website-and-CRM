import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (path: string): string => readFileSync(path, "utf8");
const continuation = source("server/services/cro03/initial-continuation.ts");
const worker = source("server/services/cro03/live-worker.ts");
const executor = source("server/services/cro03/live-provider-executors.ts");
const readiness = source("server/services/provider-readiness-control.ts");
const effectFence = source("server/services/cro03/cro03c-effect-fence.ts");
const migration = source("migrations/0198_cro03c_initial_continuation.sql");
const capMigration = source("migrations/0201_cro03c_validation_command_caps.sql");
const live = source("server/services/cro03/live-execution.ts");
const routes = source("server/routes/cro03.ts");

function ordered(haystack: string, patterns: RegExp[], label: string): void {
  let cursor = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(haystack.slice(cursor));
    assert.ok(match, `${label}: missing ${pattern}`);
    cursor += match.index + match[0].length;
  }
}

// CRO-03C owns a generation-keyed continuation journal. It must not borrow,
// update, or key anything by a CRO-03B recipe item.
for (const text of [continuation, worker, migration]) {
  assert.doesNotMatch(text, /cro03b_recipe_items|cro03b_step_executions|cro03b_finalization_receipts|item_id/i);
}
for (const table of [
  "cro03c_initial_subjects",
  "cro03c_projection_receipts",
  "cro03c_finalization_receipts",
  "cro03c_terminal_hooks",
]) {
  assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
}
assert.match(migration, /generation_id UUID (?:NOT NULL UNIQUE|PRIMARY KEY)/);
assert.match(migration, /UNIQUE \(generation_id, field\)/);
assert.match(migration, /cro03c_projection_receipt_immutable/);

// Contact creation is local-only and suppresses every generic intermediate
// hook. Its durable source event is captured before authority links business.
ordered(continuation, [
  /const hookPolicy: ContactWriterHookPolicy = \{[\s\S]*?deferValidation: true,[\s\S]*?deferReadiness: true,[\s\S]*?deferLeadScoring: true,[\s\S]*?suppressProviderProjection: true/,
  /const contact = await writeContact\(\{[\s\S]*?mode: "local_only"/,
  /if \(contact\.businessId\) throw new Error\("CRO03C_INITIAL_CONTACT_MUST_BEGIN_UNLINKED"\)/,
  /contact_source_event_id=\$\{Number\(contact\._sourceEventId\)\}/,
  /const link = await decideContactBusinessLink\(\{[\s\S]*?evidenceSourceEventId: Number\(subject\.contact_source_event_id\)/,
], "local contact/source/link order");

// Every canonical field projection uses a value/generation CAS plus a
// generation/fence-bound immutable receipt; conflicts require review.
assert.match(continuation, /updateContactLocalFirst\([\s\S]*?expectedValue: before,[\s\S]*?expectedEmailGeneration: Number\(current\.email_mutation_generation\),[\s\S]*?authorityCheck:/);
assert.match(continuation, /INSERT INTO cro03c_projection_receipts[\s\S]*?contact_source_event_id,link_decision_id[\s\S]*?subject_generation,disposition,[\s\S]*?claim_token,execution_fence/);
assert.match(continuation, /ON CONFLICT \(generation_id,field\) DO NOTHING/);
assert.match(continuation, /ContactWriteConflictError[\s\S]*?terminal_code='projection_cas_conflict'/);

// Only the current winning email generation gets the special intent. Generic
// validation is suppressed/superseded and authorization exists before enqueue.
assert.match(continuation, /SELECT id,email,email_token_hash,email_mutation_generation FROM contacts[\s\S]*?FOR UPDATE/);
assert.match(continuation, /tokenHash !== contact\.email_token_hash/);
assert.match(continuation, /purpose: "cro03_winning_email"/);
assert.match(continuation, /normalized_email_token_hash=\$\{tokenHash\}[\s\S]*?subject_generation=\$\{contact\.email_mutation_generation\} AND purpose='cro03_winning_email'/);
assert.doesNotMatch(
  continuation.match(/await createValidationIntent\([\s\S]*?\}\);/)?.[0] ?? "",
  /marketing_outreach/,
);
ordered(continuation, [
  /await authorizeCro03cValidation\(\{/,
  /await enqueueValidationIntent\(String\(finalization\.validation_intent_id\)\)/,
], "validation authorization before enqueue");

// Validation retains three command-bound authority checks: worker pre-reserve,
// worker immediately pre-I/O, and the ZeroBounce executor boundary. Readiness
// uses canonical selection/address ownership, not the retired command-budget
// authority helper, at claim, projection, admission and immediate pre-I/O.
assert.match(worker, /await assertCro03cAuthorityBeforeIo\(context\);[\s\S]*?await reserveCro03cProviderOperation\(/);
assert.match(worker, /await assertCro03cAuthorityBeforeIo\(context\);[\s\S]*?await executeCro03cLiveProvider\(/);
assert.match(executor, /case "zerobounce":[\s\S]*?await assertCro03cAuthorityBeforeIo\(context\);[\s\S]*?await processValidationIntent\(input\.intentId!?/);
assert.ok(
  (readiness.match(/await currentCanonicalValidationSelection\(/g) ?? []).length >= 4,
  "canonical selection must remain checked across claim, admission, projection and dispatch",
);
assert.match(readiness, /await claimCanonicalAddressValidation\(tokenHash!,tx\)/);
assert.match(readiness, /await markCanonicalAddressDispatch\(addressOwner,String\(operationId\),tx\)/);
assert.match(readiness, /if \(!state\?\.enabled \|\| state\.circuit_state !== "closed"\)/);

// Terminal hooks are one generation-coalesced outbox. Readiness is requested
// first, scoring exactly once by its durable key, then completion is permitted.
assert.match(migration, /generation_id UUID NOT NULL UNIQUE REFERENCES cro03c_initial_subjects/);
assert.match(migration, /request_key TEXT NOT NULL UNIQUE/);
ordered(continuation, [
  /if \(!live\.readiness_enqueued_at\)/,
  /await enqueueReadinessRecalculation\(Number\(live\.contact_id\)\)/,
  /if \(!live\.scoring_enqueued_at\)/,
  /await requestContactLeadScoring\(Number\(live\.contact_id\), String\(live\.request_key\)\)/,
  /AND readiness_enqueued_at IS NOT NULL AND scoring_enqueued_at IS NOT NULL/,
  /UPDATE cro03c_initial_subjects SET state='completed'/,
], "readiness/scoring/completion order");
ordered(worker, [
  /const continuation = await continueCro03cInitialGeneration\(claim(?: as unknown as Cro03cInitialContinuationClaim)?\)/,
  /if \(continuation === "waiting"\)[\s\S]*?return "waiting"/,
  /await finishClaim\(claim, false\)/,
], "run completion after terminal continuation");

// Micro canaries are hard-denied from both continuation entry points and take
// the worker branch that never installs the initial-batch effect capability.
assert.equal((continuation.match(/CRO03C_MICRO_CONTINUATION_DENIED/g) ?? []).length, 2);
assert.match(worker, /if \(claim\.command_type === "initial_batch"\)[\s\S]*?withCro03cInitialBatchEffectFence[\s\S]*?\} else \{\s*progression = await dispatchClaim\(claim\)/);
assert.doesNotMatch(
  routes.match(/commandType: z\.literal\("initial_batch"\)[\s\S]*?\}\)\.strict\(\)/)?.[0] ?? "",
  /maxUnits|maxAmountMicros|validationMax/,
  "the browser cannot supply initial validation caps",
);
assert.match(live, /validationMaxUnits = input\.commandType === "initial_batch" \? distinctHandoffs\.length : 0/);
assert.match(live, /validationMaxAmountMicros = validationMaxUnits \* validationUnitAmountMicros/);
assert.match(live, /FOR UPDATE OF i, contact, c, r, g, t, pc/);
assert.match(live, /SUM\(a\.unit_cap\)[\s\S]*?SUM\(a\.cost_cap_micros\)/);
assert.match(live, /CRO03C_VALIDATION_COMMAND_CAP_EXHAUSTED/);
assert.match(capMigration, /validationMaxUnits[\s\S]*?BETWEEN 1 AND 100/);
assert.match(capMigration, /cro03c_validation_authorization_generation_uidx/);
assert.match(capMigration, /released_undispatched[\s\S]*?quarantined_dispatched/);
assert.match(live, /op\.idempotency_key='validation-intent:' \|\| i\.id::text/);

// The bridge has no outbound mutation dependencies. The enclosing deny fence
// explicitly rejects all outbound/cohort mutations while allowing only the
// narrowly required local readiness/scoring terminal effects.
assert.doesNotMatch(continuation, /campaign|sequence_enrollment|outbound_messages|ghl|smtp|sendEmail|sendSms|cr04|cr06/i);
for (const denied of [
  "ghl_mutation", "campaign_creation", "campaign_preparation", "sequence_enrollment",
  "smtp_email", "email", "sms", "rvm", "sender", "cr04", "cr06",
]) {
  assert.ok(effectFence.includes(`"${denied}"`), `effect fence missing ${denied} denial`);
}
assert.doesNotMatch(effectFence, /setPause|UPDATE system_settings|INSERT INTO system_settings/);
assert.match(worker, /withCro03cInitialBatchEffectFence\([\s\S]*?\(\) => dispatchClaim\(claim\)\)/);

console.log("CRO-03C initial continuation bridge static contract: PASS");