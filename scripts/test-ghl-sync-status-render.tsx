// Run: npx tsx --tsconfig scripts/tsconfig.ghl-inbound-ui-test.json scripts/test-ghl-sync-status-render.tsx
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GhlSyncStatus, PROJECTION_LEVEL_LABELS, type ContactProjectionStatus } from "../client/src/pages/dashboard/contact-detail-tabs/GhlSyncStatus";

const base: ContactProjectionStatus = {
  present: true, receiptLevel: "provider_accepted_partial", state: "succeeded", exportDisposition: "current_intake", exportReason: null,
  desiredGeneration: 1, settledGeneration: 1, attemptCount: 0, deferralCount: 0, dispatchState: "none", lastDispatchAt: null,
  nextAttemptAt: null, lastErrorCode: null, terminalReason: null,
  componentReceipts: {
    contact_create: { ok: 1, failed: 0, ambiguous: 0 }, contact_update: { ok: 1, failed: 0, ambiguous: 0 },
    components: {
      identity: { state: "ok" }, tags: { state: "ok" },
      permissions: { state: "held", heldKeys: ["lb_can_email", "lb_can_sms"] }, profile_fields: { state: "held", heldKeys: ["lb_terminal_need"] },
    },
  } as any,
};
function render(projection: ContactProjectionStatus | null | undefined) {
  return renderToStaticMarkup(
    <GhlSyncStatus
      contact={{ id: 1, ghlContactId: "ghl-test-id" } as any}
      ghlSyncStatus={{ isSynced: true, isRecent: true, ghlContactId: "ghl-test-id", projection }}
      resyncToGhlMutation={{ mutate: () => {}, isPending: false }}
    />,
  );
}
let checks = 0;
function check(name: string, test: () => void) { test(); checks++; console.log(`PASS ${name}`); }

check("Partial provider acceptance renders without crashing and shows held fields", () => {
  const html = render(base);
  assert.match(html, /Provider accepted \(partial\)/);
  assert.match(html, /held, not installed in GHL: lb_can_email, lb_can_sms/);
  assert.match(html, /not a read-back verification/);
});
check("Every server receipt level has a label", () => {
  for (const level of ["recorded_locally", "waiting", "processing", "provider_accepted", "provider_accepted_partial", "held", "ambiguous", "failed", "not_applicable"]) {
    assert.ok((PROJECTION_LEVEL_LABELS as Record<string, unknown>)[level], level);
  }
});
check("Unrecognized level is shown as unrecognized, not healthy, and does not crash", () => {
  const html = render({ ...base, receiptLevel: "brand_new_level" as any });
  assert.match(html, /Unrecognized state/);
  assert.doesNotMatch(html, /Provider accepted/);
});
check("Page no longer claims outgoing writes are unavailable", () => {
  const html = render(base);
  assert.doesNotMatch(html, /incoming-only|Writes to GHL are unavailable/);
  assert.match(html, /Manual re-sync is unavailable/);
  assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="button-resync-ghl"/);
});
console.log(`${checks} checks passed`);
