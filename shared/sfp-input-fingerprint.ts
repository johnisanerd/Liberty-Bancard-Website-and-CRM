/**
 * Fingerprint of the stored listing-category facts a vertical classification rests on: the
 * structured vertical and both industry fields. A classification row records the fingerprint it was
 * made from, so a later change to any of them is detectable without re-running the classifier.
 *
 * The retained listing-category evidence hashes are part of it too (see above).
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
export const SFP_INPUT_FINGERPRINT_VERSION = "sfp-input-v2";
export const SFP_INPUT_FINGERPRINT_SEPARATOR = "\u001f";

function aliasName(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("SFP_INPUT_FINGERPRINT_ALIAS_INVALID");
  return alias;
}

/**
 * Retained, identity-matched provider listing categories that the acceptance policy reads
 * (sfp_paid_candidate_evidence.listing_category), excluding quarantined businesses and discredited
 * evidence. Their value hashes join the fingerprint, so a newly retained or withdrawn category makes
 * the earlier decision stale. SQL for the comma-joined, byte-ordered hashes of a `businesses` alias.
 */
export function sfpRetainedListingCategoryHashesSql(alias: string): string {
  const b = aliasName(alias);
  return `COALESCE((SELECT string_agg(pe.normalized_value_hash, ',' ORDER BY pe.normalized_value_hash COLLATE "C")
      FROM sfp_paid_candidate_evidence pe
     WHERE pe.business_id=${b}.id AND pe.field='listing_category'
       AND pe.candidate_metadata->>'acceptedIdentityMatch'='true'
       AND NOT EXISTS (SELECT 1 FROM sfp_identity_quarantines q WHERE q.business_id=pe.business_id AND q.cleared_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM sfp_discredited_paid_evidence d WHERE d.evidence_id=pe.id)),'')`;
}

/** SQL expression computing the same fingerprint for a `businesses` alias. */
export function sfpInputFingerprintSql(alias: string): string {
  const b = aliasName(alias);
  const sep = `E'\\x1f'`;
  return `encode(sha256(convert_to(` +
    `'${SFP_INPUT_FINGERPRINT_VERSION}'||${sep}||COALESCE(${b}.vertical::text,'')` +
    `||${sep}||COALESCE(${b}.industry_primary::text,'')` +
    `||${sep}||COALESCE(${b}.industry_secondary::text,'')` +
    `||${sep}||${sfpRetainedListingCategoryHashesSql(b)},'UTF8')),'hex')`;
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

/**
 * Version of the website extractor (redirect handling, status handling, retained main-content text).
 * Bump it when what the extractor can see changes: results that read, or failed to read, a website
 * under an older extractor are reconsidered once.
 */
export const SFP_WEBSITE_EXTRACTOR_VERSION = 2;

/**
 * Website source marker. Every classification row records which website source (none, or the
 * normalized domain) and which extractor version its decision rested on, as a reason code. The input
 * fingerprint above deliberately excludes the domain, so this marker is what lets a held,
 * source-poor result be reopened when a website is added, changed, or first becomes readable, without
 * making an unrelated enrichment invalidate a listing-based decision.
 */
export const SFP_WEBSITE_SOURCE_MARKER_PREFIX = "WEBSITE_SOURCE:";

export function normalizeWebsiteDomainForMarker(domain: string | null | undefined): string {
  return (domain ?? "").trim().replace(/^(https?:\/\/)?(www\.)?/i, "").split("/")[0].toLowerCase();
}

/** SQL expression for the normalized website domain of a `businesses` alias (same rule as the TS form). */
export function sfpNormalizedWebsiteDomainSql(alias: string): string {
  const b = aliasName(alias);
  return `lower(split_part(regexp_replace(btrim(COALESCE(${b}.website_domain::text,'')),'^(https?://)?(www\\.)?','','i'),'/',1))`;
}

/** SQL expression for the marker a decision made now for a `businesses` alias would carry. */
export function sfpWebsiteSourceMarkerSql(alias: string): string {
  const norm = sfpNormalizedWebsiteDomainSql(alias);
  return `('${SFP_WEBSITE_SOURCE_MARKER_PREFIX}v${SFP_WEBSITE_EXTRACTOR_VERSION}:'||CASE WHEN ${norm}='' THEN 'none' ELSE left(md5(${norm}),12) END)`;
}

/** SQL: TRUE when evidence row `e` records the website source that business `b` has right now. */
export function sfpEvidenceWebsiteSourceCurrentSql(evidenceAlias: string, businessAlias: string): string {
  const e = aliasName(evidenceAlias);
  return `${e}.reason_codes @> jsonb_build_array(${sfpWebsiteSourceMarkerSql(businessAlias)})`;
}
