/**
 * Fingerprint of the stored listing-category facts a vertical classification rests on: the
 * structured vertical and both industry fields. A classification row records the fingerprint it was
 * made from, so a later change to any of them is detectable without re-running the classifier.
 *
 * Deliberately not part of it: the business name and geography (context and separate gates; routine
 * standardisation must not discard an accepted vertical) and the website domain (enrichment fills a
 * missing domain on already-classified businesses all the time, and that does not invalidate a
 * listing-based decision). A website-based decision is bound to the domain it read separately, see
 * sfpEvidenceCurrentSql.
 *
 * The TypeScript form (server/services/cro03/sfp-input-fingerprint.ts) and the SQL form below must
 * stay byte-identical: a unit separator joins the fields, NULL and empty are the same, UTF-8 text.
 */
export const SFP_INPUT_FINGERPRINT_VERSION = "sfp-input-v1";
export const SFP_INPUT_FINGERPRINT_SEPARATOR = "\u001f";

function aliasName(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("SFP_INPUT_FINGERPRINT_ALIAS_INVALID");
  return alias;
}

/** SQL expression computing the same fingerprint for a `businesses` alias. */
export function sfpInputFingerprintSql(alias: string): string {
  const b = aliasName(alias);
  const sep = `E'\\x1f'`;
  return `encode(sha256(convert_to(` +
    `'${SFP_INPUT_FINGERPRINT_VERSION}'||${sep}||COALESCE(${b}.vertical::text,'')` +
    `||${sep}||COALESCE(${b}.industry_primary::text,'')` +
    `||${sep}||COALESCE(${b}.industry_secondary::text,''),'UTF8')),'hex')`;
}

/**
 * True when a classification evidence row still describes the business as stored: the category
 * fingerprint matches and, if the decision read a website, that website is still the business's
 * domain. Rows written before fingerprints existed carry none and stay current.
 */
export function sfpEvidenceCurrentSql(evidenceAlias: string, businessAlias: string): string {
  const e = aliasName(evidenceAlias);
  const b = aliasName(businessAlias);
  return `(${e}.input_fingerprint IS NULL OR (${e}.input_fingerprint = ${sfpInputFingerprintSql(b)}
    AND (${e}.acceptance_facts->>'websiteSourceUrl' IS NULL
      OR lower(split_part(regexp_replace(${e}.acceptance_facts->>'websiteSourceUrl','^https?://(www\\.)?','','i'),'/',1))
       = lower(split_part(regexp_replace(btrim(COALESCE(${b}.website_domain::text,'')),'^(https?://)?(www\\.)?','','i'),'/',1)))))`;
}
