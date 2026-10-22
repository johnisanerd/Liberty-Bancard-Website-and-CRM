/**
 * A mailbox is a delivery address, not a person/business identity.
 * Only corroborated, non-conflicting candidates may be reused across sources.
 * Exact source-event retries remain authoritative in the canonical writer.
 */
export interface MailboxIdentity {
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  ghlContactId?: string | null;
}
export class ContactIdentityAmbiguityError extends Error {
  constructor(
    reason:"CONTACT_MAILBOX_IDENTITY_AMBIGUOUS"|"CONTACT_SOURCE_EVENT_IDENTITY_AMBIGUOUS",
    public readonly candidateContactIds:number[],
  ){super(reason);this.name="ContactIdentityAmbiguityError";}
}
const text=(value:unknown)=>String(value??"").normalize("NFKC").trim().toLowerCase().replace(/\s+/g," ");
const phone=(value:unknown)=>String(value??"").replace(/\D/g,"").replace(/^1(?=\d{10}$)/,"");
const state=(value:unknown)=>text(value)==="florida"?"fl":text(value);
export function sameMailboxContactIdentity(a:MailboxIdentity,b:MailboxIdentity):boolean {
  const keys=["firstName","lastName","companyName","address","city","ghlContactId"] as const;
  if(keys.some(key=>text(a[key])&&text(b[key])&&text(a[key])!==text(b[key])))return false;
  if(state(a.state)&&state(b.state)&&state(a.state)!==state(b.state))return false;
  const ap=phone(a.phone),bp=phone(b.phone);
  if(ap&&bp&&ap!==bp)return false;
  const same=(key:typeof keys[number])=>!!text(a[key])&&text(a[key])===text(b[key]);
  if(same("ghlContactId"))return true;
  // A full person name is corroboration; company alone or a shared switchboard
  // is not. Location evidence keeps separate sites of the same brand distinct.
  if(same("firstName")&&same("lastName"))return true;
  if(same("companyName")&&same("address")&&same("city")&&
    !!state(a.state)&&state(a.state)===state(b.state))return true;
  return ap.length>=10&&ap===bp&&(same("companyName")||same("firstName")||same("lastName"));
}
export function selectMailboxContact<T extends MailboxIdentity>(candidates:T[],identity:MailboxIdentity):T|undefined {
  const supported=candidates.filter(candidate=>sameMailboxContactIdentity(candidate,identity));
  // Never pick the first of multiple supported identities.
  if(supported.length>1)throw new ContactIdentityAmbiguityError("CONTACT_MAILBOX_IDENTITY_AMBIGUOUS",
    supported.map(candidate=>(candidate as T&{id?:number}).id).filter((id):id is number=>Number.isInteger(id)));
  return supported[0];
}

/**
 * Identity mutation lock protocol. Every transaction that can make a contact match, or stop matching, a mailbox
 * (the canonical writer, storage create/update, Data Health apply) takes the per-mailbox transaction advisory lock
 * FIRST, before any contact/deal row lock or commercial-graph lock. When several mailboxes are involved (an update
 * from one address to another) they are taken in sorted order so two such updaters cannot deadlock.
 * The key format must match contact-writer.ts and data-health-reconcile.ts.
 */
export function contactMailboxLockKey(email: unknown): string | null {
  const normalized = String(email ?? "").trim().toLowerCase();
  return normalized ? `contact-mailbox:${normalized}` : null;
}
export async function lockContactMailboxes(tx: { execute: (query: any) => Promise<unknown> }, emails: unknown[]): Promise<void> {
  const { sql } = await import("drizzle-orm");
  const keys = [...new Set(emails.map(contactMailboxLockKey).filter((key): key is string => key !== null))].sort();
  for (const key of keys) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
