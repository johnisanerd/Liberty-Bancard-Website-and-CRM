import { normalizeStateIdentity } from "../../shared/state-identity";

export type OrganizationIdentity = {
  canonicalName: string;
  websiteDomain?: string | null;
  googlePlaceId?: string | null;
  mainPhone?: string | null;
  city?: string | null;
  state?: string | null;
  streetAddress?: string | null;
  sourceIdentity?: {sourceSystem: string; sourceType: string; stableKey: string};
};
export type OrganizationCandidate = OrganizationIdentity & {id: number; exactSource?: boolean};
export const normalOrganizationValue = (value?: string | null) => value?.trim().toLowerCase() || null;
export const normalOrganizationName = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
const phone = (value?: string | null) => value?.replace(/\D/g, "") || null;
const address = (value?: string | null) => value?.toLowerCase().replace(/[^a-z0-9]/g, "") || null;

/** A shared domain is brand evidence, not an exact operating-location key. */
export function decideOrganizationIdentity(input: OrganizationIdentity, candidates: OrganizationCandidate[]):
  {kind: "matched"; id: number} | {kind: "create"} |
  {kind: "deferred"; reasonCode: "INSUFFICIENT_ORGANIZATION_EVIDENCE" | "AMBIGUOUS_ORGANIZATION_MATCH"; candidateIds: number[]} {
  const conflict = (candidate: OrganizationCandidate) =>
    !!((input.googlePlaceId && candidate.googlePlaceId && input.googlePlaceId.trim() !== candidate.googlePlaceId.trim()) ||
      (input.websiteDomain && candidate.websiteDomain && normalOrganizationValue(input.websiteDomain) !== normalOrganizationValue(candidate.websiteDomain)) ||
      (phone(input.mainPhone) && phone(candidate.mainPhone) && phone(input.mainPhone) !== phone(candidate.mainPhone)) ||
      (input.city && candidate.city && normalOrganizationValue(input.city) !== normalOrganizationValue(candidate.city)) ||
      (input.state && candidate.state && normalizeStateIdentity(input.state) !== normalizeStateIdentity(candidate.state)) ||
      (address(input.streetAddress) && address(candidate.streetAddress) && address(input.streetAddress) !== address(candidate.streetAddress)) ||
      (normalOrganizationName(input.canonicalName) && normalOrganizationName(candidate.canonicalName) &&
        normalOrganizationName(input.canonicalName) !== normalOrganizationName(candidate.canonicalName)));
  const exactSource = candidates.filter(candidate => candidate.exactSource);
  const exactPlace = candidates.filter(candidate => input.googlePlaceId &&
    candidate.googlePlaceId === input.googlePlaceId.trim());
  // Exact source and place cannot silently disagree about ownership.
  const exact = [...new Map([...exactSource, ...exactPlace].map(candidate => [candidate.id, candidate])).values()];
  const compatible = candidates.filter(candidate => !conflict(candidate));
  const selected = exact.length ? exact : compatible;
  if (selected.length === 1 && !conflict(selected[0])) return {kind: "matched", id: selected[0].id};
  if (selected.length || candidates.length) {
    // A separately supported branch may be created despite unrelated brand-domain
    // candidates. Without a precise place/location, contradiction stays a hold.
    const supportsDistinctLocation = !!input.googlePlaceId ||
      !!(address(input.streetAddress) && input.city?.trim() && normalizeStateIdentity(input.state) &&
        (normalOrganizationValue(input.websiteDomain) || phone(input.mainPhone)));
    const distinct = (candidate: OrganizationCandidate) =>
      !!((input.googlePlaceId && candidate.googlePlaceId && input.googlePlaceId !== candidate.googlePlaceId) ||
        (input.city && candidate.city && normalOrganizationValue(input.city) !== normalOrganizationValue(candidate.city)) ||
        (input.state && candidate.state && normalizeStateIdentity(input.state) !== normalizeStateIdentity(candidate.state)) ||
        (address(input.streetAddress) && address(candidate.streetAddress) && address(input.streetAddress) !== address(candidate.streetAddress)));
    if (!exact.length && !compatible.length && supportsDistinctLocation && candidates.every(distinct))
      return {kind: "create"};
    return {kind: "deferred", reasonCode: "AMBIGUOUS_ORGANIZATION_MATCH",
      candidateIds: (selected.length ? selected : candidates).map(candidate => candidate.id).sort((a,b)=>a-b)};
  }
  if (!normalOrganizationName(input.canonicalName) ||
      !(input.googlePlaceId?.trim() || normalOrganizationValue(input.websiteDomain) || phone(input.mainPhone) ||
        (address(input.streetAddress) && input.city?.trim() && normalizeStateIdentity(input.state))))
    return {kind: "deferred", reasonCode: "INSUFFICIENT_ORGANIZATION_EVIDENCE", candidateIds: []};
  return {kind: "create"};
}
