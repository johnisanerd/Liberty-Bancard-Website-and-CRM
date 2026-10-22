/**
 * Single statement of current GHL/Replit ownership used by every GHL guide, playbook,
 * workflow-ID, help and activation message. Keep these four facts consistent everywhere.
 */
export const GHL_OWNERSHIP_STATEMENT = {
  cadence:
    "Replit owns sequence cadence, timing, routing, enrollment gates, suppression, sender policy and audit.",
  workflowIds:
    "Sequence workflow IDs are reference-only records: a missing one does not change sequence execution. A separate set of supported handoff workflows (form confirmation, scheduling, merchant application, proposal follow-up, affiliate welcome, unsubscribe) is enrolled from Replit using the saved ID; when that ID is missing the enrollment is skipped.",
  incoming:
    "Incoming GHL sync is controlled independently of outbound sending and keeps running while outbound is paused.",
  pause:
    "The global outbound pause governs every outbound send; nothing in a guide or setting overrides it.",
} as const;

export const GHL_OWNERSHIP_SUMMARY = [
  GHL_OWNERSHIP_STATEMENT.cadence,
  GHL_OWNERSHIP_STATEMENT.workflowIds,
  GHL_OWNERSHIP_STATEMENT.incoming,
  GHL_OWNERSHIP_STATEMENT.pause,
].join(" ");

/**
 * Registry workflow IDs that Replit code actually enrolls contacts into (source census; verified by
 * scripts/test-ghl-ownership-readiness.ts). A missing ID skips exactly that handoff.
 * Every other registry entry is a reference-only record: no code path enrolls into it.
 */
export const GHL_SUPPORTED_HANDOFF_WORKFLOWS: Readonly<Record<string, string>> = {
  inbound_confirmation: "Website form confirmation is not handed to GHL; the in-platform confirmation path is used instead.",
  booking_link: "Booking-link handoff is skipped.",
  booking_confirmation: "Appointment confirmation handoff is skipped.",
  booking_reminder_24h: "24-hour appointment reminder handoff is skipped.",
  statement_request_after_meeting: "Post-meeting statement request handoff is skipped.",
  no_show_reschedule: "No-show reschedule handoff is skipped.",
  merchant_app: "Merchant application confirmation handoff is skipped.",
  proposal_followup: "Proposal follow-up handoff is skipped.",
  proposal_viewed: "Proposal-viewed handoff is skipped.",
  proposal_accepted: "Proposal-accepted handoff is skipped.",
  affiliate_welcome: "Affiliate welcome handoff is skipped.",
  unsubscribe: "GHL-side opt-out workflow is not started (Replit suppression still applies).",
  post_call_review: "Post-call review handoff is skipped.",
  long_term_nurture: "Long-term nurture handoff is skipped.",
  statement_analyzed: "Statement-analysis confirmation handoff is skipped.",
};

export interface GhlWorkflowReadinessSummary {
  supportedTotal: number;
  supportedConfigured: number;
  missingSupported: Array<{ id: string; effect: string }>;
  referenceOnlyTotal: number;
  referenceOnlyConfigured: number;
  /** True only when a supported handoff is missing. Reference-only gaps never affect readiness. */
  needsAttention: boolean;
}

/** Readiness comes only from the handoffs Replit actually enrolls into. Never mentions unpausing. */
export function summarizeGhlWorkflowReadiness(registryIds: readonly string[], configuredIds: ReadonlySet<string>): GhlWorkflowReadinessSummary {
  const supported = registryIds.filter(id => id in GHL_SUPPORTED_HANDOFF_WORKFLOWS);
  const referenceOnly = registryIds.filter(id => !(id in GHL_SUPPORTED_HANDOFF_WORKFLOWS));
  const missingSupported = supported.filter(id => !configuredIds.has(id)).map(id => ({ id, effect: GHL_SUPPORTED_HANDOFF_WORKFLOWS[id] }));
  return {
    supportedTotal: supported.length,
    supportedConfigured: supported.length - missingSupported.length,
    missingSupported,
    referenceOnlyTotal: referenceOnly.length,
    referenceOnlyConfigured: referenceOnly.filter(id => configuredIds.has(id)).length,
    needsAttention: missingSupported.length > 0,
  };
}
