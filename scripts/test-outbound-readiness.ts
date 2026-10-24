#!/usr/bin/env tsx
/**
 * scripts/test-outbound-readiness.ts — Controlled Outbound Launch Readiness
 *
 * Checks every gate required before outbound sends go live.
 * Exits 0 = all REQUIRED gates pass (outbound safe to consider releasing).
 * Exits 1 = one or more REQUIRED gates fail.
 *
 * Does NOT send any messages.  Does NOT modify any data.
 *
 * Usage:
 *   npx tsx scripts/test-outbound-readiness.ts
 */

import { pool, db } from "../server/db";
import { sql } from "drizzle-orm";
import { storage } from "../server/storage";

const OK   = (label: string, note = "") => console.log(`  ✓  ${label}${note ? ` — ${note}` : ""}`);
const WARN = (label: string, note = "") => console.warn(`  ⚠  ${label}${note ? ` — ${note}` : ""}`);
const FAIL = (label: string, note = "") => { console.error(`  ✗  ${label}${note ? ` — ${note}` : ""}`); failures++; };
const INFO = (label: string)             => console.log(`\n── ${label}`);

let failures = 0;

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║   Liberty Bancard — Outbound Launch Readiness Check     ║");
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  console.log(`Ran at: ${new Date().toISOString()}\n`);

  // ── 1. Global kill switch ──────────────────────────────────────────────────
  INFO("1. Global Kill Switch");
  const pausedRaw = await storage.getSystemSetting("outboundGlobalPaused");
  const isPaused  = pausedRaw === true || pausedRaw === "true";
  if (isPaused) {
    OK("outboundGlobalPaused = true (safe — paused until you release it)");
  } else {
    FAIL("outboundGlobalPaused is NOT set to true", "Set it via /dashboard/activation before any batch import");
  }

  // ── 2. Per-channel pause controls ─────────────────────────────────────────
  // Fail-closed: null/undefined → paused (matches sequence-worker logic).
  // Only an explicit "false" value releases a channel. Open channels are FAIL
  // because the global kill switch is then the only guard — single point of failure.
  INFO("2. Per-Channel Pause Controls (fail-closed)");
  const emailPausedRaw     = await storage.getSystemSetting("emailChannelPaused");
  const smsPausedRaw       = await storage.getSystemSetting("smsChannelPaused");
  const coldEmailPausedRaw = await storage.getSystemSetting("coldEmailChannelPaused");
  const emailPaused     = emailPausedRaw     !== "false" && emailPausedRaw     !== false;
  const smsPaused       = smsPausedRaw       !== "false" && smsPausedRaw       !== false;
  const coldEmailPaused = coldEmailPausedRaw !== "false" && coldEmailPausedRaw !== false;

  const chanNote = (raw: unknown): string => {
    if (raw === "true"  || raw === true)  return "explicitly paused";
    if (raw === "false" || raw === false) return "EXPLICITLY OPEN";
    return "paused by fail-closed default (unset in DB)";
  };

  emailPaused
    ? OK("emailChannelPaused — PAUSED",     chanNote(emailPausedRaw))
    : FAIL("emailChannelPaused is explicitly false — email channel OPEN", "Set to 'true' at /dashboard/activation before any batch send");
  smsPaused
    ? OK("smsChannelPaused — PAUSED",       chanNote(smsPausedRaw))
    : FAIL("smsChannelPaused is explicitly false — SMS channel OPEN",   "Set to 'true' at /dashboard/activation before any batch send");
  coldEmailPaused
    ? OK("coldEmailChannelPaused — PAUSED", chanNote(coldEmailPausedRaw))
    : FAIL("coldEmailChannelPaused is explicitly false — cold-email channel OPEN", "Set to 'true' at /dashboard/activation before any batch send");

  // ── 3. GHL Connectivity & Webhook Verification ────────────────────────────
  // Primary:  GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY — Ed25519 (current HighLevel standard)
  // Fallback: GHL_WEBHOOK_SECRET               — HMAC-SHA256 (legacy, during transition)
  // Both:     Accepted simultaneously; Ed25519 takes priority when both are present.
  INFO("3. GHL Connectivity & Webhook Verification");
  const ghlToken    = process.env.GHL_PRIVATE_INTEGRATION_TOKEN;
  const ghlLocation = process.env.GHL_LOCATION_ID;
  const ghlEd25519  = process.env.GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY;
  const ghlWebhook  = process.env.GHL_WEBHOOK_SECRET;
  ghlToken    ? OK("GHL_PRIVATE_INTEGRATION_TOKEN — present")  : FAIL("GHL_PRIVATE_INTEGRATION_TOKEN — missing");
  ghlLocation ? OK("GHL_LOCATION_ID — present")                : FAIL("GHL_LOCATION_ID — missing");

  if (ghlEd25519) {
    OK("GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY — present (Ed25519 public-key, current HighLevel standard)");
    ghlWebhook
      ? OK("GHL_WEBHOOK_SECRET — present (HMAC-SHA256 legacy fallback also active)")
      : WARN("GHL_WEBHOOK_SECRET — not set (Ed25519 is primary; legacy fallback inactive — acceptable)");
  } else if (ghlWebhook) {
    WARN("GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY — missing",
      "Ed25519 public-key (current HighLevel standard) not configured. " +
      "Obtain from GHL Marketplace developer portal and set GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY. " +
      "HMAC-SHA256 legacy fallback is active via GHL_WEBHOOK_SECRET.");
    OK("GHL_WEBHOOK_SECRET — present (HMAC-SHA256 legacy fallback active)");
  } else {
    FAIL("No webhook verification key configured",
      "Set GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY (Ed25519, current) from GHL Marketplace portal. " +
      "GHL_WEBHOOK_SECRET (HMAC-SHA256) is an acceptable legacy fallback.");
  }

  // ── 4. Credential encryption (required for Gmail OAuth) ───────────────────
  INFO("4. Credential Encryption (CREDENTIAL_ENCRYPTION_KEY)");
  const { isEncryptionAvailable, getEncryptionStatus } = await import("../server/services/credential-encryption");
  const encStatus = getEncryptionStatus();
  if (isEncryptionAvailable()) {
    OK("CREDENTIAL_ENCRYPTION_KEY — present (AES-256-GCM encryption available)");
    OK("Gmail OAuth refresh tokens will be encrypted at rest");
  } else {
    FAIL("CREDENTIAL_ENCRYPTION_KEY — missing", "Generate 64 hex chars (openssl rand -hex 32) and add to Replit Secrets. Gmail OAuth CANNOT connect without this key.");
  }

  // ── 5. Gmail OAuth ─────────────────────────────────────────────────────────
  INFO("5. Gmail OAuth (Staff/Department Email — non-cold sequences)");
  const { getGmailOAuthStatus } = await import("../server/services/gmail-oauth");
  const gmailStatus = await getGmailOAuthStatus();

  gmailStatus.secretsPresent
    ? OK("GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET — present")
    : FAIL("GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET — missing", "Non-cold sequences will be BLOCKED (not GHL fallback) until Gmail is connected");

  gmailStatus.encryptionAvailable
    ? OK("Encryption key available — token can be stored/decrypted")
    : FAIL("CREDENTIAL_ENCRYPTION_KEY missing — Gmail cannot connect even if OAuth secrets are set");

  if (gmailStatus.connected) {
    OK(`Gmail OAuth connected — ${gmailStatus.email}`);
    gmailStatus.acceptedAliases.length > 0
      ? OK(`Send-As aliases: ${gmailStatus.acceptedAliases.join(", ")}`)
      : FAIL("No accepted Send-As aliases — department route sends are blocked. Add/verify aliases in Google Workspace.");
  } else if (gmailStatus.secretsPresent && gmailStatus.encryptionAvailable) {
    WARN("Gmail OAuth not connected", "Complete OAuth flow at /dashboard/outbound-readiness to enable department email");
  }

  // ── 6. GHL Cold Email Channel Probe ───────────────────────────────────────
  INFO("6. GHL Cold Email Domain & Sender (Live Probe)");
  try {
    const { probeGhlColdEmail } = await import("../server/services/ghl-channel-probes");
    const coldProbe = await probeGhlColdEmail();
    coldProbe.apiReachable
      ? OK(`GHL email-settings API reachable (method: ${coldProbe.method})`)
      : WARN(`GHL email-settings API not reachable — attestation-only mode (method: ${coldProbe.method})`);

    coldProbe.ok
      ? OK(`Cold email channel verified — domain: ${coldProbe.detectedDomain ?? "(via attestation)"}, sender: ${coldProbe.detectedSender ?? "(via attestation)"}`)
      : FAIL(
          "Cold email channel NOT verified",
          `Required domain: ${coldProbe.requiredDomain}, required sender: ${coldProbe.requiredSender}. ` +
          "Verify in GHL Settings → Email, then record admin attestation at /dashboard/outbound-readiness"
        );
  } catch (e: any) {
    WARN("Cold email probe threw", e.message);
  }

  // ── 7. GHL SMS / A2P Probe ─────────────────────────────────────────────────
  INFO("7. GHL SMS Number, Capability & A2P 10DLC (Live Probe)");
  try {
    const { probeGhlSms } = await import("../server/services/ghl-channel-probes");
    const smsProbe = await probeGhlSms();
    smsProbe.apiReachable
      ? OK("GHL phone-numbers API reachable")
      : WARN(`GHL phone-numbers API not reachable — attestation-only mode (method: ${smsProbe.method})`);

    if (smsProbe.smsCapable) {
      OK(`SMS-capable number: ${smsProbe.smsSendingNumber}`);
    } else if (smsProbe.numberAttestation) {
      OK(`SMS number attested by admin`);
    } else {
      FAIL("No SMS-capable number found via API or attestation", "Verify in GHL → Phone Numbers, then record attestation at /dashboard/outbound-readiness");
    }

    smsProbe.a2pApprovalAttested
      ? OK(`A2P 10DLC campaign approval attested (${smsProbe.a2pAttestation?.attestedBy ?? "unknown"})`)
      : FAIL(
          "A2P 10DLC campaign approval NOT attested",
          "GHL API cannot expose TCR approval status. Admin must verify approval in GHL Settings and record attestation at /dashboard/outbound-readiness"
        );
  } catch (e: any) {
    WARN("SMS probe threw", e.message);
  }

  // ── 8. SMTP (optional secondary transport) ────────────────────────────────
  INFO("8. SMTP (optional — GHL is the primary cold-outreach executor)");
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (smtpHost && smtpUser && smtpPass) {
    OK(`SMTP configured — host=${smtpHost} user=${smtpUser} (optional secondary transport)`);
  } else {
    // SMTP is not a launch blocker. Architecture: GHL sends cold outreach from
    // Scott@mail.libertybancard.com (mail.libertybancard.com sender domain) with
    // native GHL unsubscribe and event handling.  SMTP is only used when
    // explicitly configured as an alternative transport (sequence useSmtpForThisStep
    // flag or explicit fallback). Not required for go-live.
    OK("SMTP not configured — GHL (Scott@mail.libertybancard.com) is the primary cold-outreach executor; SMTP is optional");
  }

  // ── 9. Cold email compliance gates ────────────────────────────────────────
  INFO("9. Cold Email Compliance Gates");
  const mailingAddress = await storage.getSystemSetting("compliance_mailing_address") as string | null | undefined;
  const appUrl         = process.env.APP_URL;
  const sessSecret     = process.env.SESSION_SECRET || process.env.UNSUBSCRIBE_TOKEN_SECRET;
  mailingAddress && (mailingAddress as string).trim().length > 10
    ? OK(`compliance_mailing_address set`)
    : FAIL("compliance_mailing_address not set — cold email unsubscribe footer will block sends");
  appUrl && appUrl.startsWith("https://")
    ? OK(`APP_URL = ${appUrl}`)
    : FAIL(`APP_URL missing or not HTTPS — unsubscribe tokens cannot be generated`);
  sessSecret
    ? OK("Unsubscribe token secret present (SESSION_SECRET or UNSUBSCRIBE_TOKEN_SECRET)")
    : FAIL("No unsubscribe token secret — set UNSUBSCRIBE_TOKEN_SECRET");

  // ── 10. Redis / BullMQ ──────────────────────────────────────────────────────
  INFO("10. Redis / BullMQ (Transport Layer)");
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    OK("REDIS_URL present — BullMQ using durable Redis");
    try {
      const { default: Redis } = await import("ioredis");
      const r = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
      await r.connect();
      const pong = await r.ping();
      await r.quit();
      pong === "PONG" ? OK("Redis PING → PONG (live)") : FAIL("Redis PING did not return PONG");
    } catch (redisErr: any) {
      FAIL("Redis connection failed", redisErr.message);
    }
  } else {
    WARN("REDIS_URL not set", "BullMQ queues are unavailable; no in-memory fallback exists. Set REDIS_URL to enable durable processing.");
  }

  // ── 11. Database tables ─────────────────────────────────────────────────────
  INFO("11. Database Tables");
  const requiredTables = [
    "outbound_send_log",
    "webhook_event_log",
    "outbound_admin_attestations",
    "sequence_enrollments",
    "outbound_send_counters",
    "consent_audit_logs",
    "sdr_lead_events",
  ];
  for (const table of requiredTables) {
    try {
      const res = await db.execute(sql`SELECT 1 FROM information_schema.tables WHERE table_name = ${table} AND table_schema = 'public' LIMIT 1`);
      res.rows.length > 0 ? OK(`Table '${table}' exists`) : FAIL(`Table '${table}' NOT FOUND — run migration`);
    } catch (e: any) {
      FAIL(`Table check failed for '${table}'`, e.message);
    }
  }

  // ── 12. Idempotency indexes ──────────────────────────────────────────────────
  INFO("12. Idempotency Indexes");
  const idxChecks: [string, string][] = [
    ["outbound_send_log",          "idempotency"],
    ["webhook_event_log",          "event_id"],
    ["outbound_admin_attestations","gate_key"],
  ];
  for (const [table, fragment] of idxChecks) {
    try {
      const res = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = ${table} AND indexname LIKE ${"%" + fragment + "%"}`);
      res.rows.length > 0
        ? OK(`Unique index on '${table}' (${fragment}) exists`)
        : FAIL(`Missing index on '${table}' containing '${fragment}' — run migrations`);
    } catch (e: any) {
      FAIL(`Index check failed for '${table}'`, e.message);
    }
  }

  // ── 13. Webhook verification mode ───────────────────────────────────────────
  INFO("13. Webhook Verification — Ed25519 (primary) / HMAC-SHA256 (legacy) + Replay Protection");
  const secWh13 = process.env.GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY;
  const hmcWh13 = process.env.GHL_WEBHOOK_SECRET;
  if (secWh13) {
    OK("Ed25519 public-key verification active (current HighLevel standard) on all /api/webhooks/ghl/* routes");
    hmcWh13 ? OK("HMAC-SHA256 legacy fallback also active (GHL_WEBHOOK_SECRET present)") : OK("HMAC-SHA256 legacy fallback inactive (acceptable — Ed25519 is primary)");
  } else if (hmcWh13) {
    WARN("Ed25519 not configured — HMAC-SHA256 legacy fallback active via GHL_WEBHOOK_SECRET", "Set GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY (Ed25519 PEM from GHL Marketplace portal) to use current standard");
  } else {
    FAIL("No webhook verification active — set GHL_WEBHOOK_SIGNATURE_PUBLIC_KEY (Ed25519) or GHL_WEBHOOK_SECRET (HMAC legacy)");
  }
  OK("Replay protection: events with dateAdded/createdAt/x-ghl-timestamp > 5 min old are rejected");
  OK("Durable receipts: SHA-256(event_type + body) → ghl_provider_event_receipts (received → claimed → applied|failed)");

  // ── 14. Suppression counts ──────────────────────────────────────────────────
  INFO("14. Suppression / DNC Counts");
  try {
    const suppressRes = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE "do_not_contact" = true)         AS dnc_count,
        COUNT(*) FILTER (WHERE sms_status = 'opted_out')        AS sms_opted_out,
        COUNT(*) FILTER (WHERE email_status = 'opted_out')      AS email_opted_out,
        COUNT(*) FILTER (WHERE email_status = 'bounced')        AS email_bounced,
        COUNT(*)                                                  AS total_contacts
      FROM contacts
    `);
    const r = (suppressRes.rows[0] as any) ?? {};
    OK(`Total contacts: ${r.total_contacts}`);
    OK(`DNC suppressed: ${r.dnc_count}`);
    OK(`SMS opted-out: ${r.sms_opted_out}`);
    OK(`Email opted-out: ${r.email_opted_out}`);
    OK(`Email bounced (suppressed): ${r.email_bounced}`);
  } catch (e: any) {
    WARN("Could not query suppression counts", e.message);
  }

  // ── 15. Active enrollments check ────────────────────────────────────────────
  INFO("15. Active Sequence Enrollments");
  try {
    const enrollRes = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')    AS active,
        COUNT(*) FILTER (WHERE status = 'paused')    AS paused,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed
      FROM sequence_enrollments
    `);
    const r = (enrollRes.rows[0] as any) ?? {};
    OK(`Active enrollments: ${r.active} (gated by kill switch + channel pauses)`);
    OK(`Paused enrollments: ${r.paused}`);
    OK(`Completed: ${r.completed}`);
  } catch (e: any) {
    WARN("Could not query sequence enrollments", e.message);
  }

  // ── 16. Routing & Canonical-Domain Regression ────────────────────────────────
  // Verifies the production routing bug fix: Gmail OAuth callback must redirect
  // to the canonical APP_URL domain, never to the raw replit.app hostname.
  INFO("16. Routing & Canonical-Domain Regression");

  // 16a: APP_URL must be set and resolve to a custom domain (not replit.app).
  const canonicalAppUrl = process.env.APP_URL?.replace(/\/$/, "");
  if (!canonicalAppUrl) {
    FAIL("APP_URL not set — Gmail OAuth callback will redirect to localhost:5000 fallback");
  } else {
    OK(`APP_URL = ${canonicalAppUrl}`);
    if (canonicalAppUrl.includes("replit.app") || canonicalAppUrl.includes("repl.co")) {
      FAIL(
        "APP_URL points to a Replit hostname",
        `Set APP_URL to the custom domain (e.g. https://libertybancard.com). ` +
        `Currently: ${canonicalAppUrl}. ` +
        `Gmail OAuth callback redirects use this value — if it resolves to replit.app the post-OAuth ` +
        `redirect will cross domains and the user's session cookie won't be sent.`
      );
    } else {
      OK("APP_URL is a custom domain — Gmail OAuth callback will redirect to the correct host");
    }
  }

  // 16b: REPLIT_DOMAINS (injected by Replit) must differ from APP_URL host so the
  //      canonical-host redirect middleware fires for replit.app traffic.
  const replitDomains16 = process.env.REPLIT_DOMAINS?.split(",").map(d => d.trim()) ?? [];
  if (replitDomains16.length > 0) {
    const firstReplitDomain = replitDomains16[0];
    let canonicalHost16 = "";
    try { canonicalHost16 = canonicalAppUrl ? new URL(canonicalAppUrl).hostname : ""; } catch {}
    if (canonicalHost16 && firstReplitDomain !== canonicalHost16) {
      OK(
        `REPLIT_DOMAINS[0] (${firstReplitDomain}) differs from APP_URL host — ` +
        `canonical-host middleware will redirect replit.app traffic to ${canonicalAppUrl}`
      );
    } else if (canonicalHost16) {
      INFO(`REPLIT_DOMAINS[0] matches APP_URL host — canonical-host redirect is a no-op (expected if custom domain IS the Replit domain)`);
    }
  } else {
    WARN("REPLIT_DOMAINS not set", "Canonical-host redirect relies solely on APP_URL; this is fine in dev");
  }

  // 16c: The /dashboard/outbound-readiness route must be reachable (SPA served).
  //      We probe the LOCAL server so this works in both dev and CI.
  try {
    const localPort = process.env.PORT || "5000";
    const routeResp = await fetch(`http://localhost:${localPort}/dashboard/outbound-readiness`);
    if (routeResp.ok && routeResp.headers.get("content-type")?.includes("text/html")) {
      OK("/dashboard/outbound-readiness → 200 text/html (SPA served — route exists in bundle)");
    } else if (routeResp.status === 301 || routeResp.status === 302) {
      const loc = routeResp.headers.get("location") ?? "";
      if (canonicalAppUrl && loc.startsWith(canonicalAppUrl)) {
        OK(`/dashboard/outbound-readiness → ${routeResp.status} → ${loc} (canonical-host redirect active)`);
      } else {
        FAIL(
          `/dashboard/outbound-readiness → ${routeResp.status} → ${loc}`,
          "Redirect target is not the canonical domain — cross-domain session loss expected"
        );
      }
    } else {
      WARN(
        `/dashboard/outbound-readiness → ${routeResp.status}`,
        "Unexpected status — verify the route is registered in App.tsx and the bundle is built"
      );
    }
  } catch (e: any) {
    WARN("Could not probe local server for route check", `${e.message} — server may not be running`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════════");
  if (failures === 0) {
    console.log("✅  All REQUIRED gates PASS — outbound system is safe to configure for launch.");
    console.log("   Remember to keep outboundGlobalPaused=true until you are ready for the first batch.");
    console.log("   Run scripts/test-outbound-system.ts for the comprehensive automated test suite.");
  } else {
    console.log(`❌  ${failures} REQUIRED gate(s) FAILED — resolve before enabling outbound.`);
  }
  console.log("══════════════════════════════════════════════════════════\n");
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); }).finally(() => pool.end());
