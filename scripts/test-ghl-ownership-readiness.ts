import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GHL_SUPPORTED_HANDOFF_WORKFLOWS, GHL_OWNERSHIP_SUMMARY, summarizeGhlWorkflowReadiness } from "../shared/ghl-ownership-guidance";

// Registry ids parsed from source so this test needs no database or environment.
const registrySource = fs.readFileSync("server/services/ghl-workflows.ts", "utf8");
const registryIds = [...registrySource.matchAll(/^\s*\{ id: "([a-z_0-9]+)", name:/gm)].map(m => m[1]);
assert(registryIds.length >= 30, `registry parsed (${registryIds.length})`);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const callerSources = walk("server").filter(f => f !== "server/services/ghl-workflows.ts").map(f => fs.readFileSync(f, "utf8")).join("\n");
const hasCaller = (id: string) =>
  new RegExp(`workflowKey:\\s*["'\`]${id}["'\`]`).test(callerSources) ||
  new RegExp(`enrollMerchantWorkflow\\([^,]+,\\s*["'\`]${id}["'\`]`).test(callerSources) ||
  (id === "inbound_confirmation" && /GHL_WORKFLOW_INBOUND_CONFIRMATION/.test(callerSources));

let checks = 0;
const check = (v: unknown, m: string) => { assert(v, m); checks++; };

for (const id of Object.keys(GHL_SUPPORTED_HANDOFF_WORKFLOWS)) {
  check(registryIds.includes(id), `supported handoff ${id} exists in the registry`);
  check(hasCaller(id), `supported handoff ${id} has a real enrollment caller`);
}
const referenceOnly = registryIds.filter(id => !(id in GHL_SUPPORTED_HANDOFF_WORKFLOWS));
check(referenceOnly.length > 0, "Some registry entries are reference-only");
for (const id of referenceOnly) check(!hasCaller(id), `reference-only ${id} has no enrollment caller (add it to the supported list if one is introduced)`);

// Readiness derives only from supported handoffs.
const none = summarizeGhlWorkflowReadiness(registryIds, new Set());
check(none.supportedTotal + none.referenceOnlyTotal === registryIds.length, "Every registry entry is classified exactly once");
check(none.needsAttention && none.missingSupported.length === none.supportedTotal, "No IDs saved: every supported handoff is listed as missing");
const refOnly = summarizeGhlWorkflowReadiness(registryIds, new Set(referenceOnly));
check(refOnly.needsAttention && refOnly.supportedConfigured === 0, "Saving only reference-only IDs does not satisfy readiness");
const supportedOnly = summarizeGhlWorkflowReadiness(registryIds, new Set(Object.keys(GHL_SUPPORTED_HANDOFF_WORKFLOWS)));
check(!supportedOnly.needsAttention && supportedOnly.referenceOnlyConfigured === 0 && supportedOnly.missingSupported.length === 0,
  "All supported IDs saved is ready even with every reference-only ID missing");
check(summarizeGhlWorkflowReadiness(registryIds, new Set(["merchant_app"])).missingSupported.every(m => m.id !== "merchant_app"), "A saved ID is not reported missing");

// Copy: no surface may claim missing IDs silently break all automation, or tell operators to unpause.
const surfaces = ["server/routes/admin.ts", "client/src/pages/dashboard/SystemReadiness.tsx", "client/src/pages/dashboard/MarketingPlaybook.tsx",
  "client/src/pages/dashboard/GhlWorkflowManager.tsx", "client/src/pages/dashboard/GhlSequenceGuide.tsx", "shared/ghl-ownership-guidance.ts"];
for (const f of surfaces) {
  const text = fs.readFileSync(f, "utf8");
  check(!/all automation (is )?silently|unconfigured → all automation|drives the entire pipeline|Paste each GHL Workflow ID next to/i.test(text), `${f}: no stale ownership claim`);
  check(!/\b(un-?pause|resume (outbound|sending)|turn(ing)? (the )?(global )?pause off)\b/i.test(text.replace(/does not|never|nothing/gi, "")) || f.endsWith("admin.ts"), `${f}: no unpause guidance`);
}
check(/global outbound pause/.test(GHL_OWNERSHIP_SUMMARY), "Ownership summary states the pause authority");
console.log(`GHL ownership/readiness: ${checks} checks passed (registry ${registryIds.length}, supported ${Object.keys(GHL_SUPPORTED_HANDOFF_WORKFLOWS).length}, reference-only ${referenceOnly.length})`);
