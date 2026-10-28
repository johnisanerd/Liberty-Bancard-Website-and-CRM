import { db } from "../../db";
import { storage } from "../../storage";
import { sendingIdentities, dailyFunnelMetrics, identityPerformanceDaily, sdrLeadState } from "@shared/schema";
import { sql } from "drizzle-orm";
import { isGhlConfigured, sendGhlInternalNotification } from "../ghl";
import { isSmtpConfigured, sendSmtpEmail } from "../smtp-email";

function getEstDateString(date?: Date): string {
  return (date || new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export async function buildSdrDailyDigest(): Promise<{ html: string; summary: Record<string, any> }> {
  const today = getEstDateString();
  const yesterday = getEstDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const metricsRows = await db.select({
    leadsFound: sql<number>`coalesce(sum(${dailyFunnelMetrics.leadsFound}), 0)`,
    emailsSent: sql<number>`coalesce(sum(${dailyFunnelMetrics.emailsSent}), 0)`,
    smsSent: sql<number>`coalesce(sum(${dailyFunnelMetrics.smsSent}), 0)`,
    callsMade: sql<number>`coalesce(sum(${dailyFunnelMetrics.callsMade}), 0)`,
    replies: sql<number>`coalesce(sum(${dailyFunnelMetrics.replies}), 0)`,
    positiveReplies: sql<number>`coalesce(sum(${dailyFunnelMetrics.positiveReplies}), 0)`,
    meetingsBooked: sql<number>`coalesce(sum(${dailyFunnelMetrics.meetingsBooked}), 0)`,
    statementsReceived: sql<number>`coalesce(sum(${dailyFunnelMetrics.statementsReceived}), 0)`,
    proposalsSent: sql<number>`coalesce(sum(${dailyFunnelMetrics.proposalsSent}), 0)`,
    closedWon: sql<number>`coalesce(sum(${dailyFunnelMetrics.closedWon}), 0)`,
  }).from(dailyFunnelMetrics).where(
    sql`${dailyFunnelMetrics.date} = ${yesterday}
        AND ${dailyFunnelMetrics.vertical} IS NULL AND ${dailyFunnelMetrics.state} IS NULL AND ${dailyFunnelMetrics.sourceType} IS NULL`
  );

  const m = metricsRows[0] || {};
  const totalContacted = (m.emailsSent || 0) + (m.smsSent || 0) + (m.callsMade || 0);

  const bounceData = await db.select({
    totalBounced: sql<number>`coalesce(sum(${identityPerformanceDaily.bounced}), 0)`,
    totalSent: sql<number>`coalesce(sum(${identityPerformanceDaily.emailsSent}), 0)`,
    totalComplaints: sql<number>`coalesce(sum(${identityPerformanceDaily.complaints}), 0)`,
  }).from(identityPerformanceDaily).where(
    sql`${identityPerformanceDaily.date} = ${yesterday}`
  );

  const bd = bounceData[0] || {};
  const bounceRate = (bd.totalSent || 0) > 0 ? Math.round(((bd.totalBounced || 0) / (bd.totalSent || 1)) * 1000) / 10 : 0;
  const sendRate = (bd.totalSent || 0) > 0 ? Math.round((((bd.totalSent || 0) - (bd.totalBounced || 0)) / (bd.totalSent || 1)) * 1000) / 10 : 100;
  const replyRate = totalContacted > 0 ? Math.round(((m.replies || 0) / totalContacted) * 1000) / 10 : 0;

  const identities = await db.select().from(sendingIdentities);
  const activeCount = identities.filter(i => i.isActive).length;
  const pausedCount = identities.filter(i => !i.isActive || i.warmupStatus === "paused").length;

  const stuckLeadsData = await storage.getSdrStuckLeads();
  const topStuck = stuckLeadsData.slice(0, 5);

  const killSwitchTriggered = identities.some(i => i.healthScore != null && i.healthScore < 50);

  const summary = {
    date: yesterday,
    leadsContacted: totalContacted,
    emailsSent: m.emailsSent || 0,
    smsSent: m.smsSent || 0,
    callsMade: m.callsMade || 0,
    sendSuccessRate: sendRate,
    bounceRate,
    replyRate,
    replies: m.replies || 0,
    positiveReplies: m.positiveReplies || 0,
    positiveIntentRate: (m.replies || 0) > 0 ? Math.round(((m.positiveReplies || 0) / (m.replies || 1)) * 100) : 0,
    meetingsBooked: m.meetingsBooked || 0,
    statementsRequested: m.statementsReceived || 0,
    activeIdentities: activeCount,
    pausedIdentities: pausedCount,
    killSwitchTriggered,
    stuckLeadsCount: stuckLeadsData.length,
  };

  const stuckList = topStuck.length > 0
    ? topStuck.map(s => `<li><strong>${s.businessName}</strong> — ${s.currentStage} (${s.reason}, ${s.stageAgeDays || 0}d stuck)</li>`).join("")
    : "<li>None</li>";

  const html = `
<h2>SDR Pilot Daily Digest — ${yesterday}</h2>
<hr>
<h3>Outreach Stats</h3>
<ul>
  <li>Leads Contacted: <strong>${totalContacted}</strong></li>
  <li>Emails Sent: <strong>${m.emailsSent || 0}</strong></li>
  <li>SMS Sent: <strong>${m.smsSent || 0}</strong></li>
  <li>Calls Made: <strong>${m.callsMade || 0}</strong></li>
</ul>
<h3>Deliverability</h3>
<ul>
  <li>Send Success Rate: <strong>${sendRate}%</strong></li>
  <li>Bounce Rate: <strong>${bounceRate}%</strong></li>
</ul>
<h3>Reply Breakdown</h3>
<ul>
  <li>Total Replies: <strong>${m.replies || 0}</strong> (${replyRate}% reply rate)</li>
  <li>Positive Intent: <strong>${m.positiveReplies || 0}</strong> (${summary.positiveIntentRate}%)</li>
  <li>Meetings Booked: <strong>${m.meetingsBooked || 0}</strong></li>
  <li>Statements Requested: <strong>${m.statementsReceived || 0}</strong></li>
</ul>
<h3>Inbox Health</h3>
<ul>
  <li>Active Identities: <strong>${activeCount}</strong></li>
  <li>Paused/Disabled: <strong>${pausedCount}</strong></li>
  <li>Kill-Switch Triggered: <strong>${killSwitchTriggered ? "⚠️ YES" : "No"}</strong></li>
</ul>
<h3>Top 5 Stuck Leads</h3>
<ol>${stuckList}</ol>
<p style="color:#888;font-size:12px;">Auto-generated SDR Pilot Digest — ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} EST</p>`;

  return { html, summary };
}

export async function sendSdrDailyDigest(digest: { html: string; summary: Record<string, any> }): Promise<void> {
  const adminEmail = process.env.ADMIN_DIGEST_EMAIL;
  if (!adminEmail) {
    console.warn("[Digest] ADMIN_DIGEST_EMAIL not set — daily digest skipped");
    return;
  }

  const recipients: string[] = [adminEmail];
  const adminUsers = await storage.getUsersByRole(["admin", "manager"]);
  for (const user of adminUsers) {
    if (user.email && !recipients.includes(user.email)) {
      recipients.push(user.email);
    }
  }

  for (const email of recipients) {
    if (isGhlConfigured()) {
      try {
        await sendGhlInternalNotification({
          email,
          subject: `SDR Pilot Daily Digest — ${digest.summary.date}`,
          body: digest.html,
          fromEmail: "accounts@libertybancard.com",
          fromName: "Liberty Bancard",
        });
        console.log(`[SDR Digest] Delivered via GHL to ${email}`);
        continue;
      } catch (err) {
        console.warn(`[SDR Digest] GHL delivery failed for ${email}, trying SMTP:`, err);
      }
    }
    if (isSmtpConfigured()) {
      const result = await sendSmtpEmail({ to: email, subject: `SDR Pilot Daily Digest — ${digest.summary.date}`, html: digest.html, category: "internal_ops" });
      if (result.success) {
        console.log(`[SDR Digest] Delivered via SMTP to ${email}`);
      } else {
        console.error(`[SDR Digest] SMTP delivery failed for ${email}: ${result.error}`);
      }
    } else {
      console.warn(`[SDR Digest] No delivery channel for ${email} — set GHL workflow IDs or SMTP_PASS`);
    }
  }

  await storage.createAuditLog({
    action: "sdr_daily_digest_sent",
    entityType: "system",
    details: digest.summary,
  });
}
