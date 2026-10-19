/**
 * Launch content for the five current South Florida (v2) SFP packages.
 *
 * Three email touches per vertical (relative delays 0, 3, 5 days = day 0/3/8),
 * adapted from existing library content and recorded step-by-step in a
 * source-to-launch map. Source rows are never edited: adapted text is written
 * only into the package's own campaign/sequence steps, and a NEW immutable
 * package version (new content hash) supersedes the previous current one.
 *
 * Token vocabulary is limited to {{companyName}}, {{firstName}} (greeting
 * only), {{agentName}} and {{agentPhone}}; the shared renderer rejects anything
 * else. There is no SMS, call or voicemail step, no savings figure and no
 * statistic. The only CTA is the secure upload page.
 */
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../../db";
import { renderTemplate, plainHtmlToEmailHtml, RenderError } from "../message-render";
import {
  SFP_PACKAGE_KEYS_V2,
  type SfpPackageKeyV2,
  computeLivePackageContentHash,
  lockLivePackageContentRows,
} from "./sfp-campaign-packages";

const rows = (r: any): any[] => r?.rows ?? r ?? [];

export const SFP_SECURE_UPLOAD_URL = "https://libertybancard.com/upload-statement";
export const SFP_LAUNCH_ALLOWED_HOSTS = ["libertybancard.com"];
export const SFP_LAUNCH_CONTENT_VERSION = "sfp-launch-content-2026-10-19.1";
export const SFP_LAUNCH_SEQUENCE_FAMILY_PREFIX = "sfp-v2-cold-";
export const SFP_LAUNCH_STEP_DELAYS_DAYS = [0, 3, 5] as const;

const SIGNOFF = "{{agentName}}\nLiberty Bancard\n{{agentPhone}}";

interface VerticalSource {
  campaignName: string;
  stepOrders: number[];
  /** Optional vocabulary-only source; absence does not block the package. */
  optionalSequenceName?: string;
}

interface VerticalContent {
  subject: string;
  opener: string;
  verticalSource: VerticalSource;
  reasonOpener: string;
}

const CORE_SOURCE = "SDR-01: Statement Review Cold Outreach";

const VERTICALS: Record<SfpPackageKeyV2, VerticalContent> = {
  "sfp.automotive.v2": {
    subject: "Payment processing at {{companyName}}",
    opener: "I’m reaching out from Liberty Bancard about payment processing at {{companyName}}. We can review how your repair invoices and day-to-day card payments are priced.",
    verticalSource: { campaignName: "SDR-07: Auto / Service / Trades", stepOrders: [1] },
    reasonOpener: "Kept the repair-invoice framing from SDR-07 step 1; dropped the volume example, the $1,600/month arithmetic and the cash-discount claim.",
  },
  "sfp.healthcare.v2": {
    subject: "A processing review for {{companyName}}",
    opener: "I’m reaching out from Liberty Bancard about payment processing at {{companyName}}. We can review your patient-payment processing statement and explain its fees.",
    verticalSource: { campaignName: "SDR-05: Medical / Dental / Medspa", stepOrders: [1] },
    reasonOpener: "Kept the patient-payment framing from SDR-05 step 1; removed the unsupported EHR-integration, PCI and funding-speed assurances and the practice-volume example.",
  },
  "sfp.beauty_spa.v2": {
    subject: "Payment processing at {{companyName}}",
    opener: "I’m reaching out from Liberty Bancard about payment processing at {{companyName}}. We can review how your card payments, tips and any recurring charges are priced.",
    verticalSource: { campaignName: "SDR-10: Salon / Spa / Beauty", stepOrders: [1] },
    reasonOpener: "Kept the tips/recurring-charge framing from SDR-10 step 1; removed the $1.87 fee example, named booking-platform claims, equipment promises and generic savings.",
  },
  "sfp.construction_trades_home_services.v2": {
    subject: "Card payments at {{companyName}}",
    opener: "I’m reaching out from Liberty Bancard about payment processing at {{companyName}}. We can review the fees on your card-paid invoices and deposits.",
    verticalSource: { campaignName: "SDR-07: Auto / Service / Trades", stepOrders: [1] },
    reasonOpener: "Reworded SDR-07 step 1 for invoice/deposit payments so contractors are not treated as auto shops; removed the volume example and cash-discount claim.",
  },
  "sfp.fitness_recreation.v2": {
    subject: "A processing review for {{companyName}}",
    opener: "I’m reaching out from Liberty Bancard about payment processing at {{companyName}}. We can review the fees on your card payments and any membership billing.",
    verticalSource: { campaignName: "SDR-01: Statement Review Cold Outreach", stepOrders: [1], optionalSequenceName: "V-Gym: SDR Outbound Prospecting" },
    reasonOpener: "Used V-Gym email 1 vocabulary (membership billing) only as a qualified phrase; removed its decline-rate claims, recurring-interchange claims and the SMS steps.",
  },
};

