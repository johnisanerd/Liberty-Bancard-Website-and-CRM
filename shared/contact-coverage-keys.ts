/** Database-owned read keys. These preserve coverage's existing normalization,
 * not the different organization/source-family identity policy.
 * Inputs are static column identifiers, never user input.
 */
export const coverageNameKey = (value:string) => `btrim(regexp_replace(
  regexp_replace(lower(regexp_replace(coalesce(${value},''),'[^a-zA-Z0-9]+',' ','g')),
  '\\m(incorporated|inc|limited|ltd|llc|llp|corp|corporation|company|co)\\M',' ','g'),
  '\\s+',' ','g'))`;
export const coveragePhoneKey = (value:string) =>
  `regexp_replace(coalesce(${value},''),'[^0-9]','','g')`;
export const coverageAddressKey = (...values:string[]) =>
  `lower(regexp_replace(${values.map(value=>`coalesce(${value},'')`).join(" || ")},'[^a-zA-Z0-9]','','g'))`;
export const coverageCountDomainKey = (value:string) =>
  `lower(regexp_replace(trim(${value}),'^www[.]','','i'))`;
export const coverageBusinessDomainKey = (value:string) =>
  `lower(regexp_replace(regexp_replace(regexp_replace(trim(${value}),
  '^www[.]','','i'),':[0-9]+$',''),'[.]$',''))`;
export const coverageSourceDomainKey = (value:string) =>
  `lower(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
  split_part(regexp_replace(trim(coalesce(${value},'')),'^[a-zA-Z]+://','','i'),'/',1),
  '[?#].*$',''),'^www[.]','','i'),':[0-9]+$',''),'[.]$',''))`;

// Fixed positions are a storage contract. One generated array needs one heap
// rewrite on Publish, instead of a rewrite for every generated scalar column.
export const coverageBusinessKeys = () => `ARRAY[
  ${coverageNameKey("canonical_name")},${coverageNameKey("normalized_name")},
  ${coverageBusinessDomainKey("website_domain")},${coverageCountDomainKey("website_domain")},
  ${coveragePhoneKey("main_phone")},${coverageAddressKey("street_address","city","state")},
  ${coverageAddressKey("street_address")}]`;
export const coverageSourceKeys = () => `ARRAY[
  ${coverageSourceDomainKey("website")},${coveragePhoneKey("phone")},
  ${coveragePhoneKey("owner_phone")},${coverageAddressKey("principal_address","principal_city","principal_state")},
  ${coverageAddressKey("principal_address")}]`;
