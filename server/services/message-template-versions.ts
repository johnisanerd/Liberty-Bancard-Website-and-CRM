import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { messageTemplates, messageTemplateVersions } from "@shared/schema";
import { auditChange } from "./audit-change";
import { lintCopy, type CopyFinding } from "./message-copy-lint";
import { previewMessage } from "./message-token-registry";

/**
 * Four deliberately separate content/purpose commands exist for outbound wording:
 *  - save draft            -> writes only the draft row; live wording is untouched
 *  - publish content       -> promotes the draft to live wording as an immutable numbered version; never changes
 *                             isActive, workflow enablement, campaign state or any send capability
 *  - enable transactional  -> inbound-acknowledgements capability route (separate service)
 *  - activate campaign use -> setTemplateActive below; refuses wording that still fails the copy checks
 */

export class TemplateVersionError extends Error {
  constructor(message: string, public status: number, public findings?: CopyFinding[]) { super(message); }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const lintTemplate = (subject: string | null | undefined, body: string) => lintCopy(`${subject ?? ""}\n${body}`, "template");

async function lockTemplate(tx: Tx, id: number) {
  const [t] = await tx.select().from(messageTemplates).where(eq(messageTemplates.id, id)).for("update");
  if (!t) throw new TemplateVersionError("Template not found", 404);
  return t;
}

/** Records the pre-existing live wording as a published version once, so history starts from what was really live. */
async function ensureBaseline(tx: Tx, t: typeof messageTemplates.$inferSelect) {
  await tx.insert(messageTemplateVersions).values({
    templateId: t.id, version: t.contentVersion, baseVersion: t.contentVersion, state: "published",
    subject: t.subject, body: t.body, authorId: null, publishedBy: null, publishedAt: t.updatedAt ?? new Date(),
  }).onConflictDoNothing();
}

export async function getTemplateWorkspace(templateId: number) {
  const [template] = await db.select().from(messageTemplates).where(eq(messageTemplates.id, templateId));
  if (!template) throw new TemplateVersionError("Template not found", 404);
  const rows = await db.select().from(messageTemplateVersions).where(eq(messageTemplateVersions.templateId, templateId))
    .orderBy(desc(messageTemplateVersions.version));
  const draft = rows.find((r) => r.state === "draft") ?? null;
  const history = rows.filter((r) => r.state === "published");
  return {
    template,
    draft,
    history,
    liveFindings: lintTemplate(template.subject, template.body),
    draftFindings: draft ? lintTemplate(draft.subject, draft.body) : [],
  };
}

export function previewTemplate(input: { subject?: string | null; body: string }) {
  const preview = previewMessage("template", input, "html");
  return {
    subject: preview.subject,
    html: preview.body,
    unresolved: preview.unresolved,
    personas: preview.personas,
    findings: lintTemplate(input.subject, input.body),
    note: "Rendered by the same renderer that sends stored templates, with sample values. Nothing is sent or stored by previewing.",
  };
}

export interface FinalMessagePreview {
  channel: "email" | "sms";
  subject: string | null;
  /** Exactly what the send path hands to the provider for an email: body plus the marketing compliance footer. */
  html: string;
  text: string;
  htmlImagesOff: string;
  sender: { mode: "provider_default" | "unknown"; address: string | null; name: string | null; note: string };
  replyTo: { mode: "not_set" | "unknown"; address: string | null; note: string };
  /** What the transport really sends. Plain text below is generated reference text unless textTransmitted is true. */
  transport: { name: "ghl_conversations"; payloadFields: string[]; textTransmitted: boolean; note: string };
  logoCount: number;
  signaturePresent: boolean;
  signatureCount: number;
  footerCount: number;
  footer: { state: "applied" | "unavailable"; reason?: string };
  note: string;
}

/**
 * The final message as the stored-template send path assembles it. Uses the same footer renderer as the send (with a
 * sample unsubscribe link), so the previewed footer, plain-text part and sender facts are the real ones. When the
 * compliance prerequisites are missing the preview says so, because a real send would fail the same way.
 */
export async function previewTemplateFinal(input: { subject?: string | null; body: string; channel?: "email" | "sms" }) {
  const base = previewTemplate(input);
  if (input.channel !== "email") return { ...base, final: null as FinalMessagePreview | null };
  return { ...base, final: await buildFinalEmailPreview({ subject: base.subject, html: base.html }) };
}

/**
 * Final-email view shared by stored templates and workflow steps. It runs the same composer the transport uses
 * (renderEmailPartsForPurpose: one signature, one footer) and reads the payload fields from the same builder the
 * provider call uses, so what is shown is what is handed over. Sender facts the code cannot know are labelled unknown.
 */
export async function buildFinalEmailPreview(input: { subject: string | null; html: string }): Promise<FinalMessagePreview> {
  const { renderEmailPartsForPurpose, getCommercialComplianceConfig } = await import("./can-spam-footer");
  const { inspectPresentation } = await import("./email-presentation");
  const { buildGhlEmailPayload } = await import("./ghl");
  const loader = async () => {
    const real = await getCommercialComplianceConfig();
    return real.ok ? { ok: true as const, mailingAddress: real.mailingAddress, unsubscribeUrl: "https://libertybancard.com/unsubscribe?t=SAMPLE-TOKEN" } : real;
  };
  const sender: FinalMessagePreview["sender"] = {
    mode: "unknown", address: null, name: null,
    note: "Sent through the provider with its configured location sender. The From address is not stored here, so it is unknown to this preview.",
  };
  const replyTo: FinalMessagePreview["replyTo"] = {
    mode: "unknown", address: null,
    note: "No Reply-To is set by this wording. A sending path may supply one; it is not visible here.",
  };
  const imagesOff = (html: string) => html.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = /alt\s*=\s*"([^"]*)"/i.exec(tag)?.[1];
    return `<span style="border:1px dashed #999;padding:2px 6px;font-size:12px;color:#555;">${alt ? `[image: ${alt}]` : "[image]"}</span>`;
  });
  let html = input.html, text = "";
  let footer: FinalMessagePreview["footer"];
  let note = "Sample values and a sample unsubscribe link. Nothing is sent or stored by previewing.";
  try {
    const parts = await renderEmailPartsForPurpose({ html: input.html, purpose: "marketing_outreach", complianceLoader: loader });
    html = parts.html; text = parts.text; footer = { state: "applied" };
  } catch (err) {
    footer = { state: "unavailable", reason: err instanceof Error ? err.message : "COMPLIANCE_CONFIGURATION_UNAVAILABLE" };
    note = "The required compliance footer cannot be built, so a real send of this message would fail until that is configured.";
  }
  const facts = inspectPresentation(html);
  const payloadFields = Object.keys(buildGhlEmailPayload({ ghlContactId: "preview", subject: input.subject ?? "", html }));
  return {
    channel: "email", subject: input.subject, html, text, htmlImagesOff: imagesOff(html), sender, replyTo,
    transport: {
      name: "ghl_conversations", payloadFields, textTransmitted: payloadFields.includes("text"),
      note: "The provider call carries an HTML body only. The plain text shown is generated reference text; it is not sent as a separate part.",
    },
    logoCount: facts.logoCount, signaturePresent: facts.signatureCount > 0, signatureCount: facts.signatureCount, footerCount: facts.footerCount,
    footer, note,
  };
}

