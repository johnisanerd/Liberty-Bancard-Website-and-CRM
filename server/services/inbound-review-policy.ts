/**
 * Review ownership and due time for restricted inbound work (partner applications, privacy requests).
 *
 * The owner and the due-hours come only from an administrator-recorded policy in system_settings. Nothing is invented:
 * when no valid policy exists the assignment is reported as not_configured (owner and due time null) so the review item
 * says so instead of implying a promise. The owner must be an existing admin or manager account.
 */
import { pool } from "../db";
import { storage } from "../storage";

export const INBOUND_REVIEW_POLICY_KEY = "inbound_review_policy";
export const REVIEW_POLICY_CLASSES = ["partner_application_request", "privacy_request"] as const;
export type ReviewPolicyClass = (typeof REVIEW_POLICY_CLASSES)[number];

export interface ReviewPolicyEntry { ownerUserId: string; dueHours: number }
export type ReviewPolicy = Partial<Record<ReviewPolicyClass, ReviewPolicyEntry>>;
export interface ReviewAssignment {
  policy: "configured" | "not_configured";
  ownerUserId: string | null;
  dueAt: string | null;
  reason?: string;
}

function parsePolicy(raw: unknown): ReviewPolicy {
  if (!raw) return {};
  try { return (typeof raw === "string" ? JSON.parse(raw) : raw) as ReviewPolicy; } catch { return {}; }
}

export async function getReviewPolicy(): Promise<ReviewPolicy> {
  return parsePolicy(await storage.getSystemSetting(INBOUND_REVIEW_POLICY_KEY));
}

export type OwnerState = "ok" | "missing" | "not_reviewer" | "deactivated";

/** A reviewer must exist, hold an admin/manager role, and have an active account. */
export async function reviewerState(userId: string | null | undefined): Promise<OwnerState> {
  if (!userId) return "missing";
  const { rows } = await pool.query(`SELECT role, account_state FROM users WHERE id = $1 LIMIT 1`, [userId]);
  if (rows.length !== 1) return "missing";
  if (!["admin", "manager"].includes(String(rows[0].role))) return "not_reviewer";
  if (rows[0].account_state !== "active") return "deactivated";
  return "ok";
}

async function ownerIsReviewer(userId: string): Promise<boolean> {
  return (await reviewerState(userId)) === "ok";
}

export async function setReviewPolicy(next: ReviewPolicy, actor: string): Promise<ReviewPolicy> {
  const clean: ReviewPolicy = {};
  for (const cls of REVIEW_POLICY_CLASSES) {
    const entry = next[cls];
    if (!entry) continue;
    if (!entry.ownerUserId || !(await ownerIsReviewer(entry.ownerUserId))) throw new Error(`INVALID_REVIEW_OWNER:${cls}`);
    if (!Number.isInteger(entry.dueHours) || entry.dueHours < 1 || entry.dueHours > 24 * 90) throw new Error(`INVALID_REVIEW_DUE_HOURS:${cls}`);
    clean[cls] = { ownerUserId: entry.ownerUserId, dueHours: entry.dueHours };
  }
  await storage.setSystemSetting(INBOUND_REVIEW_POLICY_KEY, clean);
  await storage.createAuditLog({
    action: "inbound_review_policy_set", entityType: "system_setting", entityId: 0,
    details: { actor, classes: Object.keys(clean) },
  } as any);
  return clean;
}

/** Owner and due time for one request, derived from its receipt time and the recorded policy. */
export async function resolveReviewAssignment(cls: ReviewPolicyClass, receivedAt: Date): Promise<ReviewAssignment> {
  const entry = (await getReviewPolicy())[cls];
  if (!entry) return { policy: "not_configured", ownerUserId: null, dueAt: null, reason: "no_policy_recorded" };
  if (!(await ownerIsReviewer(entry.ownerUserId))) return { policy: "not_configured", ownerUserId: null, dueAt: null, reason: "owner_not_a_reviewer" };
  return { policy: "configured", ownerUserId: entry.ownerUserId, dueAt: new Date(receivedAt.getTime() + entry.dueHours * 3600_000).toISOString() };
}

