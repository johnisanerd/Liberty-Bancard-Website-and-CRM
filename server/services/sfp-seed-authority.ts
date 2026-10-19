/**
 * Durable authority for the operator seed test. A seed message is a real message from the real cold sender to ONE
 * mailbox the operator explicitly authorized. It is not a prospect: it has no contact, enrollment, intent, release,
 * send-log row or capacity count, and its unsubscribe link records a seed event only.
 *
 * The SMTP transport re-verifies everything here from durable state (it never trusts a caller's flag), and the
 * global outbound pause authority still applies to the send.
 */
import { createHash } from "node:crypto";
import { pool } from "../db";
import type { CommercialComplianceLoader } from "./can-spam-footer";

export const SEED_AUTHORIZATION_KEY = "sfp_seed_test_authorization";
export const seedReceiptKey = (idempotencyKey: string) => `sfp_seed_test_receipt:${idempotencyKey}`;
export const seedUnsubscribeKey = (occurrenceId: string) => `sfp_seed_test_unsubscribe:${occurrenceId}`;
export const SEED_MAX_MESSAGES = 3;
export const SEED_MAX_AUTHORIZATION_HOURS = 24;

export interface SeedAuthorization {
  mailbox: string; mailboxHash: string; nonce: string;
  authorizedBy: string; authorizedAt: string; expiresAt: string;
  maxMessages: number; sentCount: number;
  unsubscribedAt: string | null; revokedAt: string | null;
}
export type SeedReceiptState = "claimed" | "sent" | "unsent" | "uncertain";
export interface SeedReceipt {
  state: SeedReceiptState; mailboxHash: string; occurrenceId: string; requestFingerprint: string;
  packageKey: string; stepOrder: number; subjectHash: string; bodyHash: string;
  claimedAt: string; finishedAt: string | null; messageId: string | null; error: string | null; actorId: string;
}

const MAILBOX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normalizeSeedMailbox = (raw: unknown): string | null => {
  const value = String(raw ?? "").trim().toLowerCase();
  return MAILBOX_RE.test(value) && value.length <= 254 ? value : null;
};
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const hashSeedMailbox = (mailbox: string) => sha256(`seed-mailbox:${mailbox}`);

export async function readSeedAuthorization(): Promise<SeedAuthorization | null> {
  const row = (await pool.query("SELECT value FROM system_settings WHERE key=$1", [SEED_AUTHORIZATION_KEY])).rows[0];
  return (row?.value as SeedAuthorization | undefined) ?? null;
}

/** Why a seed send cannot proceed under this authorization, or null when it may. */
export function seedAuthorizationProblem(auth: SeedAuthorization | null, now = new Date()): string | null {
  if (!auth) return "SEED_NOT_AUTHORIZED";
  if (auth.revokedAt) return "SEED_AUTHORIZATION_REVOKED";
  if (new Date(auth.expiresAt).getTime() <= now.getTime()) return "SEED_AUTHORIZATION_EXPIRED";
  if (auth.unsubscribedAt) return "SEED_MAILBOX_UNSUBSCRIBED";
  if (auth.sentCount >= auth.maxMessages) return "SEED_MESSAGE_LIMIT_REACHED";
  return null;
}

/**
 * Transport-side verification. Everything is re-read from durable state: the authorization must be live, the
 * recipient must be exactly the authorized mailbox, the receipt must be this claimed message, and the caller must
 * not be attaching the message to any contact or inbound request. Returns the compliance loader whose unsubscribe
 * link is a seed link (never a contact link).
 */
