/**
 * Read-only audit of stored message copy across every retained collection:
 *   - non-retired workflow email/SMS steps and message templates (token support + real-renderer checks + wording rules)
 *   - sequence steps (including variant B) and campaign steps (wording rules only; they use their own renderers)
 * Flags unresolved placeholders, attachment-by-email asks, unsupported claims and dead links.
 * It never writes. Reviewed replacements live in docs/public-journeys/copy-reconciliation.md;
 * applying them is done by server/services/reviewed-copy-replacements.ts, never by this script.
 *
 *   npx tsx scripts/audit-retained-message-copy.ts            # uses DATABASE_URL (dev unless pointed elsewhere)
 *   npx tsx scripts/audit-retained-message-copy.ts --json
 */
import pg from "pg";

import { lintCopy, lintRules } from "../server/services/message-copy-lint";

type Finding = Record<string, string>;
const collections: Record<string, number> = {};

function scan(label: string, text: string | null | undefined, out: Finding[], purpose?: "workflow" | "template") {
  if (!text) return;
  for (const f of purpose ? lintCopy(text, purpose) : lintRules(text)) out.push({ where: label, rule: f.rule, match: f.match, why: f.why });
}

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("SET default_transaction_read_only = on");
const findings: Finding[] = [];

const wf = await client.query(`SELECT id, name, enabled, actions FROM workflows WHERE retired_at IS NULL ORDER BY id`);
collections.workflows = wf.rowCount ?? 0;
for (const row of wf.rows) {
  const label = `workflow #${row.id} ${row.name}${row.enabled ? " (enabled)" : ""}`;
  (Array.isArray(row.actions) ? row.actions : []).forEach((a: any, i: number) => {
    if (a?.type === "send_ghl_email") scan(`${label} step ${i + 1}`, `${a.subject ?? ""}\n${a.body ?? ""}`, findings, "workflow");
    else if (a?.type === "send_ghl_sms") scan(`${label} step ${i + 1}`, a.body, findings, "workflow");
    else scan(`${label} step ${i + 1}`, JSON.stringify(a), findings);
  });
}
const tpl = await client.query(`SELECT id, name, subject, body FROM message_templates ORDER BY id`);
collections.templates = tpl.rowCount ?? 0;
for (const row of tpl.rows) scan(`template #${row.id} ${row.name}`, `${row.subject ?? ""}\n${row.body ?? ""}`, findings, "template");

const seq = await client.query(`SELECT id, sequence_id, step_order, action_type, subject, body, variant_b_subject, variant_b_body FROM sequence_steps ORDER BY id`);
collections.sequenceSteps = seq.rowCount ?? 0;
for (const row of seq.rows) {
  const label = `sequence ${row.sequence_id} step ${row.step_order} (${row.action_type})`;
  scan(label, `${row.subject ?? ""}\n${row.body ?? ""}`, findings);
  scan(`${label} variant B`, `${row.variant_b_subject ?? ""}\n${row.variant_b_body ?? ""}`, findings);
}
const camp = await client.query(`SELECT id, campaign_id, step_order, channel, subject, body_template FROM campaign_steps ORDER BY id`);
collections.campaignSteps = camp.rowCount ?? 0;
for (const row of camp.rows) scan(`campaign ${row.campaign_id} step ${row.step_order} (${row.channel})`, `${row.subject ?? ""}\n${row.body_template ?? ""}`, findings);
await client.end();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ scanned: collections, findings }, null, 2));
} else {
  console.log(`Scanned (read-only): ${Object.entries(collections).map(([k, v]) => `${v} ${k}`).join(", ")}.`);
  for (const f of findings) console.log(`- ${f.where}: [${f.rule}] ${f.match} — ${f.why}`);
  console.log(findings.length === 0 ? "No findings." : `${findings.length} finding(s). No data was changed.`);
}
process.exit(0);