export interface LaunchStepDraft {
  stepOrder: number;
  touch: "intro" | "follow_up" | "close_loop";
  subject: string;
  body: string;
  delayDays: number;
  cta: string;
  sourceCampaignName: string;
  sourceCampaignStepOrders: number[];
  reason: string;
}

export function buildLaunchStepDrafts(packageKey: SfpPackageKeyV2): LaunchStepDraft[] {
  const v = VERTICALS[packageKey];
  if (!v) throw new Error(`SFP_LAUNCH_CONTENT_UNKNOWN_PACKAGE:${packageKey}`);
  const core = (extra: number[]) => ({ sourceCampaignName: CORE_SOURCE, sourceCampaignStepOrders: extra });
  return [
    {
      stepOrder: 1, touch: "intro", subject: v.subject, delayDays: SFP_LAUNCH_STEP_DELAYS_DAYS[0], cta: SFP_SECURE_UPLOAD_URL,
      body: `Hi {{firstName}},\n\n${v.opener}\n\nThe review separates network costs, processor markup and fixed fees. There’s no obligation to switch, and we’ll tell you if your current pricing is already competitive.\n\nWould a free statement review be useful? You can use our secure upload page: ${SFP_SECURE_UPLOAD_URL}\n\n${SIGNOFF}`,
      sourceCampaignName: v.verticalSource.campaignName,
      sourceCampaignStepOrders: v.verticalSource.stepOrders,
      reason: `${v.reasonOpener} Statement-review core from SDR-01 step 1; replaced “forward your statement to {{agentEmail}}” with the secure upload page; removed “10 minutes”/“true effective rate” promises.`,
    },
    {
      stepOrder: 2, touch: "follow_up", subject: "A clearer breakdown of your processing fees", delayDays: SFP_LAUNCH_STEP_DELAYS_DAYS[1], cta: SFP_SECURE_UPLOAD_URL,
      body: `Hello,\n\nFollowing up on my note about {{companyName}}. A statement review shows your total effective rate as well as the individual fees behind it, so you can compare options using the same transaction volume.\n\nIf you’d like that breakdown, our secure upload page is ${SFP_SECURE_UPLOAD_URL}. Please use the form rather than emailing financial documents.\n\n${SIGNOFF}`,
      ...core([2]),
      reason: "SDR-01 step 2 follow-up: removed fake “Re:” subject prefix, the $50K/month illustration and the instruction to email a statement; one secure-upload CTA; fixed generic greeting.",
    },
    {
      stepOrder: 3, touch: "close_loop", subject: "Should I close the loop?", delayDays: SFP_LAUNCH_STEP_DELAYS_DAYS[2], cta: SFP_SECURE_UPLOAD_URL,
      body: `Hello,\n\nI’ll close the loop on my processing-review offer for {{companyName}}. If it would be useful later, you can request a review at ${SFP_SECURE_UPLOAD_URL}.\n\nNo need to reply if the timing isn’t right. This is my final follow-up on this offer.\n\n${SIGNOFF}`,
      ...core([5]),
      reason: "SDR-01 step 5 breakup: removed the “24 hours” turnaround and “Florida and the Southeast” claims and the email-a-statement CTA; skipped SDR-01 steps 3-4 (unsupported “2.6% quoted vs 3.4% actual” and “hundreds/70-30” claims).",
    },
  ];
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface RenderedPreview {
  stepOrder: number;
  subject: string;
  html: string;
  text: string;
  greeting: string;
}

export type PreviewAudience = "named_contact" | "role_mailbox" | "missing_name";
const PREVIEW_CONTACTS: Record<PreviewAudience, { firstName: string | null; email: string }> = {
  named_contact: { firstName: "Maria", email: "maria@example-business.test" },
  role_mailbox: { firstName: "Precision Auto Glass Contact", email: "info@example-business.test" },
  missing_name: { firstName: null, email: "owner-office@example-business.test" },
};

export function renderLaunchPreview(
  packageKey: SfpPackageKeyV2,
  audience: PreviewAudience,
  companyName = "Example Business",
  sender = { agentName: "Scott Stevenson", agentPhone: "954-266-8214" },
): RenderedPreview[] {
  const c = PREVIEW_CONTACTS[audience];
  return buildLaunchStepDrafts(packageKey).map((s) => {
    const ctx = { firstName: c.firstName, email: c.email, companyName, ...sender, agentEmail: "Scott@mail.libertybancard.com" };
    const html = renderTemplate(s.body, ctx, { format: "html", required: ["companyName", "agentName", "agentPhone"] });
    const text = renderTemplate(s.body, ctx, { format: "text", required: ["companyName", "agentName", "agentPhone"] });
    return {
      stepOrder: s.stepOrder,
      subject: renderTemplate(s.subject, ctx, { format: "subject", required: ["companyName"] }).output,
      html: plainHtmlToEmailHtml(html.output, SFP_LAUNCH_ALLOWED_HOSTS),
      text: text.output,
      greeting: html.greeting,
    };
  });
}

export interface ContentReadiness { ok: boolean; issues: string[]; stepCount: number }

/**
 * Launch-readiness guard for a package: real, renderable email steps in both
 * the campaign and the sequence, matching counts, relative delays, and no
 * automated call/SMS/voicemail. An empty package is never ready.
 */
export async function checkPackageContentReadiness(
  exec: { execute: (q: any) => Promise<any> },
  campaignId: number,
  sequenceId: number,
): Promise<ContentReadiness> {
  const issues: string[] = [];
  const cs = rows(await exec.execute(sql`SELECT step_order,step_type,subject,body_template,delay_days,channel FROM campaign_steps WHERE campaign_id=${campaignId} ORDER BY step_order`));
  const ss = rows(await exec.execute(sql`SELECT step_order,action_type,subject,body,delay_days,delay_hours,config FROM sequence_steps WHERE sequence_id=${sequenceId} ORDER BY step_order`));
  if (ss.length === 0) issues.push("SEQUENCE_HAS_NO_STEPS");
  if (cs.length === 0) issues.push("CAMPAIGN_HAS_NO_STEPS");
  if (ss.length !== cs.length) issues.push(`STEP_COUNT_MISMATCH:campaign=${cs.length},sequence=${ss.length}`);
  const seq = rows(await exec.execute(sql`SELECT total_steps FROM follow_up_sequences WHERE id=${sequenceId}`))[0];
  const camp = rows(await exec.execute(sql`SELECT total_steps FROM campaigns WHERE id=${campaignId}`))[0];
  if (Number(seq?.total_steps ?? -1) !== ss.length) issues.push("SEQUENCE_TOTAL_STEPS_STALE");
  if (Number(camp?.total_steps ?? -1) !== cs.length) issues.push("CAMPAIGN_TOTAL_STEPS_STALE");
  ss.forEach((s, i) => {
    if (Number(s.step_order) !== i + 1) issues.push(`STEP_ORDER_GAP:${s.step_order}`);
    if (s.action_type !== "email") issues.push(`NON_EMAIL_STEP:${s.step_order}:${s.action_type}`);
    if (!String(s.subject ?? "").trim() || !String(s.body ?? "").trim()) issues.push(`EMPTY_STEP_CONTENT:${s.step_order}`);
    if (Number(s.delay_hours ?? 0) !== 0 || Number(s.delay_days ?? 0) < 0) issues.push(`BAD_DELAY:${s.step_order}`);
    if (i === 0 && Number(s.delay_days ?? 0) !== 0) issues.push("FIRST_STEP_DELAYED");
    if (i > 0 && Number(s.delay_days ?? 0) < 1) issues.push(`FOLLOW_UP_NOT_RELATIVELY_DELAYED:${s.step_order}`);
    const ctxProbe = { firstName: "Maria", email: "maria@example-business.test", companyName: "Probe Co", agentName: "Probe", agentPhone: "000", agentEmail: "p@x.test" };
    try {
      renderTemplate(String(s.body ?? ""), ctxProbe, { format: "html" });
      renderTemplate(String(s.subject ?? ""), ctxProbe, { format: "subject" });
      const urls = String(s.body ?? "").match(/https?:\/\/[^\s<]+/g) ?? [];
      for (const u of urls) {
        const clean = u.replace(/[.,;)]+$/, "");
        if (clean !== SFP_SECURE_UPLOAD_URL) issues.push(`UNAPPROVED_URL:${s.step_order}:${clean}`);
      }
    } catch (e) {
      issues.push(`UNRENDERABLE_STEP:${s.step_order}:${e instanceof RenderError ? e.code : "ERROR"}`);
    }
  });
  cs.forEach((c) => { if (c.channel !== "email") issues.push(`NON_EMAIL_CAMPAIGN_STEP:${c.step_order}`); });
  return { ok: issues.length === 0, issues, stepCount: ss.length };
}

