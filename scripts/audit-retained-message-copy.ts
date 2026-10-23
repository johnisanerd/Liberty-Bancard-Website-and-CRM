/**
 * Read-only audit of stored message copy (enabled workflow actions and message templates).
 * Flags unresolved placeholders, attachment-by-email asks, unsupported claims and dead links.
 * It never writes. Reviewed replacements live in docs/public-journeys/copy-reconciliation.md;
 * applying them is done by server/services/reviewed-copy-replacements.ts, never by this script.
 *
 *   npx tsx scripts/audit-retained-message-copy.ts            # uses DATABASE_URL (dev unless pointed elsewhere)
 *   npx tsx scripts/audit-retained-message-copy.ts --json
 */
import pg from "pg";

import { lintCopy } from "../server/services/message-copy-lint";

function scan(label: string, text: string, out: Array<Record<string, string>>) {
  for (const f of lintCopy(text)) out.push({ where: label, rule: f.rule, match: f.match, why: f.why });
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
