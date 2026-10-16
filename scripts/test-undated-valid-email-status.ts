/**
 * Legacy email_status cleanup: 'valid' without a validation date counts as
 * unvalidated, and currentValidEmailPredicate only accepts dated, fresh 'valid'.
 * Uses uniquely tagged fixtures and removes them afterwards. No provider calls.
 */
import { pool } from "../server/db";
import { UNVALIDATED_EMAIL_PREDICATE, currentValidEmailPredicate } from "../server/services/zerobounce-eligibility";

let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✅ ${name}`); else { fail++; console.error(`  ❌ ${name}`); }
}
const TAG = `undated-valid-${Date.now()}`;

async function insert(slug: string, status: string, validatedAt: Date | null): Promise<number> {
  const r = await pool.query(
    `INSERT INTO contacts (first_name, last_name, email, phone, email_status, lead_score, email_validation_updated_at)
     VALUES ('UV', 'Test', $1, $2, $3, 50, $4) RETURNING id`,
    [`${TAG}-${slug}@example-test.com`, `+1555${String(Date.now() + Math.floor(Math.random() * 1e6)).slice(-7)}`, status, validatedAt],
  );
  return r.rows[0].id;
}

async function main() {
  const ids: number[] = [];
  try {
    const fresh = await insert("fresh", "valid", new Date());
    const stale = await insert("stale", "valid", new Date(Date.now() - 200 * 86_400_000));
    const undated = await insert("undated", "valid", null);
    const active = await insert("active", "active", null);
    const unval = await insert("unvalidated", "unvalidated", null);
    const aged60 = await insert("aged60", "valid", new Date(Date.now() - 60 * 86_400_000));
    ids.push(fresh, stale, undated, active, unval, aged60);
    const ask = async (pred: string) => new Set((await pool.query(
      `SELECT c.id FROM contacts c WHERE ${pred} AND c.id = ANY($1::int[])`, [ids])).rows.map((r: any) => r.id));

    const needsValidation = await ask(UNVALIDATED_EMAIL_PREDICATE);
    check("undated 'valid' needs validation", needsValidation.has(undated));
    check("'active' still needs validation", needsValidation.has(active));
    check("'unvalidated' still needs validation", needsValidation.has(unval));
    check("fresh dated 'valid' does not need validation", !needsValidation.has(fresh));
    check("stale dated 'valid' is not treated as unvalidated", !needsValidation.has(stale));

    const current = await ask(currentValidEmailPredicate("c"));
    check("fresh dated 'valid' is currently validated", current.has(fresh));
    check("'valid' older than 180 days is not current", !current.has(stale));
    check("'valid' aged 60 days is still current (180-day window)", current.has(aged60));
    check("undated 'valid' is not current", !current.has(undated));
    check("'active' is not current", !current.has(active) && !current.has(unval));

    let rejected = false;
    try { currentValidEmailPredicate("c; DROP TABLE contacts"); } catch { rejected = true; }
    check("alias is validated", rejected);
  } finally {
    if (ids.length) await pool.query(`DELETE FROM contacts WHERE id = ANY($1::int[])`, [ids]);
    await pool.end();
  }
  console.log(fail === 0 ? "PASS" : `FAIL (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