export interface PopulateResultRow {
  packageKey: SfpPackageKeyV2;
  status: "populated" | "already_current" | "skipped_needs_review" | "would_populate";
  reason?: string;
  packageVersionId?: string;
  contentHash?: string;
  supersededVersionId?: string | null;
  map?: unknown;
}

/**
 * Populate (or verify) launch content for every current v2 package. Resolves
 * packages by logical key and sources by logical name; never hardcodes IDs.
 */
export async function populateSfpLaunchContentV2(opts: { actorId: string; dryRun?: boolean }): Promise<PopulateResultRow[]> {
  const out: PopulateResultRow[] = [];
  for (const packageKey of SFP_PACKAGE_KEYS_V2) {
    try {
      out.push(await populateOne(packageKey, opts));
    } catch (err: any) {
      out.push({ packageKey, status: "skipped_needs_review", reason: err?.cause?.message ?? err?.message ?? String(err) });
    }
  }
  return out;
}

async function sourceIdentity(exec: { execute: (q: any) => Promise<any> }, campaignName: string, stepOrders: number[]) {
  const campaign = rows(await exec.execute(sql`SELECT id,name,content_revision FROM campaigns WHERE name=${campaignName} ORDER BY id LIMIT 1`))[0];
  if (!campaign) return null;
  const steps = rows(await exec.execute(sql`
    SELECT id,step_order,subject,body_template FROM campaign_steps
     WHERE campaign_id=${Number(campaign.id)} AND step_order=ANY(${`{${stepOrders.join(",")}}`}::int[]) ORDER BY step_order`));
  return {
    campaignName, campaignId: Number(campaign.id), contentRevision: Number(campaign.content_revision ?? 1),
    steps: steps.map((s) => ({ stepId: Number(s.id), stepOrder: Number(s.step_order), originalHash: sha256(`${s.subject ?? ""}\n${s.body_template ?? ""}`) })),
  };
}

