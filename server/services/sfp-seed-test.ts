/**
 * Seed-test rendering (read-only) and the operator seed send. Shows exactly what each current launch package would put in a recipient's inbox
 * (subject and body from the same renderer the sequence worker uses) for a clearly fictional recipient.
 *
 * Nothing here writes, sends, reserves capacity or touches a contact. A real send of a seed message is a separate,
 * operator-approved step because the transport's commercial boundary refuses marketing sends to anything but a
 * production recipient with a current business link.
 */
import { pool } from "../db";
import { randomUUID } from "node:crypto";
import { sfpLaunchRenderContext, renderSfpLaunchSubject, renderSfpLaunchBodyHtml } from "./sfp-launch-render";
import {
  SEED_AUTHORIZATION_KEY, SEED_MAX_AUTHORIZATION_HOURS, SEED_MAX_MESSAGES, seedReceiptKey, normalizeSeedMailbox, hashSeedMailbox,
  readSeedAuthorization, seedAuthorizationProblem, sha256, seedMessageHash, type SeedAuthorization, type SeedReceipt,
} from "./sfp-seed-authority";

export const SEED_PREVIEW_RECIPIENT = {
  firstName: "Seed", lastName: "Preview", companyName: "Seed Preview Business (fictional, not a prospect)",
  email: "seed-preview@invalid.example",
} as const;

export interface SeedRenderedStep {
  stepOrder: number; subject: string; html: string; unresolvedPlaceholders: string[];
}
export interface SeedRenderedPackage {
  packageKey: string; vertical: string; sequenceId: number; contentHash: string; steps: SeedRenderedStep[];
}
export interface SeedRenderPreview {
  recipient: typeof SEED_PREVIEW_RECIPIENT; fromAddress: string; replyTo: string;
  packages: SeedRenderedPackage[]; notes: string[];
}

const PLACEHOLDER = /\{\{[^}]*\}\}|\[\[[^\]]*\]\]|%[A-Za-z_]+%/g;

export async function previewSeedRendering(): Promise<SeedRenderPreview> {
  const ctx = sfpLaunchRenderContext(SEED_PREVIEW_RECIPIENT);
  const pkgs = await pool.query(
    `SELECT package_key, vertical, sequence_id, content_hash FROM sfp_campaign_package_versions
      WHERE lifecycle_state='current' ORDER BY package_key`);
  const packages: SeedRenderedPackage[] = [];
  for (const p of pkgs.rows) {
    const steps = await pool.query(
      `SELECT step_order, subject, body FROM sequence_steps WHERE sequence_id=$1 AND action_type='email' ORDER BY step_order`,
      [p.sequence_id]);
    packages.push({
      packageKey: p.package_key, vertical: p.vertical, sequenceId: Number(p.sequence_id), contentHash: p.content_hash,
      steps: steps.rows.map(s => {
        const subject = renderSfpLaunchSubject(s.subject, ctx);
        const html = renderSfpLaunchBodyHtml(s.body, ctx);
        const left = [...new Set([...(subject.match(PLACEHOLDER) ?? []), ...(html.match(PLACEHOLDER) ?? [])])];
        return { stepOrder: Number(s.step_order), subject, html, unresolvedPlaceholders: left };
      }),
    });
  }
  return {
    recipient: SEED_PREVIEW_RECIPIENT, fromAddress: ctx.agentEmail, replyTo: ctx.agentEmail, packages,
    notes: [
      "Rendered with the same renderer the sequence worker uses, for a fictional recipient. Nothing was sent or written.",
      "The compliance footer and the recipient-specific unsubscribe link are added by the transport at send time and are not shown here.",
    ],
  };
}

// ── Operator seed send ───────────────────────────────────────────────────────
// A seed send is a real message from the real cold sender to ONE mailbox the operator explicitly authorized. It goes
// through the same renderer and the same SMTP service (so the transport adds the same footer and unsubscribe headers),
// and the global outbound pause authority still applies. It creates no contact, enrollment, intent, release, send-log
// row or capacity count, and customer sending is not touched.

export class SeedTestError extends Error {
  constructor(public code: string, public status = 409, message?: string) { super(message ?? code); this.name = "SeedTestError"; }
}

const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The global pause is NOT lifted by a seed. This reports the ordinary decision (what every other sender sees) next to
 * whether the narrow seed lease can be granted from the current pause state.
 */
async function seedPauseView() {
  const { authorize, describeSeedLeaseEligibility } = await import("./outbound-pause-authority");
  const ordinary = await authorize({}).catch(() => null);
  const lease = await describeSeedLeaseEligibility();
  return {
    allowed: Boolean(ordinary?.allowed), reasonCode: ordinary?.reasonCode ?? "unavailable",
    seedLease: { eligible: lease.eligible, reasonCode: lease.reasonCode },
  };
}

