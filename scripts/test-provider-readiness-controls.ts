/**
 * Deterministic BT-10 kill-line checks. No database, queue, secrets, or
 * network transport is touched by this suite.
 */
import assert from "node:assert/strict";
import {
  assertProviderActivation,
  validateProviderManifest,
} from "../server/services/provider-manifest";
import {
  decideMarketingEmailValidation,
  hashEmailToken,
} from "../server/services/provider-readiness-decision";

const email = "example@merchant.test";
const token = hashEmailToken(email)!;
const now = new Date("2026-08-25T12:00:00.000Z");
const positive = decideMarketingEmailValidation(email, {
  emailStatus: "valid",
  emailTokenHash: token,
  subjectGeneration: 3,
  evidenceGeneration: 3,
  verifiedAt: new Date(now.getTime() - 60_000),
  providerOutcome: "valid",
}, now);
assert.equal(positive.allowed, true, "only fresh current valid evidence may allow marketing");

for (const outcome of [
  "unknown", "unverified", "catch_all", "risky", "not_configured",
  "budget_blocked", "circuit_blocked", "rate_limited", "timeout",
  "transport", "parse_error", "ambiguous_billing", "invalid",
]) {
  const decision = decideMarketingEmailValidation(email, {
    emailStatus: outcome,
    emailTokenHash: token,
    subjectGeneration: 3,
    evidenceGeneration: 3,
    verifiedAt: new Date(now.getTime() - 60_000),
    providerOutcome: outcome,
  }, now);
  assert.equal(decision.allowed, false, `${outcome} must not authorize marketing`);
}

assert.equal(decideMarketingEmailValidation(email, {
  emailStatus: "valid", emailTokenHash: "wrong", subjectGeneration: 3,
  evidenceGeneration: 3, verifiedAt: now, providerOutcome: "valid",
}, now).allowed, false, "mismatched token must block");
assert.equal(decideMarketingEmailValidation(email, {
  emailStatus: "valid", emailTokenHash: token, subjectGeneration: 3,
  evidenceGeneration: 2, verifiedAt: now, providerOutcome: "valid",
}, now).allowed, false, "mismatched generation must block");
assert.equal(decideMarketingEmailValidation(email, {
  emailStatus: "valid", emailTokenHash: token, subjectGeneration: 3,
  evidenceGeneration: 3, verifiedAt: new Date(now.getTime() - 181 * 24 * 60 * 60 * 1000),
  providerOutcome: "valid",
}, now).allowed, false, "stale evidence must block");

assert.equal(validateProviderManifest().ok, true, "every in-scope source must have a valid manifest row");
assert.throws(
  () => assertProviderActivation({ sourceId: "apollo", caller: "server/services/cro03/enrichment-factory.ts" }),
  /(?:explicit approval|Unapproved provider caller)/,
  "an approved caller and configured paid secret alone must not activate a provider",
);

console.log("Provider readiness controls: PASS");