async function populateOne(packageKey: SfpPackageKeyV2, opts: { actorId: string; dryRun?: boolean }): Promise<PopulateResultRow> {
  const drafts = buildLaunchStepDrafts(packageKey);
  return db.transaction(async (tx) => {
    const pkg = rows(await tx.execute(sql`
      SELECT id,vertical,campaign_id,campaign_name,sequence_id,sequence_name,sequence_family
        FROM sfp_campaign_package_versions WHERE package_key=${packageKey} AND lifecycle_state='current' FOR UPDATE`))[0];
    if (!pkg) return { packageKey, status: "skipped_needs_review" as const, reason: "NO_CURRENT_PACKAGE_VERSION: run package convergence first" };
    if (!String(pkg.sequence_family).startsWith(SFP_LAUNCH_SEQUENCE_FAMILY_PREFIX)) {
      return { packageKey, status: "skipped_needs_review" as const, reason: `UNEXPECTED_SEQUENCE_FAMILY:${pkg.sequence_family}` };
    }
    const campaignId = Number(pkg.campaign_id), sequenceId = Number(pkg.sequence_id);
    const { campaign, sequence } = await lockLivePackageContentRows(tx, campaignId, sequenceId);
    if (campaign.status !== "draft") return { packageKey, status: "skipped_needs_review" as const, reason: `CAMPAIGN_NOT_DRAFT:${campaign.status}` };
    if (sequence.status !== "paused") return { packageKey, status: "skipped_needs_review" as const, reason: `SEQUENCE_NOT_PAUSED:${sequence.status}` };

    const core = await sourceIdentity(tx, CORE_SOURCE, [1, 2, 5]);
    if (!core) return { packageKey, status: "skipped_needs_review" as const, reason: `SOURCE_NOT_FOUND:${CORE_SOURCE}` };
    const vSource = VERTICALS[packageKey].verticalSource;
    const vertical = vSource.campaignName === CORE_SOURCE ? core : await sourceIdentity(tx, vSource.campaignName, vSource.stepOrders);
    if (!vertical) return { packageKey, status: "skipped_needs_review" as const, reason: `SOURCE_NOT_FOUND:${vSource.campaignName}` };
    let optional: unknown = null;
    if (vSource.optionalSequenceName) {
      const seqSrc = rows(await tx.execute(sql`SELECT id,name FROM follow_up_sequences WHERE name=${vSource.optionalSequenceName} ORDER BY id LIMIT 1`))[0];
      optional = seqSrc ? { sequenceName: seqSrc.name, found: true } : { sequenceName: vSource.optionalSequenceName, found: false };
    }

    const existing = rows(await tx.execute(sql`SELECT step_order,action_type,subject,body,delay_days,delay_hours,config FROM sequence_steps WHERE sequence_id=${sequenceId} ORDER BY step_order`));
    const sameAsDrafts = existing.length === drafts.length && drafts.every((d, i) =>
      existing[i].subject === d.subject && existing[i].body === d.body && Number(existing[i].delay_days) === d.delayDays && existing[i].action_type === "email");
    const readiness = await checkPackageContentReadiness(tx, campaignId, sequenceId);
    if (sameAsDrafts && readiness.ok) {
      return { packageKey, status: "already_current" as const, packageVersionId: String(pkg.id) };
    }
    if (existing.length > 0) {
      return { packageKey, status: "skipped_needs_review" as const, reason: `PINNED_SEQUENCE_ALREADY_HAS_DIFFERENT_STEPS(${existing.length}): publish a new package sequence instead of mutating content in place` };
    }

    const map = drafts.map((d) => ({
      stepOrder: d.stepOrder, touch: d.touch, delayDays: d.delayDays, cta: d.cta, reason: d.reason,
      source: d.stepOrder === 1 ? { primary: vertical, statementReviewCore: core, optional } : { primary: core },
      revisedSubject: d.subject, revisedBodyHash: sha256(`${d.subject}\n${d.body}`),
    }));
    if (opts.dryRun) return { packageKey, status: "would_populate" as const, map };

    for (const d of drafts) {
      await tx.execute(sql`INSERT INTO campaign_steps (campaign_id,step_order,step_type,delay_days,subject,body_template,use_ai_personalization,channel)
        VALUES (${campaignId},${d.stepOrder},${d.touch === "intro" ? "initial_outreach" : d.touch === "follow_up" ? "follow_up" : "breakup"},${d.delayDays},${d.subject},${d.body},FALSE,'email')`);
      await tx.execute(sql`INSERT INTO sequence_steps (sequence_id,step_order,action_type,delay_days,delay_hours,subject,body,config)
        VALUES (${sequenceId},${d.stepOrder},'email',${d.delayDays},0,${d.subject},${d.body},
          ${JSON.stringify({ format: "plain_text", contentVersion: SFP_LAUNCH_CONTENT_VERSION, touch: d.touch, source: { campaign: d.sourceCampaignName, stepOrders: d.sourceCampaignStepOrders } })}::jsonb)`);
    }
    await tx.execute(sql`UPDATE campaigns SET total_steps=${drafts.length}, content_revision=content_revision+1,
      description=${`South Florida v2 ${pkg.vertical} launch content (${SFP_LAUNCH_CONTENT_VERSION}); draft until separately approved. Content sources: ${CORE_SOURCE}, ${vSource.campaignName}.`},
      updated_at=NOW() WHERE id=${campaignId}`);
    await tx.execute(sql`UPDATE follow_up_sequences SET total_steps=${drafts.length} WHERE id=${sequenceId}`);

    const after = await checkPackageContentReadiness(tx, campaignId, sequenceId);
    if (!after.ok) throw new Error(`SFP_LAUNCH_CONTENT_NOT_READY:${after.issues.join("|")}`);

    const contentHash = await computeLivePackageContentHash(tx, campaignId, sequenceId);
    await tx.execute(sql`UPDATE sfp_campaign_package_versions SET lifecycle_state='superseded',superseded_at=NOW(),updated_at=NOW() WHERE id=${String(pkg.id)}::uuid`);
    const inserted = rows(await tx.execute(sql`
      INSERT INTO sfp_campaign_package_versions
        (package_key,vertical,campaign_id,campaign_name,sequence_id,sequence_name,sequence_family,content_hash,lifecycle_state,effective_at,actor_id,notes)
      VALUES (${packageKey},${pkg.vertical},${campaignId},${pkg.campaign_name},${sequenceId},${pkg.sequence_name},${pkg.sequence_family},${contentHash},
              'current',NOW(),${opts.actorId},${JSON.stringify({ contentVersion: SFP_LAUNCH_CONTENT_VERSION, map })})
      RETURNING id`))[0];
    return { packageKey, status: "populated" as const, packageVersionId: String(inserted.id), contentHash, supersededVersionId: String(pkg.id), map };
  });
}