export function reviewMetadata(a: ReviewAssignment) {
  return { reviewPolicy: a.policy, reviewOwnerUserId: a.ownerUserId, reviewDueAt: a.dueAt, ...(a.reason ? { reviewPolicyGap: a.reason } : {}) };
}

// ── Outstanding review work: status and supported reconcile ─────────────────────────────────────────────────────────
// "Outstanding" means the owning record is still waiting for a human decision: a pending partner application, a pending
// privacy request. The notification is the assignment carrier; this never changes the record's status and never
// overwrites an assignment that already names a valid reviewer.

interface OutstandingItem {
  cls: ReviewPolicyClass;
  recordId: number;
  receivedAt: Date;
  label: string;
  link: string;
  notificationId: number | null;
  inboundRequestId: string | null;
  assignedOwner: string | null;
  policyState: string | null;
  dueAt: string | null;
}

async function loadOutstanding(): Promise<OutstandingItem[]> {
  const partners = await pool.query(`
    SELECT p.id, p.company_name, COALESCE(ir.source_received_at, p.created_at, now()) AS received_at,
           n.id AS nid, n.inbound_request_id, n.metadata
    FROM partners p
    LEFT JOIN LATERAL (
      SELECT * FROM notifications n
      WHERE n.metadata->>'eventType' = 'partner_application_received' AND (n.metadata->>'partnerId') = p.id::text
      ORDER BY n.id ASC LIMIT 1) n ON true
    LEFT JOIN inbound_requests ir ON ir.id = n.inbound_request_id
    WHERE p.status = 'pending' AND p.partner_type IS DISTINCT FROM 'affiliate'`);
  const privacy = await pool.query(`
    SELECT d.id, COALESCE(ir.source_received_at, d.created_at, now()) AS received_at,
           n.id AS nid, n.inbound_request_id, n.metadata
    FROM data_delete_requests d
    LEFT JOIN LATERAL (
      SELECT * FROM notifications n
      WHERE n.metadata->>'eventType' = 'privacy_request_received' AND (n.metadata->>'dataRequestId') = d.id::text
      ORDER BY n.id ASC LIMIT 1) n ON true
    LEFT JOIN inbound_requests ir ON ir.id = n.inbound_request_id
    WHERE d.status IN ('pending', 'processing')`);
  const out: OutstandingItem[] = [];
  for (const r of partners.rows) out.push({
    cls: "partner_application_request", recordId: r.id, receivedAt: new Date(r.received_at), label: String(r.company_name ?? "Partner application").slice(0, 120),
    link: "/dashboard/referral-program", notificationId: r.nid ?? null, inboundRequestId: r.inbound_request_id ?? null,
    assignedOwner: r.metadata?.reviewOwnerUserId ?? null, policyState: r.metadata?.reviewPolicy ?? null, dueAt: r.metadata?.reviewDueAt ?? null,
  });
  for (const r of privacy.rows) out.push({
    cls: "privacy_request", recordId: r.id, receivedAt: new Date(r.received_at), label: "Privacy request",
    link: "/dashboard/data-requests", notificationId: r.nid ?? null, inboundRequestId: r.inbound_request_id ?? null,
    assignedOwner: r.metadata?.reviewOwnerUserId ?? null, policyState: r.metadata?.reviewPolicy ?? null, dueAt: r.metadata?.reviewDueAt ?? null,
  });
  return out;
}

export interface ReviewQueueClassStatus {
  recordedPolicy: { ownerUserId: string; ownerEmail: string | null; dueHours: number } | null;
  ownerState: OwnerState | "not_configured";
  outstanding: number;
  withoutNotification: number;
  unassigned: number;
  ownerNoLongerValid: number;
  overdue: number;
}

