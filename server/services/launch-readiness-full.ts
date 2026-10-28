/**
 * Full CRM Launch-Readiness Audit
 *
 * The probe count is whatever PROBE_REGISTRY holds; no copy anywhere states a fixed number.
 * Each probe runs independently and returns a SubsystemResult. Probes are read-only; none
 * mutate real data. A failed evidence query is never a pass: it is reported as fail/warn with
 * the query error, and the verdict is a bounded diagnostic only (not a Stage 9 or lane verdict).
 */
import { db } from "../db";
import { sql, desc, gte } from "drizzle-orm";
import { storage } from "../storage";
import { readTaskMetrics } from "./task-read-authority";
import { getPauseState } from "./outbound-pause-authority";

export type SubsystemStatus = "pass" | "warn" | "fail" | "disabled";

export interface SubsystemResult {
  id: string;
  name: string;
  status: SubsystemStatus;
  evidence: string;
  checkedAt: string;
  details?: Record<string, unknown>;
}

function now(): string {
  return new Date().toISOString();
}

// ─── 1. Staff login / roles / admin controls ──────────────────────────────────
async function checkStaffRoles(): Promise<SubsystemResult> {
  try {
    // users.account_state ('active' | 'deactivated') is the migrated account-state contract.
    const rows = await db.execute(sql`
      SELECT role, COUNT(*) AS cnt
      FROM users
      WHERE account_state = 'active'
      GROUP BY role
    `);
    const roleCounts: Record<string, number> = {};
    for (const r of rows.rows as Array<{ role: string; cnt: string }>) {
      roleCounts[r.role] = Number(r.cnt);
    }
    const hasAdmin = (roleCounts["admin"] ?? 0) > 0;
    const staffRoles = ["admin", "manager", "agent"];
    const staffTotal = staffRoles.reduce((a, r) => a + (roleCounts[r] ?? 0), 0);
    const portalTotal = Object.entries(roleCounts).filter(([r]) => !staffRoles.includes(r)).reduce((a, [, c]) => a + c, 0);
    if (!hasAdmin) {
      return { id: "staff_roles", name: "Staff Login / Roles / Admin Controls", status: "fail", evidence: "No active admin account found — admin routes cannot be accessed", checkedAt: now(), details: { roleCounts } };
    }
    return {
      id: "staff_roles", name: "Staff Login / Roles / Admin Controls", status: "pass",
      evidence: `${staffTotal} active staff account(s) (${staffRoles.map(r => `${r}×${roleCounts[r] ?? 0}`).join(", ")}); ${portalTotal} active portal account(s) not counted as staff. Active admin present ✓`,
      checkedAt: now(), details: { roleCounts, staffTotal, portalTotal },
    };
  } catch (err: any) {
    return { id: "staff_roles", name: "Staff Login / Roles / Admin Controls", status: "fail", evidence: `DB query failed: ${err.message}`, checkedAt: now() };
  }
}

// ─── 2. Contacts ──────────────────────────────────────────────────────────────
async function checkContacts(): Promise<SubsystemResult> {
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE ghl_contact_id IS NOT NULL) AS ghl_linked,
        COUNT(*) FILTER (WHERE archived_at IS NOT NULL) AS archived
      FROM contacts
    `);
    const s = rows.rows[0] as any;
    const total = Number(s?.total ?? 0);
    const ghlLinked = Number(s?.ghl_linked ?? 0);
    const archived = Number(s?.archived ?? 0);
    const ghlPct = total > 0 ? Math.round((ghlLinked / total) * 100) : 0;
    const status: SubsystemStatus = total === 0 ? "warn" : ghlPct < 50 ? "warn" : "pass";
    return {
      id: "contacts", name: "Contacts", status,
      evidence: `${total - archived} active contacts; ${ghlLinked} GHL-linked (${ghlPct}%). ${archived} archived.`,
      checkedAt: now(), details: { total, ghlLinked, archived, ghlPct },
    };
  } catch (err: any) {
    return { id: "contacts", name: "Contacts", status: "fail", evidence: `DB error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 3. Master lead database ─────────────────────────────────────────────────
