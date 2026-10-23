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

async function ownerIsReviewer(userId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT role FROM users WHERE id = $1 LIMIT 1`, [userId]);
  return rows.length === 1 && ["admin", "manager"].includes(String(rows[0].role));
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
