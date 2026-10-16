/**
 * Free email prefilter (no provider spend). Decides whether a ZeroBounce credit
 * is worth spending on an address and in what order. It never authorizes a
 * send: only a provider observation does that.
 *
 * Statuses (per domain, copied to each contact):
 *  - ok                MX records exist
 *  - a_only            no MX, but an A/AAAA record (implicit MX; deprioritised)
 *  - dead_domain       no MX and no A/AAAA, or a null MX; never spend
 *  - bad_syntax        malformed address; never spend
 *  - disposable        known throwaway provider; never spend
 *  - dns_indeterminate lookup timed out / SERVFAIL; treated as unknown, still validated
 */
import { Resolver } from "node:dns/promises";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { hashEmailToken } from "./provider-readiness-decision";

const rows = (r: any): any[] => r?.rows ?? r ?? [];

export type EmailPrefilterStatus =
  "ok" | "a_only" | "dead_domain" | "bad_syntax" | "disposable" | "dns_indeterminate";

export const PREFILTER_BLOCKING_STATUSES: readonly EmailPrefilterStatus[] =
  ["dead_domain", "bad_syntax", "disposable"];

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com", "guerrillamail.com", "guerrillamail.net", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "throwawaymail.com", "yopmail.com", "trashmail.com", "sharklasers.com",
  "getnada.com", "maildrop.cc", "dispostable.com", "fakeinbox.com", "mailnesia.com",
  "mintemail.com", "spamgourmet.com", "mohmal.com", "emailondeck.com", "tempinbox.com",
]);
const SYNTAX = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$/;
const DOMAIN_TTL_DAYS = 14;
const DEAD_DOMAIN_RECHECK_DAYS = 3;

export function emailDomainOf(email: string | null | undefined): string | null {
  const match = SYNTAX.exec(String(email ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}

type DnsLike = Pick<Resolver, "resolveMx" | "resolve4" | "resolve6">;
const NOT_THERE = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);
const code = (e: any) => String(e?.code ?? "");

function makeResolver(): DnsLike {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  return resolver;
}

/** Pure-ish DNS classification; resolver injectable for tests. */
export async function classifyDomainDns(
  domain: string, dns: DnsLike = makeResolver(),
): Promise<{ status: EmailPrefilterStatus; mxHosts: number; detail: string | null }> {
  if (DISPOSABLE_DOMAINS.has(domain)) return { status: "disposable", mxHosts: 0, detail: null };
  const attempt = async () => {
    let mx: Array<{ exchange: string }> = [];
    try { mx = await dns.resolveMx(domain); }
    catch (e) {
      if (!NOT_THERE.has(code(e))) return { status: "dns_indeterminate" as const, mxHosts: 0, detail: code(e) || "dns_error" };
    }
    const real = mx.filter((m) => m.exchange && m.exchange !== ".");
    if (real.length > 0) return { status: "ok" as const, mxHosts: real.length, detail: null };
    if (mx.length > 0) return { status: "dead_domain" as const, mxHosts: 0, detail: "null_mx" };
    for (const lookup of [() => dns.resolve4(domain), () => dns.resolve6(domain)]) {
      try {
        const addrs = await lookup();
        if (addrs.length > 0) return { status: "a_only" as const, mxHosts: 0, detail: null };
      } catch (e) {
        if (!NOT_THERE.has(code(e))) return { status: "dns_indeterminate" as const, mxHosts: 0, detail: code(e) || "dns_error" };
      }
    }
    return { status: "dead_domain" as const, mxHosts: 0, detail: "no_mx_no_address" };
  };
  const first = await attempt();
  // A single negative answer can be a transient resolver miss; confirm it.
  if (first.status === "dead_domain" && first.detail !== "null_mx") return attempt();
  return first;
}

async function checkDomains(domains: string[]): Promise<Map<string, EmailPrefilterStatus>> {
  const result = new Map<string, EmailPrefilterStatus>();
  if (domains.length === 0) return result;
  const cached = rows(await db.execute(sql`
    SELECT domain,status FROM email_domain_checks
     WHERE domain = ANY(ARRAY[${sql.join(domains.map((d) => sql`${d}`), sql`,`)}]::text[])
       AND checked_at > NOW() - (CASE WHEN status IN ('dead_domain','dns_indeterminate')
            THEN ${sql.raw(String(DEAD_DOMAIN_RECHECK_DAYS))} ELSE ${sql.raw(String(DOMAIN_TTL_DAYS))} END) * INTERVAL '1 day'
  `));
  for (const row of cached) result.set(String(row.domain), row.status as EmailPrefilterStatus);
  const pending = domains.filter((d) => !result.has(d));
  const dns = makeResolver();
  let index = 0;
  const worker = async () => {
    while (index < pending.length) {
      const domain = pending[index++];
      const checked = await classifyDomainDns(domain, dns);
      await db.execute(sql`
        INSERT INTO email_domain_checks(domain,status,mx_host_count,detail,checked_at)
        VALUES (${domain},${checked.status},${checked.mxHosts},${checked.detail},NOW())
        ON CONFLICT (domain) DO UPDATE SET status=EXCLUDED.status,
          mx_host_count=EXCLUDED.mx_host_count,detail=EXCLUDED.detail,checked_at=NOW()
      `);
      result.set(domain, checked.status);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, pending.length) }, worker));
  return result;
}