export async function saveDraft(templateId: number, input: { subject: string | null; body: string; baseVersion: number }, actorId: string) {
  return db.transaction(async (tx) => {
    const t = await lockTemplate(tx, templateId);
    if (input.baseVersion !== t.contentVersion) {
      throw new TemplateVersionError("The published wording changed since you opened it. Reopen the template before saving.", 409);
    }
    const [existing] = await tx.select().from(messageTemplateVersions)
      .where(and(eq(messageTemplateVersions.templateId, templateId), eq(messageTemplateVersions.state, "draft"))).for("update");
    let draft;
    if (existing) {
      [draft] = await tx.update(messageTemplateVersions).set({
        subject: input.subject, body: input.body, baseVersion: t.contentVersion, authorId: actorId, updatedAt: new Date(),
      }).where(eq(messageTemplateVersions.id, existing.id)).returning();
    } else {
      [draft] = await tx.insert(messageTemplateVersions).values({
        templateId, version: null, baseVersion: t.contentVersion, state: "draft",
        subject: input.subject, body: input.body, authorId: actorId,
      }).returning();
    }
    await auditChange({
      userId: actorId, action: "message_template_draft_saved", entityType: "message_template", entityId: templateId,
      details: { baseVersion: t.contentVersion, liveWordingChanged: false },
    }, tx);
    return draft;
  });
}

export async function discardDraft(templateId: number, actorId: string) {
  return db.transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const deleted = await tx.delete(messageTemplateVersions)
      .where(and(eq(messageTemplateVersions.templateId, templateId), eq(messageTemplateVersions.state, "draft"))).returning();
    if (deleted.length) {
      await auditChange({ userId: actorId, action: "message_template_draft_discarded", entityType: "message_template", entityId: templateId }, tx);
    }
    return { discarded: deleted.length };
  });
}