export async function readSeedStatus() {
  const auth = await readSeedAuthorization();
  const pause = await seedPauseView();
  const receipts = (await pool.query(
    `SELECT key, value FROM system_settings WHERE key LIKE 'sfp_seed_test_receipt:%' ORDER BY updated_at DESC LIMIT 20`)).rows
    .map(r => ({ idempotencyKey: String(r.key).slice("sfp_seed_test_receipt:".length), ...(r.value as SeedReceipt) }));
  return {
    authorization: auth, blockedBecause: seedAuthorizationProblem(auth),
    outboundPause: pause,
    deliveryRedirectActive: Boolean(process.env.EMAIL_OVERRIDE_TO?.trim()),
    receipts,
  };
}

export async function authorizeSeedMailbox(input: { mailbox: unknown; expiresInHours?: unknown; maxMessages?: unknown; actorId: string }): Promise<SeedAuthorization> {
  const mailbox = normalizeSeedMailbox(input.mailbox);
  if (!mailbox) throw new SeedTestError("SEED_MAILBOX_INVALID", 400);
  const hours = input.expiresInHours === undefined ? 4 : Number(input.expiresInHours);
  const maxMessages = input.maxMessages === undefined ? 1 : Number(input.maxMessages);
  if (!Number.isInteger(hours) || hours < 1 || hours > SEED_MAX_AUTHORIZATION_HOURS) throw new SeedTestError("SEED_EXPIRY_OUT_OF_RANGE", 400);
  if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > SEED_MAX_MESSAGES) throw new SeedTestError("SEED_MESSAGE_LIMIT_OUT_OF_RANGE", 400);
  // A seed mailbox must never be a prospect: its unsubscribe and receipts are kept apart from real contacts.
  const prospect = (await pool.query("SELECT 1 FROM contacts WHERE lower(trim(email))=$1 LIMIT 1", [mailbox])).rows[0];
  if (prospect) throw new SeedTestError("SEED_MAILBOX_IS_A_CONTACT", 409);
  const now = new Date();
  const authorization: SeedAuthorization = {
    mailbox, mailboxHash: hashSeedMailbox(mailbox), nonce: randomUUID(), authorizedBy: input.actorId,
    authorizedAt: now.toISOString(), expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    maxMessages, sentCount: 0, unsubscribedAt: null, revokedAt: null,
  };
  await pool.query(`INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [SEED_AUTHORIZATION_KEY, JSON.stringify(authorization)]);
  return authorization;
}

export async function revokeSeedMailbox(): Promise<{ revoked: boolean }> {
  const result = await pool.query(
    `UPDATE system_settings SET value=jsonb_set(value,'{revokedAt}',to_jsonb($2::text)), updated_at=NOW()
      WHERE key=$1 AND value->>'revokedAt' IS NULL`, [SEED_AUTHORIZATION_KEY, new Date().toISOString()]);
  return { revoked: (result.rowCount ?? 0) > 0 };
}

async function buildSeedMessage(packageKey: string, stepOrder: number, auth: SeedAuthorization) {
  if (typeof packageKey !== "string" || !Number.isInteger(stepOrder) || stepOrder < 1) throw new SeedTestError("SEED_MESSAGE_SELECTION_INVALID", 400);
  const pkg = (await pool.query(
    `SELECT package_key, sequence_id, content_hash FROM sfp_campaign_package_versions WHERE lifecycle_state='current' AND package_key=$1`,
    [packageKey])).rows[0];
  if (!pkg) throw new SeedTestError("SEED_PACKAGE_NOT_CURRENT", 404);
  const step = (await pool.query(
    `SELECT step_order, subject, body FROM sequence_steps WHERE sequence_id=$1 AND step_order=$2 AND action_type='email'`,
    [pkg.sequence_id, stepOrder])).rows[0];
  if (!step) throw new SeedTestError("SEED_STEP_NOT_FOUND", 404);
  const ctx = sfpLaunchRenderContext(SEED_PREVIEW_RECIPIENT);
  const subject = renderSfpLaunchSubject(step.subject, ctx);
  const html = renderSfpLaunchBodyHtml(step.body, ctx);
  const unresolved = [...new Set([...(subject.match(PLACEHOLDER) ?? []), ...(html.match(PLACEHOLDER) ?? [])])];
  const previewHash = sha256(JSON.stringify({ m: auth.mailboxHash, n: auth.nonce, p: pkg.package_key, c: pkg.content_hash,
    s: Number(step.step_order), subject, html, from: ctx.agentEmail }));
  return { packageKey: String(pkg.package_key), contentHash: String(pkg.content_hash), stepOrder: Number(step.step_order),
    subject, html, fromAddress: ctx.agentEmail, unresolvedPlaceholders: unresolved, previewHash };
}

/** What would be sent, to whom, and whether the pause currently allows it. Sends and writes nothing. */
export async function previewSeedSend(input: { packageKey: string; stepOrder: number }) {
  const auth = await readSeedAuthorization();
  const problem = seedAuthorizationProblem(auth);
  if (!auth) throw new SeedTestError("SEED_NOT_AUTHORIZED", 409);
  const message = await buildSeedMessage(input.packageKey, input.stepOrder, auth);
  const pause = await seedPauseView();
  return {
    mailbox: auth.mailbox, authorizationExpiresAt: auth.expiresAt, remainingMessages: Math.max(0, auth.maxMessages - auth.sentCount),
    blockedBecause: problem, outboundPause: pause,
    ...message,
    notes: ["The transport adds the compliance footer and a seed-only unsubscribe link and headers at send time.",
      "Nothing is sent by this preview."],
  };
}

export async function executeSeedSend(input: { packageKey: string; stepOrder: number; previewHash: string; idempotencyKey: string; actorId: string }) {
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) throw new SeedTestError("SEED_IDEMPOTENCY_KEY_REQUIRED", 400);
  const auth = await readSeedAuthorization();
  if (!auth) throw new SeedTestError("SEED_NOT_AUTHORIZED", 409);
  const key = seedReceiptKey(input.idempotencyKey);
  const requestFingerprint = sha256(`${input.packageKey}|${input.stepOrder}|${input.previewHash}`);
  const existing = (await pool.query("SELECT value FROM system_settings WHERE key=$1", [key])).rows[0]?.value as SeedReceipt | undefined;
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) throw new SeedTestError("SEED_IDEMPOTENCY_KEY_REUSED", 409);
    return { replayed: true, mailbox: auth.mailbox, receipt: existing };
  }
  const authProblem = seedAuthorizationProblem(auth);
  if (authProblem) throw new SeedTestError(authProblem, 409);
  const message = await buildSeedMessage(input.packageKey, input.stepOrder, auth);
  if (message.previewHash !== input.previewHash) throw new SeedTestError("SEED_PREVIEW_CHANGED", 409);
  if (message.unresolvedPlaceholders.length) throw new SeedTestError("SEED_UNRESOLVED_PLACEHOLDERS", 409);
  // Cheap, receipt-free refusal when the pause state cannot back a seed lease (unreadable or mid-activation). The global
  // pause itself stays on; the pause authority grants the per-message lease and re-checks everything at send time.
  const { describeSeedLeaseEligibility } = await import("./outbound-pause-authority");
  const lease = await describeSeedLeaseEligibility();
  if (!lease.eligible) throw new SeedTestError("SEED_PAUSE_STATE_UNAVAILABLE", 409, `Seed lease unavailable: ${lease.reasonCode}`);

  const occurrenceId = randomUUID();
  const receipt: SeedReceipt = {
    state: "claimed", mailboxHash: auth.mailboxHash, occurrenceId, requestFingerprint, packageKey: message.packageKey,
    stepOrder: message.stepOrder, subjectHash: sha256(message.subject), bodyHash: sha256(message.html),
    messageHash: seedMessageHash(message.subject, message.html), previewHash: message.previewHash,
    claimedAt: new Date().toISOString(), finishedAt: null, messageId: null, error: null, actorId: input.actorId,
  };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT value FROM system_settings WHERE key=$1 FOR UPDATE", [SEED_AUTHORIZATION_KEY]);
    const live = locked.rows[0]?.value as SeedAuthorization | undefined;
    const problem = seedAuthorizationProblem(live ?? null);
    if (!live || live.nonce !== auth.nonce || problem) {
      await client.query("ROLLBACK");
      throw new SeedTestError(problem ?? "SEED_AUTHORIZATION_CHANGED", 409);
    }
    const inserted = await client.query(`INSERT INTO system_settings(key,value,updated_at) VALUES($1,$2::jsonb,NOW())
      ON CONFLICT(key) DO NOTHING RETURNING id`, [key, JSON.stringify(receipt)]);
    if (!inserted.rowCount) { await client.query("ROLLBACK"); throw new SeedTestError("SEED_CONCURRENT_REQUEST", 409); }
    await client.query(`UPDATE system_settings SET value=jsonb_set(value,'{sentCount}',to_jsonb(($2::int)), true), updated_at=NOW() WHERE key=$1`,
      [SEED_AUTHORIZATION_KEY, live.sentCount + 1]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }

  const { sendSmtpEmail } = await import("./smtp-email");
  const result = await sendSmtpEmail({
    to: auth.mailbox, subject: message.subject, html: message.html, category: "cold_outreach",
    unsubscribeMailto: "Scott@mail.libertybancard.com", seedTest: { receiptKey: key, occurrenceId },
  });
  const state = result.success ? "sent" : result.outcome === "unsent" ? "unsent" : "uncertain";
  const finished: SeedReceipt = { ...receipt, state, finishedAt: new Date().toISOString(),
    messageId: result.messageId ?? null, error: result.success ? null : (result.error ?? "SEND_FAILED") };
  await pool.query("UPDATE system_settings SET value=$2::jsonb, updated_at=NOW() WHERE key=$1", [key, JSON.stringify(finished)]);
  // Proven unsent: give the message back. Uncertain stays counted and is never retried automatically.
  if (state === "unsent") {
    await pool.query(`UPDATE system_settings SET value=jsonb_set(value,'{sentCount}',to_jsonb(GREATEST(0,(value->>'sentCount')::int-1))), updated_at=NOW()
      WHERE key=$1 AND value->>'nonce'=$2`, [SEED_AUTHORIZATION_KEY, auth.nonce]);
  }
  return { replayed: false, mailbox: auth.mailbox, receipt: finished };
}