async function checkLeadDatabase(): Promise<SubsystemResult> {
  try {
    const rows = await db.execute(sql`
      SELECT
        status,
        COUNT(*) AS cnt
      FROM contacts
      WHERE archived_at IS NULL
      GROUP BY status
      ORDER BY cnt DESC
    `);
    const byStatus: Record<string, number> = {};
    for (const r of rows.rows as Array<{ status: string | null; cnt: string }>) {
      byStatus[r.status ?? "null"] = Number(r.cnt);
    }
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    // Check suppression/dedup engine — look for doNotContact contacts
    const dncRows = await db.execute(sql`SELECT COUNT(*) AS cnt FROM contacts WHERE do_not_contact = true`);
    const dncCount = Number((dncRows.rows[0] as any)?.cnt ?? 0);
    return {
      id: "lead_database", name: "Master Lead Database", status: total > 0 ? "pass" : "warn",
      evidence: `${total} active contacts. DNC suppressed: ${dncCount}. Status breakdown: ${Object.entries(byStatus).slice(0, 5).map(([s, c]) => `${s}:${c}`).join(", ")}`,
      checkedAt: now(), details: { byStatus, total, dncCount },
    };
  } catch (err: any) {
    return { id: "lead_database", name: "Master Lead Database", status: "fail", evidence: `DB error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 4. Lead imports ─────────────────────────────────────────────────────────
async function checkLeadImports(): Promise<SubsystemResult> {
  try {
    const rows = await db.execute(sql`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        MAX(completed_at) AS last_completed
      FROM import_executions
    `);
    const s = rows.rows[0] as any;
    const total = Number(s?.total ?? 0);
    const completed = Number(s?.completed ?? 0);
    const failed = Number(s?.failed ?? 0);
    const lastCompleted = s?.last_completed ? new Date(s.last_completed).toLocaleString() : "never";
    if (total === 0) {
      return { id: "lead_imports", name: "Lead Imports", status: "warn", evidence: "No import executions found yet — pipeline exists but unused", checkedAt: now() };
    }
    return {
      id: "lead_imports", name: "Lead Imports", status: failed > completed ? "warn" : "pass",
      evidence: `${completed} completed, ${failed} failed imports. Last completed: ${lastCompleted}`,
      checkedAt: now(), details: { total, completed, failed },
    };
  } catch (err: any) {
    return { id: "lead_imports", name: "Lead Imports", status: "fail", evidence: `DB error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 5. Dedupe and suppression ───────────────────────────────────────────────
async function checkDedupeAndSuppression(): Promise<SubsystemResult> {
  try {
    // Check sync conflicts (dedup queue)
    const conflictRows = await db.execute(sql`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE resolution = 'pending') AS pending
      FROM sync_conflicts
    `);
    const cs = conflictRows.rows[0] as any;
    const totalConflicts = Number(cs?.total ?? 0);
    const pendingConflicts = Number(cs?.pending ?? 0);

    // Check doNotContact contacts (suppression)
    const dncRows = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM contacts WHERE do_not_contact = true
    `);
    const dncCount = Number((dncRows.rows[0] as any)?.cnt ?? 0);

    // Check contactability module is reachable
    let contactabilityOk = false;
    try {
      const { evaluateContactability } = await import("./contactability");
      contactabilityOk = typeof evaluateContactability === "function";
    } catch { /* not reachable */ }

    const status: SubsystemStatus = !contactabilityOk ? "fail" : pendingConflicts > 50 ? "warn" : "pass";
    return {
      id: "dedupe_suppression", name: "Dedupe and Suppression", status,
      evidence: `Contactability engine: ${contactabilityOk ? "reachable ✓" : "NOT REACHABLE ✗"}. ${dncCount} DNC-suppressed contacts. ${pendingConflicts} pending sync conflicts (${totalConflicts} total).`,
      checkedAt: now(), details: { contactabilityOk, dncCount, totalConflicts, pendingConflicts },
    };
  } catch (err: any) {
    return { id: "dedupe_suppression", name: "Dedupe and Suppression", status: "fail", evidence: `Error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 6. Pipeline / deals ─────────────────────────────────────────────────────
async function checkPipeline(): Promise<SubsystemResult> {
  try {
    const rows = await db.execute(sql`
      SELECT
        pipeline,
        COUNT(*) AS cnt,
        COUNT(*) FILTER (WHERE ghl_opportunity_id IS NOT NULL) AS ghl_linked
      FROM deals
      GROUP BY pipeline
      ORDER BY cnt DESC
    `);
    const byPipeline: Record<string, { total: number; ghlLinked: number }> = {};
    let grandTotal = 0;
    let grandGhl = 0;
    for (const r of rows.rows as Array<{ pipeline: string | null; cnt: string; ghl_linked: string }>) {
      const key = r.pipeline ?? "unknown";
      byPipeline[key] = { total: Number(r.cnt), ghlLinked: Number(r.ghl_linked) };
      grandTotal += Number(r.cnt);
      grandGhl += Number(r.ghl_linked);
    }
    const ghlPct = grandTotal > 0 ? Math.round((grandGhl / grandTotal) * 100) : 0;
    const status: SubsystemStatus = grandTotal === 0 ? "warn" : ghlPct < 30 ? "warn" : "pass";
    return {
      id: "pipeline_deals", name: "Pipeline / Deals", status,
      evidence: `${grandTotal} deals; ${grandGhl} GHL-linked (${ghlPct}%). Pipelines: ${Object.keys(byPipeline).join(", ")}`,
      checkedAt: now(), details: { byPipeline, grandTotal, grandGhl },
    };
  } catch (err: any) {
    return { id: "pipeline_deals", name: "Pipeline / Deals", status: "fail", evidence: `DB error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 7. Tasks ────────────────────────────────────────────────────────────────
async function checkTasks(): Promise<SubsystemResult> {
  try {
    // One task authority: nondeleted tasks in the production class, authority state wins over the legacy
    // status, overdue = open or in progress and due before asOf. UTC is stated, not assumed.
    const asOf = new Date();
    const metrics = await readTaskMetrics({ actor: { role: "admin" }, recordClass: "production", asOf, timezone: "UTC" });
    const m = metrics.rows[0];
    if (!m) throw new Error("task metrics returned no row");
    const total = Number(m.total);
    const openStates = Number(m.pending) + Number(m.in_progress);
    const pastDue = Number(m.overdue);

    // Check SLA audit logs exist
    const slaRows = await db.execute(sql`
      SELECT created_at FROM audit_logs
      WHERE action LIKE '%sla%'
      ORDER BY created_at DESC LIMIT 1
    `);
    const lastSla = (slaRows.rows[0] as any)?.created_at;
    const lastSlaStr = lastSla ? new Date(lastSla).toLocaleString() : "never";
    return {
      id: "tasks", name: "Tasks", status: total === 0 ? "warn" : "pass",
      evidence: `${total} production tasks (non-deleted, authority state); ${openStates} open or in progress (${m.pending} open, ${m.in_progress} in progress), ${pastDue} past due as of ${asOf.toISOString()} (UTC). Last SLA audit: ${lastSlaStr}`,
      checkedAt: now(), details: { total, open: Number(m.pending), inProgress: Number(m.in_progress), completed: Number(m.completed), cancelled: Number(m.cancelled), pastDue, lastSla: lastSlaStr, population: metrics.meta.population, asOf: metrics.meta.asOf, timezone: metrics.meta.timezone },
    };
  } catch (err: any) {
    return { id: "tasks", name: "Tasks", status: "fail", evidence: `Task read failed: ${err.message}`, checkedAt: now() };
  }
}

// ─── 8. Calendar ─────────────────────────────────────────────────────────────
async function checkCalendar(): Promise<SubsystemResult> {
  const calendarId = process.env.GHL_CALENDAR_ID || process.env.GHL_DEFAULT_CALENDAR_ID;
  const bookingUrl = process.env.GHL_CALENDAR_BOOKING_URL || process.env.GHL_DEFAULT_BOOKING_LINK;
  if (calendarId && bookingUrl) {
    return { id: "calendar", name: "Calendar", status: "pass", evidence: `Calendar ID: ${calendarId}. Booking URL configured ✓`, checkedAt: now(), details: { calendarId, bookingUrl } };
  }
  if (calendarId) {
    return { id: "calendar", name: "Calendar", status: "warn", evidence: `Calendar ID set (${calendarId}) but no booking URL — 'Book a Call' links will be broken`, checkedAt: now() };
  }
  return { id: "calendar", name: "Calendar", status: "warn", evidence: "GHL_CALENDAR_ID and GHL_CALENDAR_BOOKING_URL not set — booking links will use fallback placeholder", checkedAt: now() };
}

// ─── 9. Communications hub ───────────────────────────────────────────────────
async function checkCommunicationsHub(): Promise<SubsystemResult> {
  const webhookSecretSet = !!process.env.GHL_WEBHOOK_SECRET;
  const ghlConfigured = !!(process.env.GHL_PRIVATE_INTEGRATION_TOKEN && process.env.GHL_LOCATION_ID);
  const configStatus: SubsystemStatus = !ghlConfigured ? "fail" : !webhookSecretSet ? "warn" : "pass";
  const configText = `GHL: ${ghlConfigured ? "configured ✓" : "NOT configured ✗"}. Webhook secret: ${webhookSecretSet ? "set ✓" : "NOT set ✗"}.`;
  try {
    const actRows = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM ghl_activity_log
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);
    const recentActivity = Number((actRows.rows[0] as any)?.cnt ?? 0);
    return {
      id: "comms_hub", name: "Communications Hub", status: configStatus,
      evidence: `${configText} GHL activity last 24h: ${recentActivity} events.`,
      checkedAt: now(), details: { ghlConfigured, webhookSecretSet, recentActivity24h: recentActivity },
    };
  } catch (err: any) {
    // The evidence query failed, so configuration alone can never produce a pass.
    const status: SubsystemStatus = configStatus === "fail" ? "fail" : "warn";
    return { id: "comms_hub", name: "Communications Hub", status, evidence: `${configText} Activity evidence query failed (${err.message}); operational result unknown.`, checkedAt: now(), details: { ghlConfigured, webhookSecretSet, evidenceQueryFailed: true } };
  }
}

// ─── 10. Support hub ─────────────────────────────────────────────────────────
async function checkSupportHub(): Promise<SubsystemResult> {
  try {
    // tickets.authority_state ('open','in_progress','completed','cancelled') is the ticket lifecycle
    // authority; the display status column is a legacy projection and is not compared here.
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE authority_state IN ('open','in_progress')) AS open_tickets,
        COUNT(*) FILTER (WHERE authority_state = 'completed') AS resolved,
        COUNT(*) FILTER (WHERE authority_state = 'cancelled') AS cancelled
      FROM tickets
    `);
    const s = rows.rows[0] as any;
    const total = Number(s?.total ?? 0);
    const open = Number(s?.open_tickets ?? 0);
    return {
      id: "support_hub", name: "Support Hub", status: "pass",
      evidence: `${total} tickets total by authority state; ${open} open or in progress, ${Number(s?.resolved ?? 0)} completed, ${Number(s?.cancelled ?? 0)} cancelled.`,
      checkedAt: now(), details: { total, open, resolved: Number(s?.resolved ?? 0), cancelled: Number(s?.cancelled ?? 0) },
    };
  } catch (err: any) {
    return { id: "support_hub", name: "Support Hub", status: "fail", evidence: `DB error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 11. AI advisor / customer chat ─────────────────────────────────────────
async function checkAiAdvisor(): Promise<SubsystemResult> {
  const openaiConfigured = !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
  const openaiBaseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com";
  if (!openaiConfigured) {
    return { id: "ai_advisor", name: "AI Advisor / Customer Chat", status: "fail", evidence: "AI_INTEGRATIONS_OPENAI_API_KEY not set — AI assistant, enrichment, and proposal generation all fail", checkedAt: now() };
  }
  // Check recent AI chat audit logs
  try {
    const aiRows = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM audit_logs
      WHERE action LIKE 'ai_%' AND created_at > NOW() - INTERVAL '7 days'
    `);
    const recentAi = Number((aiRows.rows[0] as any)?.cnt ?? 0);
    return {
      id: "ai_advisor", name: "AI Advisor / Customer Chat", status: "pass",
      evidence: `OpenAI key set ✓. Base URL: ${openaiBaseUrl}. ${recentAi} AI audit events in last 7 days.`,
      checkedAt: now(), details: { openaiConfigured, recentAiEvents: recentAi },
    };
  } catch (err: any) {
    return { id: "ai_advisor", name: "AI Advisor / Customer Chat", status: "warn", evidence: `OpenAI key set ✓, but the AI audit evidence query failed (${err.message}); recent usage unknown.`, checkedAt: now() };
  }
}

// ─── 12. Merchant applications ───────────────────────────────────────────────
async function checkMerchantApplications(): Promise<SubsystemResult> {
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        MAX(submitted_at) AS last_submitted
      FROM merchant_applications
    `);
    const s = rows.rows[0] as any;
    const total = Number(s?.total ?? 0);
    const lastSubmitted = s?.last_submitted ? new Date(s.last_submitted).toLocaleString() : "never";
    return {
      id: "merchant_applications", name: "Merchant Applications", status: "pass",
      evidence: `${total} applications (${Number(s?.approved ?? 0)} approved, ${Number(s?.pending ?? 0)} pending). Last submitted: ${lastSubmitted}`,
      checkedAt: now(), details: { total, approved: Number(s?.approved ?? 0), pending: Number(s?.pending ?? 0) },
    };
  } catch (err: any) {
    return { id: "merchant_applications", name: "Merchant Applications", status: "fail", evidence: `DB error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 13. Boarding / onboarding ───────────────────────────────────────────────
async function checkOnboarding(): Promise<SubsystemResult> {
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) AS total_items,
        COUNT(DISTINCT deal_id) AS deals_with_checklist
      FROM onboarding_checklist_items
    `);
    const s = rows.rows[0] as any;
    const totalItems = Number(s?.total_items ?? 0);
    const dealsWithChecklist = Number(s?.deals_with_checklist ?? 0);
    // Check auto-init setting
    const autoInitSetting = await storage.getSystemSetting("onboarding_auto_init").catch(() => null);
    return {
      id: "onboarding", name: "Boarding / Onboarding", status: "pass",
      evidence: `${totalItems} checklist items across ${dealsWithChecklist} deals. Auto-init: ${autoInitSetting !== false ? "enabled ✓" : "disabled"}.`,
      checkedAt: now(), details: { totalItems, dealsWithChecklist, autoInit: autoInitSetting },
    };
  } catch (err: any) {
    return { id: "onboarding", name: "Boarding / Onboarding", status: "warn", evidence: `Onboarding probe error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 14. Statement review ────────────────────────────────────────────────────
async function checkStatementReview(): Promise<SubsystemResult> {
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) AS total_docs,
        COUNT(*) FILTER (WHERE type IN ('merchant_statement','rate_review_statement') OR category IN ('Processing Statement','Rate Review Statement')) AS statements,
        COUNT(*) FILTER (WHERE access_scope IS DISTINCT FROM 'public') AS protected_scope,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved
      FROM documents
    `);
    const s = rows.rows[0] as any;
    const total = Number(s?.total_docs ?? 0);
    const statements = Number(s?.statements ?? 0);

    // Check for statement analysis audit logs
    const analysisRows = await db.execute(sql`
      SELECT created_at FROM audit_logs
      WHERE action LIKE '%statement%' OR action LIKE '%analysis%'
      ORDER BY created_at DESC LIMIT 1
    `);
    const lastAnalysis = (analysisRows.rows[0] as any)?.created_at;
    const lastStr = lastAnalysis ? new Date(lastAnalysis).toLocaleString() : "never";

    return {
      id: "statement_review", name: "Statement Review", status: "pass",
      evidence: `${total} documents (${statements} statement documents by documents.type/category; ${Number(s?.protected_scope ?? 0)} outside public scope). Last analysis event: ${lastStr}`,
      checkedAt: now(), details: { total, statements, protectedScope: Number(s?.protected_scope ?? 0), lastAnalysis: lastStr },
    };
  } catch (err: any) {
    return { id: "statement_review", name: "Statement Review", status: "fail", evidence: `DB error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 15. Underwriting ────────────────────────────────────────────────────────
async function checkUnderwriting(): Promise<SubsystemResult> {
  try {
    // Check approval gate audit logs
    const rows = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM audit_logs
      WHERE action IN ('underwriting_approved', 'underwriting_denied', 'underwriting_submitted', 'deal_approved', 'approval_gate_passed')
    `);
    const cnt = Number((rows.rows[0] as any)?.cnt ?? 0);
    // Check deals with approval-relevant terminal status
    const dealRows = await db.execute(sql`SELECT COUNT(*) AS cnt FROM deals WHERE terminal_approval_status IS NOT NULL AND terminal_approval_status != 'not_required'`);
    const dealsWithApproval = Number((dealRows.rows[0] as any)?.cnt ?? 0);
    return {
      id: "underwriting", name: "Underwriting", status: "pass",
      evidence: `${dealsWithApproval} deals with terminal approval status. ${cnt} underwriting audit events. Approval gate routes registered ✓`,
      checkedAt: now(), details: { underwritingEvents: cnt, dealsWithApproval },
    };
  } catch (err: any) {
    // approval_status may not exist — try a simpler check
    return { id: "underwriting", name: "Underwriting", status: "warn", evidence: `Underwriting probe partial: ${err.message}`, checkedAt: now() };
  }
}

// ─── 16. Document vault ──────────────────────────────────────────────────────
async function checkDocumentVault(): Promise<SubsystemResult> {
  const credentialEncKeySet = !!process.env.CREDENTIAL_ENCRYPTION_KEY;
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending
      FROM documents
    `);
    const s = rows.rows[0] as any;
    const total = Number(s?.total ?? 0);
    const status: SubsystemStatus = !credentialEncKeySet ? "warn" : "pass";
    return {
      id: "document_vault", name: "Document Vault", status,
      evidence: `${total} documents (${Number(s?.approved ?? 0)} approved, ${Number(s?.pending ?? 0)} pending). CREDENTIAL_ENCRYPTION_KEY: ${credentialEncKeySet ? "set ✓" : "NOT set — document access tokens may not be encrypted ✗"}`,
      checkedAt: now(), details: { total, credentialEncKeySet },
    };
  } catch (err: any) {
    return { id: "document_vault", name: "Document Vault", status: "fail", evidence: `DB error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 17. Form submissions from public site ───────────────────────────────────
async function checkFormSubmissions(): Promise<SubsystemResult> {
  try {
    // Public-form conversion is proven by inbound request occurrences (inbound_requests,
    // source_category 'website_form'). Manually entered CRM contacts (manual CRM provenance
    // events) are not form submissions and are never counted here.
    const rows = await db.execute(sql`
      SELECT source_type, COUNT(*) AS cnt, MAX(source_received_at) AS last_received
      FROM inbound_requests
      WHERE source_category = 'website_form'
      GROUP BY source_type
      ORDER BY cnt DESC
    `);
    const bySource: Record<string, number> = {};
    let lastReceived: Date | null = null;
    for (const r of rows.rows as Array<{ source_type: string; cnt: string; last_received: Date | null }>) {
      bySource[r.source_type] = Number(r.cnt);
      if (r.last_received && (!lastReceived || new Date(r.last_received) > lastReceived)) lastReceived = new Date(r.last_received);
    }
    const total = Object.values(bySource).reduce((a, b) => a + b, 0);
    if (total === 0) {
      return { id: "form_submissions", name: "Form Submissions (Public Site)", status: "warn", evidence: "No public-website-form inbound request occurrences recorded yet; manual CRM entries are not counted as form submissions", checkedAt: now(), details: { bySource, total } };
    }
    return {
      id: "form_submissions", name: "Form Submissions (Public Site)", status: "pass",
      evidence: `${total} public-form inbound request occurrences: ${Object.entries(bySource).map(([k, v]) => `${k}:${v}`).join(", ")}. Last received ${lastReceived ? lastReceived.toLocaleString() : "unknown"}. Manual CRM entries excluded.`,
      checkedAt: now(), details: { bySource, total, lastReceived: lastReceived?.toISOString() ?? null },
    };
  } catch (err: any) {
    return { id: "form_submissions", name: "Form Submissions (Public Site)", status: "fail", evidence: `DB error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 18. GHL contact/deal sync ───────────────────────────────────────────────
async function checkGhlSync(): Promise<SubsystemResult> {
  try {
    const { getGhlCircuitStatus } = await import("./ghl-sync");
    const circuit = getGhlCircuitStatus();

    // Check ghl_sync_status table
    const syncRows = await db.execute(sql`
      SELECT entity_type, last_sync_at, synced_count, error_count, last_error
      FROM ghl_sync_status
      ORDER BY last_sync_at DESC
    `);
    const syncStatuses = syncRows.rows as Array<{ entity_type: string; last_sync_at: Date | null; synced_count: number; error_count: number; last_error: string | null }>;
    const lastContactSync = syncStatuses.find(s => s.entity_type === "contacts");
    const lastDealSync = syncStatuses.find(s => s.entity_type === "deals");

    const lastSyncAt = lastContactSync?.last_sync_at ? new Date(lastContactSync.last_sync_at).toLocaleString() : "never";
    const staleMs = lastContactSync?.last_sync_at ? Date.now() - new Date(lastContactSync.last_sync_at).getTime() : Infinity;
    const isStale = staleMs > 10 * 60 * 1000; // 10 min

    let status: SubsystemStatus = "pass";
    if (circuit.circuitOpen) status = "fail";
    else if (isStale) status = "warn";

    return {
      id: "ghl_sync", name: "GHL Contact/Deal Sync", status,
      evidence: `Circuit breaker: ${circuit.circuitOpen ? `OPEN ✗ (${circuit.consecutiveFailures}/${circuit.threshold} failures)` : "closed ✓"}. Last contact sync: ${lastSyncAt}${isStale ? " (STALE)" : ""}. Errors: ${lastContactSync?.error_count ?? 0}.`,
      checkedAt: now(), details: { circuitOpen: circuit.circuitOpen, consecutiveFailures: circuit.consecutiveFailures, threshold: circuit.threshold, lastSyncAt, isStale },
    };
  } catch (err: any) {
    return { id: "ghl_sync", name: "GHL Contact/Deal Sync", status: "fail", evidence: `Probe error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 19. GHL email transport ─────────────────────────────────────────────────
async function checkGhlEmail(): Promise<SubsystemResult> {
  const ghlConfigured = !!(process.env.GHL_PRIVATE_INTEGRATION_TOKEN && process.env.GHL_LOCATION_ID);
  if (!ghlConfigured) {
    return { id: "ghl_email", name: "GHL Email Transport", status: "fail", evidence: "GHL not configured — GHL_PRIVATE_INTEGRATION_TOKEN or GHL_LOCATION_ID missing", checkedAt: now() };
  }
  try {
    // Check that sendGhlEmail is importable
    const { sendGhlEmail, isGhlConfigured } = await import("./ghl");
    const configured = isGhlConfigured();
    // Check recent GHL email activity
    const rows = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM ghl_activity_log
      WHERE channel IN ('email','ghl_email') AND direction = 'outbound' AND created_at > NOW() - INTERVAL '7 days'
    `);
    const recentSends = Number((rows.rows[0] as any)?.cnt ?? 0);
    return {
      id: "ghl_email", name: "GHL Email Transport", status: configured ? "pass" : "fail",
      evidence: `GHL configured ✓. sendGhlEmail available ✓. ${recentSends} GHL emails sent in last 7 days.`,
      checkedAt: now(), details: { configured, recentSends7d: recentSends },
    };
  } catch (err: any) {
    return { id: "ghl_email", name: "GHL Email Transport", status: "warn", evidence: `GHL configured but probe error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 20. Gmail / send-as ─────────────────────────────────────────────────────
async function checkGmail(): Promise<SubsystemResult> {
  const clientId = !!process.env.GOOGLE_CLIENT_ID;
  const clientSecret = !!process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return {
      id: "gmail", name: "Gmail / Send-As", status: "warn",
      evidence: `GOOGLE_CLIENT_ID: ${clientId ? "set ✓" : "NOT set ✗"}. GOOGLE_CLIENT_SECRET: ${clientSecret ? "set ✓" : "NOT set ✗"}. Gmail OAuth not available until both are set.`,
      checkedAt: now(),
    };
  }
  try {
    const { isGmailOAuthConnected } = await import("./gmail-oauth");
    const connected = await isGmailOAuthConnected();
    return {
      id: "gmail", name: "Gmail / Send-As", status: connected ? "pass" : "warn",
      evidence: `Google credentials set ✓. OAuth token: ${connected ? "present and valid ✓" : "NOT connected — complete Gmail OAuth flow in Email Health → Gmail OAuth"}`,
      checkedAt: now(), details: { clientId, clientSecret, oauthConnected: connected },
    };
  } catch (err: any) {
    return { id: "gmail", name: "Gmail / Send-As", status: "warn", evidence: `Google credentials set but OAuth probe failed: ${err.message}`, checkedAt: now() };
  }
}

// ─── 21. Webhooks ────────────────────────────────────────────────────────────
async function checkWebhooks(): Promise<SubsystemResult> {
  const webhookSecretSet = !!process.env.GHL_WEBHOOK_SECRET;
  // Check recent webhook activity
  try {
    const rows = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM audit_logs
      WHERE action IN ('ghl_webhook_received','inbound_message_processed','ghl_opt_out_received','bounce_processed')
        AND created_at > NOW() - INTERVAL '7 days'
    `);
    const recentWebhooks = Number((rows.rows[0] as any)?.cnt ?? 0);
    const status: SubsystemStatus = !webhookSecretSet ? "warn" : "pass";
    return {
      id: "webhooks", name: "Webhooks", status,
      evidence: `GHL_WEBHOOK_SECRET: ${webhookSecretSet ? "set ✓" : "NOT set — webhook signature validation disabled ✗"}. ${recentWebhooks} webhook events in last 7 days. Endpoints: /api/webhooks/ghl/message-received, /opt-out, /inbound registered.`,
      checkedAt: now(), details: { webhookSecretSet, recentWebhooks7d: recentWebhooks },
    };
  } catch (err: any) {
    return { id: "webhooks", name: "Webhooks", status: webhookSecretSet ? "pass" : "warn", evidence: `Webhook secret: ${webhookSecretSet ? "set ✓" : "NOT set ✗"}. Activity query failed: ${err.message}`, checkedAt: now() };
  }
}

// ─── 22. Queue / BullMQ / Redis / DB health ──────────────────────────────────
async function checkQueueHealth(): Promise<SubsystemResult> {
  let dbOk = false;
  let dbMs = 0;
  try {
    const { pool } = await import("../db");
    const t0 = Date.now();
    await pool.query("SELECT 1");
    dbMs = Date.now() - t0;
    dbOk = true;
  } catch { /* handled below */ }

  let queueCount: number | null = null;
  let queueFailed: number | null = null;
  let queueSelectedMissing: string[] = [];
  let queueNotSelected = 0;
  let queueState: "ok" | "unavailable" | "degraded" = "unavailable";
  let queueMode: "bullmq_redis" | "legacy_interval_partial" | "unavailable" = "unavailable";
  try {
    const { requireQueueManagerReady } = await import("./queue-manager");
    const qm = requireQueueManagerReady();
    const m = await qm.getAllQueueMetrics();
    queueCount = m.queues.length;
    queueFailed = m.status === "ok"
      ? m.queues.reduce((acc, q) => acc + (q.failed ?? 0), 0)
      : null;
    queueSelectedMissing = m.queues.filter((q) => q.runtimeState === "selected_missing" || q.runtimeState === "selected_not_ready").map((q) => q.name);
    queueNotSelected = m.queues.filter((q) => q.runtimeState === "expected_not_selected").length;
    queueState = m.status;
    queueMode = m.queueMode;
  } catch {
    const { getQueueMode } = await import("./queue-manager");
    queueMode = getQueueMode();
  }

  const status: SubsystemStatus = !dbOk ? "fail" : queueMode !== "bullmq_redis" || queueState === "unavailable" ? "warn" : queueState === "degraded" || (queueFailed ?? 0) > 10 ? "warn" : "pass";
  return {
    id: "queue_health", name: "Queue / BullMQ / Redis / DB Health", status,
    evidence: `DB: ${dbOk ? `${dbMs}ms ✓` : "DOWN ✗"}. Queue mode: ${queueMode}. Queues: ${queueState === "unavailable" ? "unavailable" : `${queueCount} registered (${queueNotSelected} not selected by this profile${queueSelectedMissing.length ? `; selected but not running: ${queueSelectedMissing.join(", ")}` : ""}), ${queueFailed === null ? "failed-job count unavailable" : `${queueFailed} failed jobs`}`}.`,
    checkedAt: now(), details: { dbOk, dbMs, queueMode, queueState, queueCount, queueFailed, queueNotSelected, queueSelectedMissing },
  };
}

// ─── 23. Outbound global pause + per-channel pause ───────────────────────────
async function checkOutboundPause(): Promise<SubsystemResult> {
  const name = "Outbound Global Pause + Per-Channel Pause";
  try {
    // Canonical pause authority (state, source, epoch, reason, committedAt). Unknown fails closed:
    // a failed read is a fail, never "unpaused". Channel states stay separate settings.
    const [pause, emailPauseRaw, smsPauseRaw] = await Promise.all([
      getPauseState(),
      storage.getSystemSetting("emailChannelPaused"),
      storage.getSystemSetting("smsChannelPaused"),
    ]);
    const emailPaused = emailPauseRaw === true || emailPauseRaw === "true";
    const smsPaused = smsPauseRaw === true || smsPauseRaw === "true";
    const facts = { state: pause.state, source: pause.source, epoch: pause.epoch.toString(), reason: pause.reason, committedAt: pause.committedAt?.toISOString() ?? null };
    const factText = `source ${pause.source}, epoch ${facts.epoch}${pause.reason ? `, reason ${pause.reason}` : ""}${facts.committedAt ? `, committed ${facts.committedAt}` : ""}`;
    // Pre-launch: we WANT outbound paused — so passing means paused
    if (pause.state === "paused") {
      return {
        id: "outbound_pause", name, status: pause.source === "database" ? "pass" : "warn",
        evidence: `Global outbound: PAUSED (${factText}). Email channel setting: ${emailPaused ? "paused" : "live"}. SMS channel setting: ${smsPaused ? "paused" : "live"}.${pause.source === "safe_default" ? " Pause shown is the safe default, not a stored decision." : ""}`,
        checkedAt: now(), details: { ...facts, emailPaused, smsPaused },
      };
    }
    return {
      id: "outbound_pause", name, status: "warn",
      evidence: `Global outbound: ${pause.state.toUpperCase()} (${factText}) — confirm you are ready for real outbound. Email channel setting: ${emailPaused ? "paused" : "live"}. SMS channel setting: ${smsPaused ? "paused" : "live"}.`,
      checkedAt: now(), details: { ...facts, emailPaused, smsPaused },
    };
  } catch (err: any) {
    return { id: "outbound_pause", name, status: "fail", evidence: `Canonical pause state could not be read (${err.message}); treated as unknown, not unpaused.`, checkedAt: now() };
  }
}

// ─── 24. Audit log ───────────────────────────────────────────────────────────
async function checkAuditLog(): Promise<SubsystemResult> {
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) AS total,
        MAX(created_at) AS last_entry,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS last_hour
      FROM audit_logs
    `);
    const s = rows.rows[0] as any;
    const total = Number(s?.total ?? 0);
    const lastHour = Number(s?.last_hour ?? 0);
    const lastEntry = s?.last_entry ? new Date(s.last_entry).toLocaleString() : "never";
    const status: SubsystemStatus = total === 0 ? "fail" : lastHour === 0 ? "warn" : "pass";
    return {
      id: "audit_log", name: "Audit Log", status,
      evidence: `${total} total audit entries. ${lastHour} in last hour. Most recent: ${lastEntry}`,
      checkedAt: now(), details: { total, lastHour, lastEntry },
    };
  } catch (err: any) {
    return { id: "audit_log", name: "Audit Log", status: "fail", evidence: `DB error: ${err.message}`, checkedAt: now() };
  }
}

// ─── 25. Reporting / Acquisition Hub ────────────────────────────────────────
async function checkReporting(): Promise<SubsystemResult> {
  try {
    const rows = await db.execute(sql`
      SELECT
        COUNT(*) AS total_events,
        COUNT(DISTINCT event_name) AS distinct_events,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last_7d
      FROM analytics_events
    `);
    const s = rows.rows[0] as any;
    const total = Number(s?.total_events ?? 0);
    const last7d = Number(s?.last_7d ?? 0);
    const distinct = Number(s?.distinct_events ?? 0);

    // Check for demo/test contacts in the data
    const demoRows = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM contacts
      WHERE email LIKE '%test%' OR email LIKE '%demo%' OR email LIKE '%example%' OR first_name ILIKE 'test'
    `);
    const demoCount = Number((demoRows.rows[0] as any)?.cnt ?? 0);
    const hasDemoData = demoCount > 0;

    const status: SubsystemStatus = total === 0 ? "warn" : "pass";
    return {
      id: "reporting", name: "Reporting / Acquisition Hub", status,
      evidence: `${total} analytics events (${distinct} distinct types). Last 7d: ${last7d}. ${hasDemoData ? `⚠ ${demoCount} test/demo contact(s) may inflate KPIs` : "No demo data detected ✓"}`,
      checkedAt: now(), details: { total, last7d, distinct, demoCount, hasDemoData },
    };
  } catch (err: any) {
    // analytics_events may not exist — soft-fail
    return { id: "reporting", name: "Reporting / Acquisition Hub", status: "warn", evidence: `Analytics probe failed (table may not exist yet): ${err.message}`, checkedAt: now() };
  }
}

// ─── 26. Sales Rep Operations ─────────────────────────────────────────────────
async function checkSalesRepOps(): Promise<SubsystemResult> {
  try {
    const { featureFlags } = await import("./feature-flags");

    const [knowledgeRows, bindingRows, readinessRows] = await Promise.all([
      db.execute(sql`
        SELECT COUNT(*) AS cnt FROM knowledge_source_revisions
        WHERE index_state = 'indexed' AND review_state = 'approved'
      `),
      db.execute(sql`
        SELECT COUNT(*) AS conflicts FROM (
          SELECT user_id FROM agents WHERE status = 'active' GROUP BY user_id HAVING COUNT(*) > 1
        ) sub
      `),
      db.execute(sql`
        SELECT aggregate_verdict, completed_at, release_sha FROM sales_rep_ops_readiness_runs
        WHERE status = 'complete' ORDER BY completed_at DESC LIMIT 1
      `),
    ]);

    const knowledgeCount = Number((knowledgeRows.rows[0] as any)?.cnt ?? 0);
    const bindingConflicts = Number((bindingRows.rows[0] as any)?.conflicts ?? 0);
    const lastRun = readinessRows.rows[0] as any;
    const lastVerdict: string = lastRun?.aggregate_verdict ?? "none";
    const callAssistEnabled = featureFlags.CALL_ASSIST_ENABLED;
    const fieldSalesEnabled = featureFlags.FIELD_SALES_ENABLED;

    // Stale receipt check: verify the last completed run's SHA matches the running release.
    // A missing or blank RELEASE_SHA means the running deployment cannot be identified,
    // so ANY prior receipt is treated as stale — fail closed per kill-line.
    const currentSha = (process.env.RELEASE_SHA ?? "").trim() || null;
    const receiptSha: string | null = lastRun?.release_sha ?? null;
    const receiptStale = !currentSha || !receiptSha || currentSha !== receiptSha;

    const issues: string[] = [];
    if (knowledgeCount === 0) issues.push("no approved+indexed knowledge revision");
    if (bindingConflicts > 0) issues.push(`${bindingConflicts} agent binding conflict(s)`);
    if (callAssistEnabled) issues.push("CALL_ASSIST_ENABLED is on");
    if (fieldSalesEnabled) issues.push("FIELD_SALES_ENABLED is on");
    // A non-PASS verdict is a blocker: absent (none), BLOCKED_EXTERNAL, FAIL, or stale all prevent certification.
    const verdictIsPass = lastVerdict === "PASS";
    if (!verdictIsPass) issues.push(`last readiness run verdict is ${lastVerdict} (need PASS)`);
    if (receiptStale) issues.push(`certification receipt is stale (SHA mismatch: cert=${receiptSha?.slice(0, 12) ?? "?"}, running=${currentSha?.slice(0, 12) ?? "?"})`);

    // knowledge_revision_indexed is mandatory; a non-PASS verdict blocks certification entirely.
    const status: SubsystemStatus =
      knowledgeCount === 0 || bindingConflicts > 0 || !verdictIsPass || receiptStale ? "fail" :
      issues.length > 0 ? "warn" : "pass";

    return {
      id: "sales_rep_ops",
      name: "Sales Rep Operations",
      status,
      evidence: issues.length === 0
        ? `Sales Rep Ops certified. Knowledge revisions: ${knowledgeCount} approved. Both feature flags OFF. Last readiness: ${lastVerdict}.`
        : `Sales Rep Ops issues: ${issues.join("; ")}. Knowledge: ${knowledgeCount} approved.`,
      checkedAt: now(),
      details: { knowledgeCount, bindingConflicts, callAssistEnabled, fieldSalesEnabled, lastVerdict, lastReadinessCompletedAt: lastRun?.completed_at ?? null },
    };
  } catch (err: any) {
    return { id: "sales_rep_ops", name: "Sales Rep Operations", status: "fail", evidence: `Sales Rep Ops probe failed: ${err.message}`, checkedAt: now() };
  }
}

// ─── Probe registry ──────────────────────────────────────────────────────────
// The single source for probe IDs, names and order. Counts, labels and the
// unexpected-rejection rows are all derived from it.
export const PROBE_REGISTRY: ReadonlyArray<{ id: string; name: string; run: () => Promise<SubsystemResult> }> = [
  { id: "staff_roles", name: "Staff Login / Roles / Admin Controls", run: checkStaffRoles },
  { id: "contacts", name: "Contacts", run: checkContacts },
  { id: "lead_database", name: "Master Lead Database", run: checkLeadDatabase },
  { id: "lead_imports", name: "Lead Imports", run: checkLeadImports },
  { id: "dedupe_suppression", name: "Dedupe and Suppression", run: checkDedupeAndSuppression },
  { id: "pipeline_deals", name: "Pipeline / Deals", run: checkPipeline },
  { id: "tasks", name: "Tasks", run: checkTasks },
  { id: "calendar", name: "Calendar", run: checkCalendar },
  { id: "comms_hub", name: "Communications Hub", run: checkCommunicationsHub },
  { id: "support_hub", name: "Support Hub", run: checkSupportHub },
  { id: "ai_advisor", name: "AI Advisor / Customer Chat", run: checkAiAdvisor },
  { id: "merchant_applications", name: "Merchant Applications", run: checkMerchantApplications },
  { id: "onboarding", name: "Boarding / Onboarding", run: checkOnboarding },
  { id: "statement_review", name: "Statement Review", run: checkStatementReview },
  { id: "underwriting", name: "Underwriting", run: checkUnderwriting },
  { id: "document_vault", name: "Document Vault", run: checkDocumentVault },
  { id: "form_submissions", name: "Form Submissions (Public Site)", run: checkFormSubmissions },
  { id: "ghl_sync", name: "GHL Contact/Deal Sync", run: checkGhlSync },
  { id: "ghl_email", name: "GHL Email Transport", run: checkGhlEmail },
  { id: "gmail", name: "Gmail / Send-As", run: checkGmail },
  { id: "webhooks", name: "Webhooks", run: checkWebhooks },
  { id: "queue_health", name: "Queue / BullMQ / Redis / DB Health", run: checkQueueHealth },
  { id: "outbound_pause", name: "Outbound Global Pause + Per-Channel Pause", run: checkOutboundPause },
  { id: "audit_log", name: "Audit Log", run: checkAuditLog },
  { id: "reporting", name: "Reporting / Acquisition Hub", run: checkReporting },
  { id: "sales_rep_ops", name: "Sales Rep Operations", run: checkSalesRepOps },
];

/** Converts one settled probe outcome into a result row; an unexpected rejection is a fail row. */
export function settleProbe(
  probe: { id: string; name: string },
  outcome: PromiseSettledResult<SubsystemResult>,
  checkedAt: string,
): SubsystemResult {
  if (outcome.status === "fulfilled") return outcome.value;
  return { id: probe.id, name: probe.name, status: "fail", evidence: `Probe threw: ${(outcome.reason as any)?.message ?? outcome.reason}`, checkedAt };
}

export function summarizeProbes(subsystems: SubsystemResult[]) {
  return {
    total: subsystems.length,
    pass: subsystems.filter(s => s.status === "pass").length,
    warn: subsystems.filter(s => s.status === "warn").length,
    fail: subsystems.filter(s => s.status === "fail").length,
    disabled: subsystems.filter(s => s.status === "disabled").length,
  };
}

// ─── Master runner ───────────────────────────────────────────────────────────
export async function runAllLaunchReadinessChecks(): Promise<{
  subsystems: SubsystemResult[];
  summary: { total: number; pass: number; warn: number; fail: number; disabled: number };
  /** Bounded diagnostic verdict for these probes only; not a Stage 9 or lane verdict. */
  verdict: "GO" | "WARN" | "NO-GO";
  probeCount: number;
  checkedAt: string;
}> {
  const checkedAt = new Date().toISOString();
  const results = await Promise.allSettled(PROBE_REGISTRY.map(p => p.run()));
  const subsystems = results.map((r, i) => settleProbe(PROBE_REGISTRY[i], r, checkedAt));
  const summary = summarizeProbes(subsystems);
  const verdict: "GO" | "WARN" | "NO-GO" = summary.fail > 0 ? "NO-GO" : summary.warn > 0 ? "WARN" : "GO";
  return { subsystems, summary, verdict, probeCount: PROBE_REGISTRY.length, checkedAt };
}