export async function verifySeedTransportCapability(
  params: { to: string; category?: string; contactId?: number; intendedRecipientContactId?: number;
    inboundRequestId?: string; commercialPurpose?: string },
  capability: { receiptKey: string; occurrenceId: string },
): Promise<{ ok: true; complianceLoader: CommercialComplianceLoader } | { ok: false; error: string }> {
  try {
    if (params.category !== "cold_outreach") return { ok: false, error: "SEED_CATEGORY_MUST_BE_COLD_OUTREACH" };
    if (params.contactId !== undefined || params.intendedRecipientContactId !== undefined || params.inboundRequestId) {
      return { ok: false, error: "SEED_MUST_NOT_REFERENCE_A_CONTACT" };
    }
    if (process.env.EMAIL_OVERRIDE_TO?.trim()) return { ok: false, error: "SEED_REFUSED_WHILE_DELIVERY_REDIRECT_ACTIVE" };
    const auth = await readSeedAuthorization();
    // A message already counted at claim time must still be sendable, so the limit is not re-checked here.
    const problem = seedAuthorizationProblem(auth ? { ...auth, sentCount: 0 } : auth);
    if (problem) return { ok: false, error: problem };
    const recipient = normalizeSeedMailbox(params.to);
    if (!recipient || recipient !== auth!.mailbox) return { ok: false, error: "SEED_RECIPIENT_NOT_THE_AUTHORIZED_MAILBOX" };
    const receipt = (await pool.query("SELECT value FROM system_settings WHERE key=$1", [capability.receiptKey]))
      .rows[0]?.value as SeedReceipt | undefined;
    if (!receipt || receipt.state !== "claimed") return { ok: false, error: "SEED_RECEIPT_NOT_CLAIMED" };
    if (receipt.mailboxHash !== auth!.mailboxHash || receipt.occurrenceId !== capability.occurrenceId) {
      return { ok: false, error: "SEED_RECEIPT_MISMATCH" };
    }
    const { getCommercialComplianceConfig } = await import("./can-spam-footer");
    const { generateSeedUnsubscribeToken } = await import("./unsubscribe-token");
    return {
      ok: true,
      complianceLoader: async () => {
        const base = await getCommercialComplianceConfig();
        if (!base.ok) return base;
        const appUrl = process.env.APP_URL?.trim();
        let origin: string;
        try {
          const parsed = new URL(appUrl ?? "");
          if (parsed.protocol !== "https:") throw new Error("https required");
          origin = parsed.origin;
        } catch { return { ok: false, error: "COMPLIANCE_APP_URL_INVALID" }; }
        try {
          return { ...base, unsubscribeUrl: `${origin}/unsubscribe?t=${encodeURIComponent(generateSeedUnsubscribeToken(capability.occurrenceId))}` };
        } catch { return { ok: false, error: "COMPLIANCE_UNSUBSCRIBE_SECRET_MISSING" }; }
      },
    };
  } catch {
    return { ok: false, error: "SEED_AUTHORITY_UNAVAILABLE" };
  }
}

/**
 * Apply a seed unsubscribe. Records a seed event and ends the seed authorization for that mailbox. It touches no
 * contact, consent record, suppression or sequence, and is idempotent per occurrence.
 */
export async function applySeedUnsubscribe(occurrenceId: string): Promise<{ recorded: boolean; known: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT key, value FROM system_settings WHERE key LIKE 'sfp_seed_test_receipt:%' AND value->>'occurrenceId'=$1 FOR UPDATE`,
      [occurrenceId]);
    const receipt = found.rows[0]?.value as SeedReceipt | undefined;
    if (!receipt) { await client.query("COMMIT"); return { recorded: false, known: false }; }
    const event = { occurrenceId, mailboxHash: receipt.mailboxHash, receiptKey: found.rows[0].key, at: new Date().toISOString() };
    const inserted = await client.query(
      `INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(key) DO NOTHING RETURNING id`,
      [seedUnsubscribeKey(occurrenceId), JSON.stringify(event)]);
    await client.query(
      `UPDATE system_settings SET value=jsonb_set(value,'{unsubscribedAt}',to_jsonb($2::text)), updated_at=NOW()
        WHERE key=$1 AND value->>'mailboxHash'=$3 AND value->>'unsubscribedAt' IS NULL`,
      [SEED_AUTHORIZATION_KEY, event.at, receipt.mailboxHash]);
    await client.query("COMMIT");
    return { recorded: (inserted.rowCount ?? 0) > 0, known: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
