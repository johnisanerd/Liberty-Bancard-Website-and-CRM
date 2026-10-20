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
