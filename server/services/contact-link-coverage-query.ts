/**
 * Pure, batched read-only source query for contact-link coverage.
 *
 * Equality-key joins are deliberately separated by evidence type. Expensive
 * name/phone/address normalization is computed once per batch on the business
 * and retained-source sides, not in a per-contact correlated lookup. Sunbiz
 * lineage joins use exact filing-key equality so the existing indexes remain
 * usable; this never scans the full Sunbiz universe.
 */
// The database generates these keys with the exact prior normalization.
// Ordinary column indexes avoid Publish's broken nested-index serialization.
import { relationshipReasonsSql } from "../../shared/relationship-evidence-sql";
const SUNBIZ_NAME_KEY_ENTITY_SQL = "se.contact_identity_name_key";
const SUNBIZ_NAME_KEY_DBA_SQL = "se.contact_identity_dba_key";

/**
 * Reconciliation's single-contact probe uses the same indexed legal-name and
 * DBA keys as the batched coverage query. $1 is a normalizeCoverageName key;
 * $2 is a bounded candidate limit.
 */
export const CONTACT_LINK_UNLINKED_SUNBIZ_NAME_MATCH_SQL = `
SELECT DISTINCT ON (matches.source_entity_id)
  matches.source_entity_id AS "sourceEntityId",
  matches.filing_number AS "filingNumber",
  matches.entity_name AS "entityName",
  matches.dba,
  matches.website,
  matches.principal_address AS "principalAddress",
  matches.principal_city AS "principalCity",
  matches.principal_state AS "principalState",
  matches.principal_zip AS "principalZip",
  matches.phone,
  matches.owner_phone AS "ownerPhone",
  matches.source AS "entitySource",
  matches.match_type AS "matchType"
FROM (
  SELECT se.id AS source_entity_id, se.filing_number, se.entity_name, se.dba,
    se.website, se.principal_address, se.principal_city, se.principal_state,
    se.principal_zip, se.phone, se.owner_phone, se.source,
    'legal_name'::text AS match_type
  FROM sunbiz_entities se
  WHERE ${SUNBIZ_NAME_KEY_ENTITY_SQL} = $1::text
    AND se.filing_number IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM canonical_source_links csl
      WHERE csl.stable_key = se.filing_number
        AND ((csl.source_system = 'sunbiz' AND csl.source_type = 'sunbiz_entity')
          OR (csl.source_system = 'sunbiz_entities' AND csl.source_type = 'sunbiz_filing'))
    )
  UNION ALL
  SELECT se.id AS source_entity_id, se.filing_number, se.entity_name, se.dba,
    se.website, se.principal_address, se.principal_city, se.principal_state,
    se.principal_zip, se.phone, se.owner_phone, se.source,
    'dba'::text AS match_type
  FROM sunbiz_entities se
  WHERE ${SUNBIZ_NAME_KEY_DBA_SQL} = $1::text
    AND se.dba IS NOT NULL
    AND se.filing_number IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM canonical_source_links csl
      WHERE csl.stable_key = se.filing_number
        AND ((csl.source_system = 'sunbiz' AND csl.source_type = 'sunbiz_entity')
          OR (csl.source_system = 'sunbiz_entities' AND csl.source_type = 'sunbiz_filing'))
    )
) matches
ORDER BY matches.source_entity_id
LIMIT $2::integer
`;

