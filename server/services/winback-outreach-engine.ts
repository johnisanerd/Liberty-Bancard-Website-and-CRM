/**
 * winback-outreach-engine.ts  (#1407)
 *
 * Executes WINBACK_OUTREACH NBA actions that are marked automationEligible=true.
 * Runs on a nightly BullMQ schedule after the churn-score job so save cases and
 * NBA recommendations are already fresh.
 *
 * For each eligible contact:
 *  1. Check communication arbitration (suppression/DNC/human-touch gate)
 *  2. Send a personalised win-back email via SMTP
 *  3. Mark the NBA row as AUTO_EXECUTED
 *  4. Write an audit log row
 *
 * The engine intentionally stays minimal: it does not enroll contacts into a
 * sequence (no win-back sequence template exists yet) — it sends a single
 * targeted email and relies on the NBA engine's expiry/follow-up cycle to
 * re-evaluate next action after the email.
 */

import { db } from "../db";
import { contactNba, contacts, auditLogs } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { NBAService } from "./nba-service";
import { storage } from "../storage";
import { currentValidEmailPredicate } from "./zerobounce-eligibility";

const MAX_BATCH = parseInt(process.env.WINBACK_BATCH_SIZE ?? "50", 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWinbackHtml(contact: {
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}): string {
  const name =
    contact.companyName ||
    [contact.firstName, contact.lastName].filter(Boolean).join(" ") ||
    "there";

  const appUrl = process.env.APP_URL || "https://libertybancard.com";

  return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <p>Hi ${name},</p>

  <p>We noticed you haven't processed recently and wanted to check in. If you've had questions about rates, equipment, or your merchant account, we'd love to help get things back on track.</p>

  <p>Here's what we can do for you:</p>
  <ul>
    <li>Review your current rate schedule and identify savings</li>
    <li>Address any equipment or onboarding issues</li>
    <li>Connect you with your dedicated account manager</li>
  </ul>

  <p>Simply reply to this email or <a href="${appUrl}/get-started">book a quick call</a> — we'll take it from there.</p>

  <p>We value your business and look forward to hearing from you.</p>

  <p>Best regards,<br/>
  The Liberty Bancard Team</p>

  <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0"/>
  <p style="font-size:12px;color:#6b7280">
    Liberty Bancard LLC · 1 SE 3rd Ave · Miami FL 33131
  </p>
</div>`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runWinbackOutreachEngine(): Promise<{
  checked: number;
  sent: number;
  suppressed: number;
  errors: number;
}> {
  // Global outbound pause gate — upgraded to OutboundPauseAuthority + coordinator (#1532)
  {
    const { authorize } = await import("./outbound-pause-authority");
    const { canExecute } = await import("./outbound-queue-coordinator");
    const decision = await authorize({});
    if (!decision.allowed) {
      console.log(`[WinbackOutreach] Blocked by OutboundPauseAuthority (reason=${decision.reasonCode})`);
      return { checked: 0, sent: 0, suppressed: 0, errors: 0 };
    }
    const coordOk = await canExecute("winback-outreach");
    if (!coordOk) {
      console.log("[WinbackOutreach] Blocked by coordinator hold on 'winback-outreach'");
      return { checked: 0, sent: 0, suppressed: 0, errors: 0 };
    }
  }

  // 1. Pull all OPEN, automationEligible WINBACK_OUTREACH NBAs
  const candidates = await db.execute<{
    nba_id: number;
    contact_id: number;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    email_status: string | null;
  }>(sql`
    SELECT
      n.id          AS nba_id,
      n.contact_id,
      c.email,
      c.first_name,
      c.last_name,
      c.company_name,
      c.email_status
    FROM contact_nba n
    JOIN contacts c ON c.id = n.contact_id
    WHERE n.action_type    = 'WINBACK_OUTREACH'
      AND n.automation_eligible = true
      AND n.status         = 'OPEN'
      AND (n.expires_at IS NULL OR n.expires_at > NOW())
      AND c.email IS NOT NULL
      AND c.email != ''
      AND ${sql.raw(currentValidEmailPredicate("c"))}
    ORDER BY n.due_at ASC NULLS LAST
    LIMIT ${MAX_BATCH}
  `);

  const rows = candidates.rows as Array<{
    nba_id: number;
    contact_id: number;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    company_name: string | null;
    email_status: string | null;
  }>;

  let sent = 0;
  let suppressed = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      if (!row.email) continue;

      // 2. Arbitration check
      const { shouldSuppress } = await import("./communication-arbitration");
      const arb = await shouldSuppress(row.contact_id, "email");
      if (arb.suppressed) {
        suppressed++;
        console.log(`[WinbackEngine] Contact #${row.contact_id} suppressed: ${arb.reason}`);
        continue;
      }

      // 3. Canonical email permission decision immediately before SMTP.
      const { evaluateContactability } = await import("./contactability");
      const contactability = await evaluateContactability({
        contactId: row.contact_id,
        channel: "email",
        campaignType: "winback_outreach",
        mode: "enforcement",
      });
      if (!contactability.allowed) {
        suppressed++;
        console.log(`[WinbackEngine] Contact #${row.contact_id} blocked: ${contactability.reason}`);
        continue;
      }

      // 4. Send win-back email via SMTP
      const { sendSmtpEmail, isSmtpConfigured } = await import("./smtp-email");
      if (!isSmtpConfigured()) {
        console.warn("[WinbackEngine] SMTP not configured — skipping win-back sends");
        break;
      }

      const appUrl = process.env.APP_URL || "https://libertybancard.com";
      const unsubUrl = `${appUrl}/unsubscribe`;
      const unsubMailto = `unsubscribe@libertybancard.com?subject=unsubscribe&body=${encodeURIComponent(row.email)}`;

      const result = await sendSmtpEmail({
        to: row.email,
        subject: "Let's reconnect — Liberty Bancard",
        html: buildWinbackHtml({
          firstName: row.first_name,
          lastName: row.last_name,
          companyName: row.company_name,
        }),
        category: "accounts",
        contactId: row.contact_id,
        unsubscribeUrl: unsubUrl,
        unsubscribeMailto: `mailto:${unsubMailto}`,
      });

      if (!result.success) {
        console.warn(`[WinbackEngine] Email send failed for contact #${row.contact_id}: ${result.error}`);
        errors++;
        continue;
      }

      // 5. Mark NBA as AUTO_EXECUTED
      await NBAService.executeNBA(row.contact_id, "AUTO_EXECUTED");

      // 6. Audit log
      await storage.createAuditLog({
        action: "winback_outreach_sent",
        entityType: "contact",
        entityId: row.contact_id,
        actorType: "system",
        details: {
          nbaId: row.nba_id,
          email: row.email,
          messageId: result.messageId,
        },
      });

      sent++;
    } catch (err: any) {
      console.error(`[WinbackEngine] Error processing contact #${row.contact_id}:`, err?.message ?? err);
      errors++;
    }
  }

  console.log(
    `[WinbackEngine] Complete: checked=${rows.length} sent=${sent} suppressed=${suppressed} errors=${errors}`,
  );
  return { checked: rows.length, sent, suppressed, errors };
}
