import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideCr06PromotionalLifecycle } from "../services/cr06-promotional-lifecycle-decision";

const worker = readFileSync("server/services/sequence-worker.ts", "utf8");

// The general lifecycle authority still refuses promotional execution; the release is a separate, narrow admission.
assert.equal(decideCr06PromotionalLifecycle({ boundary: "sequence_transport" }).allowed, false);

// Both the claim boundary and the email transport boundary honor the release, and nothing else bypasses the authority.
assert.match(worker, /const canonicalReleaseAdmitted = await isCanonicalReleaseAdmitted\(enrollment, sequence\)/);
assert.match(worker, /sequence\.status !== "active" && !canonicalReleaseAdmitted/);
assert.match(worker, /!cr06Decision\.allowed && !canonicalReleaseAdmitted/);
assert.match(worker, /boundary: "sequence_transport",\s*purpose: cr06Purpose,\s*\}\)\.allowed && !canonicalReleaseAdmitted/);
// SMS dispatch is not covered by the release.
const smsBlock = worker.slice(worker.indexOf("authorizeClaimedSmsDispatch = async"));
assert.doesNotMatch(smsBlock.slice(0, 600), /canonicalReleaseAdmitted/);
// Expired releases are reconciled before work is selected.
assert.match(worker, /await reconcileExpiredCanonicalRelease\(\)/);
console.log("SFP canonical release boundary source checks passed");
