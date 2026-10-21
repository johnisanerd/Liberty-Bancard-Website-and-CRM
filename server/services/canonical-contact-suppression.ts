/**
 * One definition of "this contact's address is suppressed or invalid" for local candidate screening and the
 * enrichment backlog read model. It mirrors the hold the preparation writer reaches after its qualification phase
 * (about two seconds per contact on production data), so a contact that matches can be recorded as held without paying
 * for that qualification. It is candidate screening only: the writer still rechecks every authority for any contact that
 * passes, and it never creates, retires or sends anything.
 */
export const CONTACT_SUPPRESSED_REASON = "contact_suppressed_or_invalid";

/** Alias must be a plain SQL identifier. */
export function contactSuppressedSql(alias: string): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("CONTACT_SUPPRESSION_SQL_ALIAS_INVALID");
  return `(COALESCE(${alias}.do_not_contact,FALSE) OR COALESCE(${alias}.do_not_auto_contact,FALSE)
    OR COALESCE(${alias}.opted_out_email,FALSE) OR COALESCE(${alias}.bounce_status,'none')='hard'
    OR ${alias}.suppression_reason IS NOT NULL
    OR COALESCE(${alias}.email_status,'unvalidated') IN ('invalid','bounced','unsafe','opted_out'))`;
}
