/**
 * Read-only seed-test rendering. Shows exactly what each current launch package would put in a recipient's inbox
 * (subject and body from the same renderer the sequence worker uses) for a clearly fictional recipient.
 *
 * Nothing here writes, sends, reserves capacity or touches a contact. A real send of a seed message is a separate,
 * operator-approved step because the transport's commercial boundary refuses marketing sends to anything but a
 * production recipient with a current business link.
 */
import { pool } from "../db";
import { sfpLaunchRenderContext, renderSfpLaunchSubject, renderSfpLaunchBodyHtml } from "./sfp-launch-render";

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