/** Promotes the saved draft to live wording. Does not touch isActive or anything that sends. */
export async function publishDraft(templateId: number, input: { expectedVersion: number }, actorId: string | null, actorType: "user" | "system" = "user") {
  return db.transaction(async (tx) => {
    const t = await lockTemplate(tx, templateId);
    if (input.expectedVersion !== t.contentVersion) {
      throw new TemplateVersionError("The published wording changed since you opened it. Reopen the template before publishing.", 409);
    }
    const [draft] = await tx.select().from(messageTemplateVersions)
      .where(and(eq(messageTemplateVersions.templateId, templateId), eq(messageTemplateVersions.state, "draft"))).for("update");
    if (!draft) throw new TemplateVersionError("Save a draft before publishing.", 409);
    if (draft.baseVersion !== t.contentVersion) {
      throw new TemplateVersionError("The draft was written against older wording. Save it again before publishing.", 409);
    }
    const findings = lintTemplate(draft.subject, draft.body);
    if (findings.length) {
      throw new TemplateVersionError("The draft still contains wording that cannot be sent. Fix these before publishing.", 422, findings);
    }
    await ensureBaseline(tx, t);
    const next = t.contentVersion + 1;
    const now = new Date();
    await tx.update(messageTemplateVersions).set({
      state: "published", version: next, publishedBy: actorId, publishedAt: now, updatedAt: now,
    }).where(eq(messageTemplateVersions.id, draft.id));
    const [updated] = await tx.update(messageTemplates).set({
      subject: draft.subject, body: draft.body, contentVersion: next, updatedAt: now,
    }).where(eq(messageTemplates.id, templateId)).returning();
    await auditChange({
      userId: actorType === "user" ? actorId : null, actorType, actorId, action: "message_template_content_published",
      entityType: "message_template", entityId: templateId,
      before: { version: t.contentVersion, subject: t.subject, body: t.body },
      after: { version: next, subject: draft.subject, body: draft.body },
      details: { isActiveUnchanged: updated.isActive },
    }, tx);
    return updated;
  });
}

/**
 * System convergence of reviewed wording as ONE atomic step under the template lock: the live version must still be the
 * one the change was computed from, no operator draft may exist, and the new wording is published as the next immutable
 * version without ever creating a draft row. A draft an operator saves at any moment is therefore either already
 * visible here (conflict, left intact) or saved afterwards against the new version; it can never be overwritten,
 * consumed or published by the system.
 */
export async function publishSystemWording(
  templateId: number,
  input: { expectedVersion: number; subject: string | null; body: string },
  actorId: string,
) {
  return db.transaction(async (tx) => {
    const t = await lockTemplate(tx, templateId);
    if (input.expectedVersion !== t.contentVersion) {
      throw new TemplateVersionError("The published wording changed since the change was computed.", 409);
    }
    const [draft] = await tx.select({ id: messageTemplateVersions.id }).from(messageTemplateVersions)
      .where(and(eq(messageTemplateVersions.templateId, templateId), eq(messageTemplateVersions.state, "draft"))).for("update");
    if (draft) throw new TemplateVersionError("An administrator draft exists; not overwritten.", 409);
    const findings = lintTemplate(input.subject, input.body);
    if (findings.length) throw new TemplateVersionError("The reviewed wording still contains text that cannot be sent.", 422, findings);
    await ensureBaseline(tx, t);
    const next = t.contentVersion + 1;
    const now = new Date();
    await tx.insert(messageTemplateVersions).values({
      templateId, version: next, baseVersion: t.contentVersion, state: "published", subject: input.subject, body: input.body,
      authorId: null, publishedBy: actorId, publishedAt: now, updatedAt: now,
    });
    const [updated] = await tx.update(messageTemplates).set({
      subject: input.subject, body: input.body, contentVersion: next, updatedAt: now,
    }).where(eq(messageTemplates.id, templateId)).returning();
    await auditChange({
      userId: null, actorType: "system", actorId, action: "message_template_content_published",
      entityType: "message_template", entityId: templateId,
      before: { version: t.contentVersion, subject: t.subject, body: t.body },
      after: { version: next, subject: input.subject, body: input.body },
      details: { isActiveUnchanged: updated.isActive, via: "system_convergence" },
    }, tx);
    return updated;
  });
}

/** Campaign/operator use of a template. Deactivation is always allowed; activation needs clean live wording. */
export async function setTemplateActive(templateId: number, active: boolean, actorId: string) {
  return db.transaction(async (tx) => {
    const t = await lockTemplate(tx, templateId);
    if (active) {
      const findings = lintTemplate(t.subject, t.body);
      if (findings.length) {
        throw new TemplateVersionError("The published wording still contains text that cannot be sent. Publish corrected wording first.", 422, findings);
      }
    }
    if ((t.isActive ?? false) === active) return t;
    const [updated] = await tx.update(messageTemplates).set({ isActive: active, updatedAt: new Date() })
      .where(eq(messageTemplates.id, templateId)).returning();
    await auditChange({
      userId: actorId, action: active ? "message_template_activated" : "message_template_deactivated",
      entityType: "message_template", entityId: templateId, details: { contentVersion: t.contentVersion },
    }, tx);
    return updated;
  });
}