async function saveContactResult(contactId: number, tokenHash: string, domain: string | null, status: EmailPrefilterStatus) {
  await db.execute(sql`
    INSERT INTO contact_email_prefilter(contact_id,email_token_hash,domain,status,checked_at)
    VALUES (${contactId},${tokenHash},${domain},${status},NOW())
    ON CONFLICT (contact_id) DO UPDATE SET email_token_hash=EXCLUDED.email_token_hash,
      domain=EXCLUDED.domain,status=EXCLUDED.status,checked_at=NOW()
  `);
}

/**
 * Prefilter up to `limit` contacts that have no current saved result. Contacts
 * with an open validation intent go first, then business-linked unvalidated
 * contacts. Returns counts per status. Spends nothing.
 */
export async function runEmailPrefilterBatch(limit = 500): Promise<Record<string, number>> {
  const bounded = Math.max(1, Math.min(2000, Math.floor(limit)));
  const contacts = rows(await db.execute(sql`
    SELECT c.id,c.email
      FROM contacts c
      LEFT JOIN contact_email_prefilter pf ON pf.contact_id=c.id
     WHERE c.archived_at IS NULL AND NULLIF(btrim(c.email),'') IS NOT NULL
       AND (c.business_id IS NOT NULL OR EXISTS (SELECT 1 FROM validation_intents vi
              WHERE vi.contact_id=c.id AND vi.state='pending'))
       AND (pf.contact_id IS NULL
            OR pf.email_token_hash IS DISTINCT FROM encode(sha256(convert_to(lower(btrim(c.email)),'UTF8')),'hex')
            OR (pf.status IN ('dns_indeterminate') AND pf.checked_at < NOW() - INTERVAL '1 day'))
     ORDER BY EXISTS (SELECT 1 FROM validation_intents vi WHERE vi.contact_id=c.id AND vi.state='pending') DESC,
              c.id
     LIMIT ${bounded}
  `));
  const counts: Record<string, number> = { examined: contacts.length };
  const parsed = contacts.map((c) => ({ id: Number(c.id), email: String(c.email), domain: emailDomainOf(c.email) }));
  const statuses = await checkDomains([...new Set(parsed.flatMap((c) => (c.domain ? [c.domain] : [])))]);
  for (const contact of parsed) {
    const tokenHash = hashEmailToken(contact.email);
    if (!tokenHash) continue;
    const status: EmailPrefilterStatus = contact.domain
      ? statuses.get(contact.domain) ?? "dns_indeterminate" : "bad_syntax";
    await saveContactResult(contact.id, tokenHash, contact.domain, status);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/** Prior bounce / hard-failure evidence for the address or its contact. */
export async function priorBounceReason(contactId: number): Promise<string | null> {
  const row = rows(await db.execute(sql`
    SELECT c.id FROM contacts c
     WHERE c.id=${contactId} AND (
       COALESCE(c.bounce_status,'none') <> 'none' OR c.bounced_at IS NOT NULL
       OR c.contact_bounced_at IS NOT NULL OR c.bounce_date IS NOT NULL
       OR c.email_status IN ('bounced','invalid')
       OR EXISTS (SELECT 1 FROM contacts o WHERE o.id<>c.id AND o.email_token_hash IS NOT NULL
            AND o.email_token_hash=c.email_token_hash
            AND (COALESCE(o.bounce_status,'none')<>'none' OR o.bounced_at IS NOT NULL
                 OR o.contact_bounced_at IS NOT NULL OR o.email_status IN ('bounced','invalid'))))
  `))[0];
  return row ? "prior_bounce" : null;
}

/** Decide, just before a paid call, whether this contact's address may spend a credit. */
export async function emailPrefilterSpendBlock(contactId: number, email: string): Promise<string | null> {
  const bounce = await priorBounceReason(contactId);
  if (bounce) return bounce;
  const tokenHash = hashEmailToken(email);
  const domain = emailDomainOf(email);
  if (!tokenHash) return "email_prefilter_bad_syntax";
  if (!domain) {
    await saveContactResult(contactId, tokenHash, null, "bad_syntax");
    return "email_prefilter_bad_syntax";
  }
  let saved = rows(await db.execute(sql`
    SELECT status FROM contact_email_prefilter
     WHERE contact_id=${contactId} AND email_token_hash=${tokenHash}
       AND checked_at > NOW() - INTERVAL '3 days'
  `))[0]?.status as EmailPrefilterStatus | undefined;
  if (!saved) {
    saved = (await checkDomains([domain])).get(domain) ?? "dns_indeterminate";
    await saveContactResult(contactId, tokenHash, domain, saved);
  }
  return PREFILTER_BLOCKING_STATUSES.includes(saved) ? `email_prefilter_${saved}` : null;
}