export async function getReviewQueueStatus(now: Date = new Date()): Promise<Record<ReviewPolicyClass, ReviewQueueClassStatus>> {
  const policy = await getReviewPolicy();
  const items = await loadOutstanding();
  const result = {} as Record<ReviewPolicyClass, ReviewQueueClassStatus>;
  for (const cls of REVIEW_POLICY_CLASSES) {
    const entry = policy[cls];
    let ownerEmail: string | null = null;
    if (entry) ownerEmail = (await pool.query(`SELECT email FROM users WHERE id=$1`, [entry.ownerUserId])).rows[0]?.email ?? null;
    const mine = items.filter((i) => i.cls === cls);
    let ownerNoLongerValid = 0;
    for (const i of mine) if (i.assignedOwner && (await reviewerState(i.assignedOwner)) !== "ok") ownerNoLongerValid++;
    result[cls] = {
      recordedPolicy: entry ? { ownerUserId: entry.ownerUserId, ownerEmail, dueHours: entry.dueHours } : null,
      ownerState: entry ? await reviewerState(entry.ownerUserId) : "not_configured",
      outstanding: mine.length,
      withoutNotification: mine.filter((i) => !i.notificationId).length,
      unassigned: mine.filter((i) => !i.assignedOwner).length,
      ownerNoLongerValid,
      overdue: mine.filter((i) => i.dueAt && new Date(i.dueAt).getTime() < now.getTime()).length,
    };
  }
  return result;
}

export interface ReconcileResult {
  examined: number; created: number; assigned: number; reassigned: number; preserved: number; stillUnassigned: number;
}

/**
 * Supported reconcile for outstanding review work. Creates the missing review notification for records that never had
 * one, and fills or replaces an assignment only when the current one is absent or names a reviewer who no longer
 * qualifies. An assignment naming a valid reviewer is a recorded decision and is never overwritten. Due time derives only
 * from the recorded policy and the record's own receipt time; with no policy the item stays visibly unassigned.
 */
export async function reconcileReviewAssignments(actor: string): Promise<ReconcileResult> {
  const out: ReconcileResult = { examined: 0, created: 0, assigned: 0, reassigned: 0, preserved: 0, stillUnassigned: 0 };
  for (const item of await loadOutstanding()) {
    out.examined++;
    const assignment = await resolveReviewAssignment(item.cls, item.receivedAt);
    if (!item.notificationId) {
      const commandKey = `review-reconcile:${item.cls}:${item.recordId}`;
      const eventType = item.cls === "privacy_request" ? "privacy_request_received" : "partner_application_received";
      const idKey = item.cls === "privacy_request" ? "dataRequestId" : "partnerId";
      const message = item.cls === "privacy_request"
        ? "A privacy request is waiting for review. Open the restricted queue to review it."
        : `${item.label} applied as a partner and is waiting for review.`;
      await pool.query(`
        INSERT INTO notifications (channel, title, message, type, command_key, metadata, created_at)
        VALUES ('internal', $1, $2, 'alert', $3, $4::jsonb, now())
        ON CONFLICT (command_key) WHERE command_key IS NOT NULL DO NOTHING`,
        [item.cls === "privacy_request" ? "Privacy request needs review" : "Partner application to review", message, commandKey,
         JSON.stringify({ [idKey]: item.recordId, link: item.link, eventType, audienceRoles: ["admin"], reconciledBy: actor, ...reviewMetadata(assignment) })]);
      out.created++;
      if (assignment.policy !== "configured") out.stillUnassigned++;
      continue;
    }
    const ownerOk = item.assignedOwner ? (await reviewerState(item.assignedOwner)) === "ok" : false;
    if (ownerOk) { out.preserved++; continue; }
    if (assignment.policy !== "configured") { out.stillUnassigned++; continue; }
    await pool.query(`UPDATE notifications SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`,
      [item.notificationId, JSON.stringify({ ...reviewMetadata(assignment), reviewReconciledBy: actor, ...(item.assignedOwner ? { reviewPreviousOwnerUserId: item.assignedOwner } : {}) })]);
    if (item.assignedOwner) out.reassigned++; else out.assigned++;
  }
  await storage.createAuditLog({ action: "inbound_review_reconcile", entityType: "system_setting", entityId: 0, details: { actor, ...out } } as any);
  return out;
}
