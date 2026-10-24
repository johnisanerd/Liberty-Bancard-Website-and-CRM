/**
 * Partner/affiliate account creation: one transaction for the partner row, its login credential and, for a public
 * occurrence, the binding of that occurrence to the account.
 *
 * The binding is the occurrence's captured mailbox (`inbound_requests.submitted_email`, first value wins). It is
 * written in the same transaction as the account, so "occurrence has a captured mailbox" is true exactly when this
 * occurrence created the account. Recovery therefore never has to guess from an arbitrary email match: a pinned
 * occurrence has a durable account; an unpinned occurrence never created one.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { inboundRequests, partners, users, userSessions } from "@shared/schema";
import type { InsertPartner } from "@shared/schema";

export const PARTNER_EMAIL_IN_USE = "An account with this email already exists.";
export type PartnerAccountRole = "partner" | "affiliate";

export async function createPartnerAccount(
  input: InsertPartner,
  options: { role?: PartnerAccountRole; inboundRequestId?: string } = {},
) {
  const role = options.role ?? "partner";
  return db.transaction(async (tx) => {
    const email = input.email?.trim().toLowerCase();
    const [linked] = email ? await tx.select().from(users).where(eq(users.email, email)) : [undefined];
    if (linked && linked.role !== role) throw new Error(PARTNER_EMAIL_IN_USE);
    if (role === "affiliate" && linked) throw new Error(PARTNER_EMAIL_IN_USE);
    const [partner] = await tx.insert(partners).values({ ...input, email }).returning();
    if (input.passwordHash && email) {
      if (linked) {
        await tx.update(users).set({ passwordHash: input.passwordHash, updatedAt: new Date() }).where(eq(users.id, linked.id));
        await tx.update(userSessions).set({ isInvalidated: true, invalidatedAt: new Date() }).where(eq(userSessions.userId, linked.id));
      } else {
        const names = (input.contactName || "").split(" ");
        await tx.insert(users).values({
          email, firstName: names[0] || (role === "affiliate" ? "Affiliate" : "Partner"), lastName: names.slice(1).join(" "),
          passwordHash: input.passwordHash, role, authProvider: "local",
        });
      }
    }
    if (options.inboundRequestId && email) {
      const [bound] = await tx.update(inboundRequests).set({
        submittedEmail: sql`COALESCE(${inboundRequests.submittedEmail}, ${email})`, updatedAt: new Date(),
      }).where(and(eq(inboundRequests.id, options.inboundRequestId))).returning({ submittedEmail: inboundRequests.submittedEmail });
      if (!bound || bound.submittedEmail !== email) throw new Error("INBOUND_ACCOUNT_BINDING_CONFLICT");
    }
    // An affiliate is active at signup: the welcome intent commits with the account and is executed by the delivery worker.
    if (role === "affiliate") {
      const { enqueueAffiliateWelcome } = await import("./partner-approval-delivery");
      await enqueueAffiliateWelcome(tx, partner.id);
    }
    return partner;
  });
}

/**
 * Recreates a missing login credential from the stored password hash (the plaintext is never stored). Idempotent;
 * never touches an existing user and never changes a user that belongs to a different role.
 */
export async function ensurePartnerCredential(
  partner: { email: string | null; contactName: string | null; passwordHash: string | null },
  role: PartnerAccountRole,
): Promise<"present" | "created" | "no_credential_on_file" | "role_conflict"> {
  const email = partner.email?.trim().toLowerCase();
  if (!email || !partner.passwordHash) return "no_credential_on_file";
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"partner-credential:" + email}))`);
    const [user] = await tx.select().from(users).where(eq(users.email, email));
    if (user) return user.role === role ? "present" : "role_conflict";
    const names = (partner.contactName || "").split(" ");
    await tx.insert(users).values({
      email, firstName: names[0] || (role === "affiliate" ? "Affiliate" : "Partner"), lastName: names.slice(1).join(" "),
      passwordHash: partner.passwordHash, role, authProvider: "local",
    }).onConflictDoNothing();
    return "created";
  });
}