export const CONTACT_LINK_COVERAGE_BATCH_SQL = `
WITH page AS MATERIALIZED (
  SELECT
    c.id AS contact_id,
    c.company_name,
    lower(regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            split_part(regexp_replace(trim(coalesce(c.website, '')), '^[a-zA-Z]+://', '', 'i'), '/', 1),
            '[?#].*$', ''
          ),
          '^www[.]', '', 'i'
        ),
        ':[0-9]+$', ''
      ),
      '[.]$', ''
    )) AS website_domain_key,
    lower(split_part(trim(coalesce(c.email, '')), '@', 2)) AS email_domain_key,
    (length(coalesce(c.email, '')) - length(replace(coalesce(c.email, ''), '@', '')) = 1) AS email_has_exactly_one_at,
    c.website,
    c.address,
    c.city,
    c.state,
    c.phone,
    c.row_provenance,
    c.record_class,
    c.email_status,
    c.archived_at,
    COALESCE(c.existing_merchant_customer, false) AS existing_merchant_customer,
    COALESCE(c.do_not_contact, false) AS do_not_contact,
    COALESCE(c.do_not_auto_contact, false) AS do_not_auto_contact,
    COALESCE(c.opted_out_email, false) AS opted_out_email,
    c.opt_out_status,
    c.unsubscribe_status,
    c.bounce_status,
    c.complaint_status,
    c.suppression_reason,
    c.business_id AS projected_business_id,
    c.primary_source_event_id,
    d.id AS current_decision_id,
    d.decision AS current_decision,
    d.business_id AS current_decision_business_id,
    COALESCE(d.revision, 0) AS current_revision
  FROM contacts c
  LEFT JOIN contact_business_link_decisions d
    ON d.contact_id = c.id AND d.superseded_at IS NULL
  WHERE (
    ($4::integer[] IS NULL AND c.id > $1 AND c.id <= $2)
    OR ($4::integer[] IS NOT NULL AND c.id = ANY($4::integer[]))
  )
  ORDER BY c.id
  LIMIT $3
),
contact_names AS MATERIALIZED (
  SELECT DISTINCT p.contact_id, trim(regexp_replace(
    regexp_replace(
      lower(regexp_replace(coalesce(p.company_name, ''), '[^a-zA-Z0-9]+', ' ', 'g')),
      '\\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\\M', ' ', 'g'
    ),
    '\\s+', ' ', 'g'
  )) AS key
  FROM page p
  WHERE nullif(trim(p.company_name), '') IS NOT NULL
),
contact_source_name_keys AS MATERIALIZED (
  SELECT contact_id, key
  FROM contact_names
  WHERE length(key) >= 4
),
contact_filing_keys AS MATERIALIZED (
  SELECT DISTINCT p.contact_id, lower(key_value) AS key
  FROM page p
  CROSS JOIN LATERAL jsonb_array_elements_text(jsonb_build_array(
    p.row_provenance->>'filing_number',
    p.row_provenance->>'filingNumber',
    p.row_provenance->>'sunbiz_filing_number',
    p.row_provenance->>'sunbizFilingNumber'
  )) AS filing_values(key_value)
  WHERE nullif(key_value, '') IS NOT NULL
  UNION
  SELECT DISTINCT p.contact_id, lower(key_value) AS key
  FROM page p
  JOIN contact_source_events e ON e.contact_id = p.contact_id
  CROSS JOIN LATERAL jsonb_array_elements_text(jsonb_build_array(
    e.metadata->>'filing_number',
    e.metadata->>'filingNumber',
    e.metadata->>'sunbiz_filing_number',
    e.metadata->>'sunbizFilingNumber'
  )) AS event_filing_values(key_value)
  WHERE nullif(key_value, '') IS NOT NULL
  UNION
  SELECT DISTINCT p.contact_id, lower(e.source_external_id) AS key
  FROM page p
  JOIN contact_source_events e ON e.contact_id = p.contact_id
  WHERE nullif(e.source_external_id, '') IS NOT NULL
    AND concat_ws(' ', e.source_category, e.source_type) ~* '(filing|sunbiz)'
),
contact_identity_keys AS MATERIALIZED (
  SELECT contact_id, 'name'::text AS kind, key FROM contact_names
  UNION ALL
  SELECT contact_id, 'domain', website_domain_key
  FROM page WHERE nullif(website_domain_key, '') IS NOT NULL
  UNION ALL
  SELECT contact_id, 'domain', email_domain_key
  FROM page
  WHERE email_has_exactly_one_at AND nullif(email_domain_key, '') IS NOT NULL
    AND email_domain_key <> ALL(ARRAY[
      'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','outlook.com',
      'hotmail.com','live.com','aol.com','icloud.com','me.com','msn.com',
      'proton.me','protonmail.com','mail.com','comcast.net','att.net'
    ]::text[])
  UNION ALL
  SELECT contact_id, 'phone', regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
  FROM page
  WHERE nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
  UNION ALL
  SELECT contact_id, 'address', lower(regexp_replace(coalesce(address, ''), '[^a-zA-Z0-9]', '', 'g'))
  FROM page
  WHERE nullif(trim(coalesce(address, '')), '') IS NOT NULL
  UNION ALL
  SELECT contact_id, 'address',
    lower(regexp_replace(
      concat_ws(' ', nullif(address, ''), nullif(city, ''), nullif(state, '')),
      '[^a-zA-Z0-9]', '', 'g'
    ))
  FROM page
  WHERE nullif(trim(coalesce(address, '')), '') IS NOT NULL
  UNION ALL
  SELECT contact_id, 'filing', key FROM contact_filing_keys
),
canonical_domain_counts AS NOT MATERIALIZED (
  SELECT
    lower(regexp_replace(trim(website_domain), '^www[.]', '', 'i')) AS domain_key,
    count(*)::int AS domain_business_count
  FROM businesses
  WHERE record_class = 'canonical'
  GROUP BY lower(regexp_replace(trim(website_domain), '^www[.]', '', 'i'))
),
canonical_businesses AS MATERIALIZED (
  SELECT
    b.id AS business_id,
    b.canonical_name,
    b.normalized_name,
    b.website_domain,
    b.main_phone,
    b.street_address,
    b.city,
    b.state,
    b.postal_code,
    b.record_class,
    COALESCE(b.do_not_visit, false) AS do_not_visit,
    lower(regexp_replace(
      regexp_replace(
        regexp_replace(trim(b.website_domain), '^www[.]', '', 'i'),
        ':[0-9]+$', ''
      ),
      '[.]$', ''
    )) AS domain_key,
    COALESCE(domain_counts.domain_business_count, 0) AS domain_business_count,
    regexp_replace(coalesce(b.main_phone, ''), '[^0-9]', '', 'g') AS phone_key,
    lower(regexp_replace(concat_ws(' ', nullif(b.street_address, ''), nullif(b.city, ''), nullif(b.state, '')), '[^a-zA-Z0-9]', '', 'g')) AS address_key
  FROM businesses b
  LEFT JOIN canonical_domain_counts domain_counts
    ON domain_counts.domain_key = lower(regexp_replace(trim(b.website_domain), '^www[.]', '', 'i'))
),
business_name_keys AS MATERIALIZED (
  SELECT business_id, trim(regexp_replace(
    regexp_replace(
      lower(regexp_replace(coalesce(normalized.value, ''), '[^a-zA-Z0-9]+', ' ', 'g')),
      '\\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\\M', ' ', 'g'
    ),
    '\\s+', ' ', 'g'
  )) AS key
  FROM canonical_businesses b
  CROSS JOIN LATERAL (VALUES (b.canonical_name), (b.normalized_name)) normalized(value)
  WHERE nullif(trim(normalized.value), '') IS NOT NULL
),
all_sunbiz_source_links AS MATERIALIZED (
  SELECT
    csl.id AS source_link_id,
    csl.business_id,
    csl.source_system,
    csl.source_type,
    csl.stable_key,
    csl.raw_evidence,
    se.id AS source_entity_id,
    se.entity_name,
    se.dba,
    se.website,
    se.filing_number,
    se.principal_address,
    se.principal_city,
    se.principal_state,
    se.principal_zip,
    se.phone,
    se.owner_phone,
    se.source AS entity_source
  FROM canonical_source_links csl
  LEFT JOIN sunbiz_entities se ON se.filing_number = csl.stable_key
  JOIN canonical_businesses b ON b.business_id = csl.business_id
  WHERE csl.source_system = 'sunbiz'
    AND csl.source_type = 'sunbiz_entity'
),
raw_unlinked_sunbiz_by_contact AS MATERIALIZED (
  SELECT
    p.contact_id,
    raw.source_entity_id,
    raw.filing_number,
    raw.entity_name,
    raw.dba,
    raw.website,
    raw.principal_address,
    raw.principal_city,
    raw.principal_state,
    raw.principal_zip,
    raw.phone,
    raw.owner_phone,
    raw.source
  FROM page p
  JOIN contact_source_name_keys contact_key ON contact_key.contact_id = p.contact_id
  CROSS JOIN LATERAL (
    SELECT DISTINCT ON (matches.source_entity_id)
      matches.source_entity_id,
      matches.filing_number,
      matches.entity_name,
      matches.dba,
      matches.website,
      matches.principal_address,
      matches.principal_city,
      matches.principal_state,
      matches.principal_zip,
      matches.phone,
      matches.owner_phone,
      matches.source
    FROM (
      SELECT se.id AS source_entity_id, se.filing_number, se.entity_name, se.dba,
        se.website, se.principal_address, se.principal_city, se.principal_state,
        se.principal_zip, se.phone, se.owner_phone, se.source
      FROM sunbiz_entities se
      WHERE ${SUNBIZ_NAME_KEY_ENTITY_SQL} = contact_key.key
        AND se.filing_number IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM canonical_source_links csl
          WHERE csl.stable_key = se.filing_number
            AND ((csl.source_system = 'sunbiz' AND csl.source_type = 'sunbiz_entity')
              OR (csl.source_system = 'sunbiz_entities' AND csl.source_type = 'sunbiz_filing'))
        )
      UNION ALL
      SELECT se.id AS source_entity_id, se.filing_number, se.entity_name, se.dba,
        se.website, se.principal_address, se.principal_city, se.principal_state,
        se.principal_zip, se.phone, se.owner_phone, se.source
      FROM sunbiz_entities se
      WHERE ${SUNBIZ_NAME_KEY_DBA_SQL} = contact_key.key
        -- Required by the existing partial DBA-key index. A nonempty
        -- normalized DBA key already implies a DBA; state it for the planner.
        AND se.dba IS NOT NULL
        AND se.filing_number IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM canonical_source_links csl
          WHERE csl.stable_key = se.filing_number
            AND ((csl.source_system = 'sunbiz' AND csl.source_type = 'sunbiz_entity')
              OR (csl.source_system = 'sunbiz_entities' AND csl.source_type = 'sunbiz_filing'))
        )
    ) matches
    ORDER BY matches.source_entity_id
    LIMIT 21
  ) raw
),
source_identity_keys AS MATERIALIZED (
  SELECT business_id, 'name'::text AS kind, trim(regexp_replace(
    regexp_replace(
      lower(regexp_replace(coalesce(normalized.value, ''), '[^a-zA-Z0-9]+', ' ', 'g')),
      '\\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\\M', ' ', 'g'
    ),
    '\\s+', ' ', 'g'
  )) AS key
  FROM all_sunbiz_source_links source
  CROSS JOIN LATERAL (VALUES (source.entity_name), (source.dba)) normalized(value)
  WHERE nullif(trim(normalized.value), '') IS NOT NULL
  UNION ALL
  SELECT business_id, 'domain',
    lower(regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            split_part(regexp_replace(trim(coalesce(website, '')), '^[a-zA-Z]+://', '', 'i'), '/', 1),
            '[?#].*$', ''
          ),
          '^www[.]', '', 'i'
        ),
        ':[0-9]+$', ''
      ),
      '[.]$', ''
    ))
  FROM all_sunbiz_source_links
  WHERE nullif(trim(coalesce(website, '')), '') IS NOT NULL
  UNION ALL
  SELECT business_id, 'phone', regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')
  FROM all_sunbiz_source_links
  WHERE nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
  UNION ALL
  SELECT business_id, 'phone', regexp_replace(coalesce(owner_phone, ''), '[^0-9]', '', 'g')
  FROM all_sunbiz_source_links
  WHERE nullif(regexp_replace(coalesce(owner_phone, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
  UNION ALL
  SELECT business_id, 'address',
    lower(regexp_replace(concat_ws(' ', nullif(principal_address, ''), nullif(principal_city, ''), nullif(principal_state, '')), '[^a-zA-Z0-9]', '', 'g'))
  FROM all_sunbiz_source_links
  WHERE nullif(trim(coalesce(principal_address, '')), '') IS NOT NULL
  UNION ALL
  SELECT business_id, 'address', lower(regexp_replace(coalesce(principal_address, ''), '[^a-zA-Z0-9]', '', 'g'))
  FROM all_sunbiz_source_links
  WHERE nullif(trim(coalesce(principal_address, '')), '') IS NOT NULL
  UNION ALL
  SELECT business_id, 'filing', lower(stable_key) FROM all_sunbiz_source_links
  WHERE nullif(stable_key, '') IS NOT NULL
),
business_identity_keys AS MATERIALIZED (
  SELECT business_id, 'domain'::text AS kind, domain_key AS key
  FROM canonical_businesses WHERE nullif(domain_key, '') IS NOT NULL
  UNION ALL
  SELECT business_id, 'phone', phone_key
  FROM canonical_businesses WHERE nullif(phone_key, '') IS NOT NULL
  UNION ALL
  SELECT business_id, 'address', address_key
  FROM canonical_businesses WHERE nullif(address_key, '') IS NOT NULL
  UNION ALL
  SELECT business_id, 'address', lower(regexp_replace(coalesce(street_address, ''), '[^a-zA-Z0-9]', '', 'g'))
  FROM canonical_businesses WHERE nullif(trim(coalesce(street_address, '')), '') IS NOT NULL
  UNION ALL
  SELECT business_id, 'name', key FROM business_name_keys
  UNION ALL
  SELECT business_id, kind, key FROM source_identity_keys
),
candidate_pairs AS MATERIALIZED (
  SELECT DISTINCT contact_keys.contact_id, business_keys.business_id
  FROM contact_identity_keys contact_keys
  JOIN business_identity_keys business_keys
    ON business_keys.kind = contact_keys.kind
   AND business_keys.key = contact_keys.key
  UNION
  SELECT DISTINCT raw.contact_id, business_name.business_id
  FROM raw_unlinked_sunbiz_by_contact raw
  CROSS JOIN LATERAL (VALUES (raw.entity_name), (raw.dba)) source_name(value)
  JOIN business_name_keys business_name
    ON business_name.key = trim(regexp_replace(
      regexp_replace(
        lower(regexp_replace(coalesce(source_name.value, ''), '[^a-zA-Z0-9]+', ' ', 'g')),
        '\\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\\M', ' ', 'g'
      ),
      '\\s+', ' ', 'g'
    ))
  UNION
  SELECT p.contact_id, p.projected_business_id
  FROM page p WHERE p.projected_business_id IS NOT NULL
  UNION
  SELECT p.contact_id, p.current_decision_business_id
  FROM page p WHERE p.current_decision_business_id IS NOT NULL
),
candidate_business_ids AS MATERIALIZED (
  SELECT DISTINCT business_id FROM candidate_pairs
),
source_links_by_business AS MATERIALIZED (
  SELECT
    source.business_id,
    jsonb_agg(jsonb_build_object(
      'sourceLinkId', source.source_link_id::text,
      'businessId', source.business_id,
      'sourceSystem', source.source_system,
      'sourceType', source.source_type,
      'stableKey', source.stable_key,
      'rawEvidence', source.raw_evidence,
      'sourceEntityId', source.source_entity_id,
      'sunbizName', source.entity_name,
      'sunbizDba', source.dba,
      'sunbizWebsite', source.website,
      'sunbizFilingNumber', source.filing_number,
      'sunbizAddress', source.principal_address,
      'sunbizCity', source.principal_city,
      'sunbizState', source.principal_state,
      'sunbizZip', source.principal_zip,
      'sunbizPhone', source.phone,
      'sunbizOwnerPhone', source.owner_phone,
      'sunbizEntitySource', source.entity_source
    ) ORDER BY source.source_link_id) AS source_links
  FROM candidate_business_ids candidate
  JOIN all_sunbiz_source_links source ON source.business_id = candidate.business_id
  GROUP BY source.business_id
),
raw_sunbiz_by_contact_business AS MATERIALIZED (
  SELECT
    raw.contact_id,
    business_name.business_id,
    jsonb_agg(jsonb_build_object(
      'sourceEntityId', raw.source_entity_id,
      'filingNumber', raw.filing_number,
      'entityName', raw.entity_name,
      'dba', raw.dba,
      'website', raw.website,
      'principalAddress', raw.principal_address,
      'principalCity', raw.principal_city,
      'principalState', raw.principal_state,
      'principalZip', raw.principal_zip,
      'phone', raw.phone,
      'ownerPhone', raw.owner_phone,
      'entitySource', raw.source
    ) ORDER BY raw.source_entity_id) AS matches
  FROM raw_unlinked_sunbiz_by_contact raw
  CROSS JOIN LATERAL (VALUES (raw.entity_name), (raw.dba)) source_name(value)
  JOIN business_name_keys business_name
    ON business_name.key = trim(regexp_replace(
      regexp_replace(
        lower(regexp_replace(coalesce(source_name.value, ''), '[^a-zA-Z0-9]+', ' ', 'g')),
        '\\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\\M', ' ', 'g'
      ),
      '\\s+', ' ', 'g'
    ))
  GROUP BY raw.contact_id, business_name.business_id
),
contact_data AS (
  SELECT
    p.*,
    (p.archived_at IS NOT NULL) AS archived,
    (p.current_decision = 'verified'
      AND p.current_decision_business_id IS NOT NULL
      AND p.projected_business_id = p.current_decision_business_id) AS current_decision_consistent,
    COALESCE(events.source_events, '[]'::jsonb) AS source_events,
    COALESCE(raw_sources.raw_candidates, '[]'::jsonb) AS raw_sunbiz_candidates
  FROM page p
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'eventId', e.id,
      'eventKey', e.event_key,
      'sourceCategory', e.source_category,
      'sourceType', e.source_type,
      'sourceExternalId', e.source_external_id,
      'actorType', e.actor_type,
      'actorId', e.actor_id,
      'metadata', e.metadata
    ) ORDER BY e.id) FILTER (WHERE e.id IS NOT NULL) AS source_events
    FROM contact_source_events e
    WHERE e.contact_id = p.contact_id
  ) events ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'sourceEntityId', raw.source_entity_id,
      'filingNumber', raw.filing_number,
      'entityName', raw.entity_name,
      'dba', raw.dba,
      'website', raw.website,
      'principalAddress', raw.principal_address,
      'principalCity', raw.principal_city,
      'principalState', raw.principal_state,
      'principalZip', raw.principal_zip,
      'phone', raw.phone,
      'ownerPhone', raw.owner_phone,
      'entitySource', raw.source
    ) ORDER BY raw.source_entity_id) AS raw_candidates
    FROM raw_unlinked_sunbiz_by_contact raw
    WHERE raw.contact_id = p.contact_id
  ) raw_sources ON true
),
business_data AS (
  SELECT
    cp.contact_id,
    b.business_id,
    b.canonical_name,
    b.normalized_name,
    b.website_domain,
    b.main_phone,
    b.street_address,
    b.city,
    b.state,
    b.postal_code,
    b.record_class,
    b.do_not_visit,
    b.domain_business_count,
    COALESCE(source_links.source_links, '[]'::jsonb) AS source_links,
    COALESCE(raw_sunbiz.matches, '[]'::jsonb) AS raw_sunbiz_matches
  FROM candidate_pairs cp
  JOIN canonical_businesses b ON b.business_id = cp.business_id
  LEFT JOIN source_links_by_business source_links ON source_links.business_id = b.business_id
  LEFT JOIN raw_sunbiz_by_contact_business raw_sunbiz
    ON raw_sunbiz.contact_id = cp.contact_id AND raw_sunbiz.business_id = b.business_id
)
SELECT
  c.contact_id AS "contactId",
  c.company_name AS "companyName",
  c.email_domain_key AS "emailDomain",
  c.email_has_exactly_one_at AS "emailHasExactlyOneAt",
  c.website,
  c.address,
  c.city,
  c.state,
  c.phone,
  c.row_provenance AS "rowProvenance",
  c.record_class AS "recordClass",
  c.email_status AS "emailStatus",
  c.archived,
  c.existing_merchant_customer AS "existingMerchantCustomer",
  c.do_not_contact AS "doNotContact",
  c.do_not_auto_contact AS "doNotAutoContact",
  c.opted_out_email AS "optedOutEmail",
  c.opt_out_status AS "optOutStatus",
  c.unsubscribe_status AS "unsubscribeStatus",
  c.bounce_status AS "bounceStatus",
  c.complaint_status AS "complaintStatus",
  c.suppression_reason AS "suppressionReason",
  c.projected_business_id AS "projectedBusinessId",
  c.current_decision_id AS "currentDecisionId",
  c.current_decision AS "currentDecision",
  c.current_decision_business_id AS "currentDecisionBusinessId",
  c.current_revision AS "currentRevision",
  c.current_decision_consistent AS "currentDecisionConsistent",
  c.primary_source_event_id AS "primarySourceEventId",
  c.source_events AS "sourceEvents",
  c.raw_sunbiz_candidates AS "rawSunbizCandidates",
  COALESCE(jsonb_agg(jsonb_build_object(
    'businessId', b.business_id,
    'canonicalName', b.canonical_name,
    'normalizedName', b.normalized_name,
    'websiteDomain', b.website_domain,
    'mainPhone', b.main_phone,
    'streetAddress', b.street_address,
    'city', b.city,
    'state', b.state,
    'postalCode', b.postal_code,
    'recordClass', b.record_class,
    'doNotVisit', b.do_not_visit,
    'domainBusinessCount', b.domain_business_count,
     'sourceLinks', b.source_links,
     'automaticRelationshipReasons', (
       WITH proofs AS MATERIALIZED (
         SELECT ${relationshipReasonsSql("c.contact_id", "b.business_id", "sl.id", "se.id")} AS reasons
         FROM canonical_source_links sl
         LEFT JOIN sunbiz_entities se ON sl.source_system='sunbiz' AND sl.source_type='sunbiz_entity'
           AND se.filing_number=sl.stable_key AND se.source IN ('sunbiz','cordata','corevt')
         WHERE sl.business_id=b.business_id
       )
       SELECT CASE WHEN EXISTS (SELECT 1 FROM proofs WHERE cardinality(reasons)=0)
         THEN '[]'::jsonb
         WHEN NOT EXISTS (SELECT 1 FROM proofs) THEN '["independent_source_link_missing"]'::jsonb
         ELSE to_jsonb(ARRAY(SELECT DISTINCT reason FROM proofs
           CROSS JOIN LATERAL unnest(reasons) AS reason ORDER BY reason)) END
     ),
     'rawSunbizMatches', b.raw_sunbiz_matches
  ) ORDER BY b.business_id) FILTER (WHERE b.business_id IS NOT NULL), '[]'::jsonb) AS businesses
FROM contact_data c
LEFT JOIN business_data b ON b.contact_id = c.contact_id
GROUP BY c.contact_id,c.company_name,c.email_domain_key,c.email_has_exactly_one_at,
  c.website,c.address,c.city,c.state,c.phone,
  c.row_provenance,c.record_class,c.email_status,c.archived,c.existing_merchant_customer,
  c.do_not_contact,c.do_not_auto_contact,c.opted_out_email,c.opt_out_status,c.unsubscribe_status,
  c.bounce_status,c.complaint_status,c.suppression_reason,c.projected_business_id,
  c.current_decision_id,c.current_decision,c.current_decision_business_id,c.current_revision,
   c.current_decision_consistent,c.primary_source_event_id,c.source_events,c.raw_sunbiz_candidates
ORDER BY c.contact_id
`;

export const CONTACT_LINK_COVERAGE_WATERMARK_SQL = `
SELECT COALESCE(MAX(id), 0)::int AS watermark, count(*)::int AS total
FROM contacts
`;