/** Verify the five current packages are launch-ready; used by readiness reporting. */
export async function verifySfpLaunchContentV2(): Promise<{ ok: boolean; packages: Array<{ packageKey: string; ok: boolean; issues: string[]; stepCount: number }> }> {
  const packages: Array<{ packageKey: string; ok: boolean; issues: string[]; stepCount: number }> = [];
  for (const packageKey of SFP_PACKAGE_KEYS_V2) {
    const pkg = rows(await db.execute(sql`SELECT campaign_id,sequence_id,content_hash FROM sfp_campaign_package_versions WHERE package_key=${packageKey} AND lifecycle_state='current'`))[0];
    if (!pkg) { packages.push({ packageKey, ok: false, issues: ["NO_CURRENT_PACKAGE_VERSION"], stepCount: 0 }); continue; }
    const r = await checkPackageContentReadiness(db, Number(pkg.campaign_id), Number(pkg.sequence_id));
    const live = await computeLivePackageContentHash(db, Number(pkg.campaign_id), Number(pkg.sequence_id));
    const issues = live === pkg.content_hash ? r.issues : [...r.issues, "PINNED_HASH_DIFFERS_FROM_LIVE_CONTENT"];
    packages.push({ packageKey, ok: issues.length === 0, issues, stepCount: r.stepCount });
  }
  return { ok: packages.every((p) => p.ok), packages };
}
