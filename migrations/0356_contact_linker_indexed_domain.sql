-- Development/disposable delivery only; managed Publish owns production.
-- Nonunique: shared brands/locations must remain competing visible candidates.
-- Use the existing native identity function, not the different coverage key.
CREATE INDEX IF NOT EXISTS canonical_link_business_domain_lookup_idx
  ON businesses (crm_identity_domain(website_domain)) WHERE record_class='canonical';
