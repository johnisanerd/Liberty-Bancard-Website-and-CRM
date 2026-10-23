/**
 * Read-only audit of stored message copy (enabled workflow actions and message templates).
 * Flags unresolved placeholders, attachment-by-email asks, unsupported claims and dead links.
 * It never writes. Proposed replacements live in docs/public-journeys/copy-reconciliation.md for owner review;
 * applying them to production workflows is an owner-approved content publication, not part of this script.
 *
 *   npx tsx scripts/audit-retained-message-copy.ts            # uses DATABASE_URL (dev unless pointed elsewhere)
 *   npx tsx scripts/audit-retained-message-copy.ts --json
 */
import pg from "pg";

const SUPPORTED_MERGE = new Set([
  "firstName", "lastName", "fullName", "email", "phone", "companyName", "businessName", "agentName", "agentEmail",
  "agentPhone", "calendarLink", "dealName", "referenceId",
]);

const RULES: Array<{ id: string; test: RegExp; why: string }> = [
  { id: "bracket_placeholder", test: /\[[A-Z][A-Z0-9_]{3,}\]/g, why: "Unresolved bracket placeholder would be sent literally" },
  { id: "dead_link", test: /href=["']#["']/gi, why: "Link has no destination" },
  { id: "attachment_ask", test: /(reply|respond)[^.]{0,60}attach|attach[^.]{0,60}(voided check|driver'?s? licen[sc]e|photo id|identification)|email[^.]{0,40}(voided check|photo id|driver'?s? licen[sc]e)/gi, why: "Asks the recipient to email sensitive documents; use the secure upload journey" },
  { id: "unsupported_timing", test: /within\s+(1|one)\s+business\s+day|in\s+(just\s+)?5\s+minutes|same[- ]day|guaranteed/gi, why: "Timing or guarantee not backed by a recorded policy" },
  { id: "unsupported_proof", test: /\b(thousands of merchants|trusted by \d|saved (our|my) clients|average (savings|saving) of)\b/gi, why: "Social-proof or savings claim without a stored source" },
  { id: "exists_claim", test: /(your analysis (is|has been) saved|your application (is|has been) approved|agreement (is|was) sent)/gi, why: "States a record exists without a recorded event" },
];

function mergeVars(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((m) => m[1]);
}

function scan(label: string, text: string, out: Array<Record<string, string>>) {
  for (const rule of RULES) {
    const hits = [...text.matchAll(rule.test)].map((m) => m[0].slice(0, 80));
    for (const hit of new Set(hits)) out.push({ where: label, rule: rule.id, match: hit, why: rule.why });
  }
  for (const v of new Set(mergeVars(text))) {
    if (!SUPPORTED_MERGE.has(v) && !/^(contact|deal|company|agent)\.[A-Za-z0-9_]+$/.test(v)) out.push({ where: label, rule: "unknown_merge_variable", match: `{{${v}}}`, why: "Variable is not in the supported merge list" });
  }
}

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query("SET default_transaction_read_only = on");
const findings: Array<Record<string, string>> = [];
const wf = await client.query(`SELECT id, name, enabled, actions FROM workflows WHERE retired_at IS NULL ORDER BY id`);
for (const row of wf.rows) scan(`workflow #${row.id} ${row.name}${row.enabled ? " (enabled)" : ""}`, JSON.stringify(row.actions ?? []), findings);
const tpl = await client.query(`SELECT id, name, subject, body FROM message_templates ORDER BY id`);
for (const row of tpl.rows) scan(`template #${row.id} ${row.name}`, `${row.subject ?? ""}\n${row.body ?? ""}`, findings);
await client.end();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ workflows: wf.rowCount, templates: tpl.rowCount, findings }, null, 2));
} else {
  console.log(`Scanned ${wf.rowCount} non-retired workflows and ${tpl.rowCount} templates (read-only).`);
  for (const f of findings) console.log(`- ${f.where}: [${f.rule}] ${f.match} — ${f.why}`);
  console.log(findings.length === 0 ? "No findings." : `${findings.length} finding(s). No data was changed.`);
}
process.exit(0);
