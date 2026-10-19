/**
 * One definition of "this sending identity can send", shared by the operator status,
 * readiness and go-live checks. It mirrors inbox rotation, which is what actually picks a
 * sender: the identity must be switched on and its warmup state must be warm or warming.
 * The identities table has no `status` column; checks that read `identity.status` were always
 * false, so readiness reported "no active identity" while the wizard showed a healthy one.
 */
export interface SenderIdentityLike {
  isActive?: boolean | null;
  warmupStatus?: string | null;
  dailyLimit?: number | null;
  sentToday?: number | null;
}

export const SENDABLE_WARMUP_STATES = ["warm", "warming"] as const;

export function isUsableSenderIdentity(identity: SenderIdentityLike): boolean {
  return identity.isActive !== false
    && SENDABLE_WARMUP_STATES.includes((identity.warmupStatus ?? "warming") as typeof SENDABLE_WARMUP_STATES[number]);
}

export function remainingDailyCapacity(identity: SenderIdentityLike): number {
  return Math.max(0, Number(identity.dailyLimit ?? 0) - Number(identity.sentToday ?? 0));
}
