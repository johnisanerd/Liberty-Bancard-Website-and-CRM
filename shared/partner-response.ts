// Response contract for operator-facing partner records. This module has no database import so the client and
// server share one type. The partners table also stores authentication material (password hash, reset and invite
// tokens and expiries); none of it belongs to any HTTP response, so the server builds responses only through the
// explicit allowlist in server/utils/partner-response.ts, never by spreading a storage row.

/** Partner fields an operator screen may receive. Dates are ISO strings on the wire. */
export type PartnerOperatorRecord = {
  id: number;
  companyName: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  partnerType: string | null;
  affiliateCode: string | null;
  commissionPercent: number | null;
  status: string | null;
  totalReferrals: number | null;
  totalConversions: number | null;
  totalPayouts: string | null;
  totalClicks: number | null;
  agreementDate: string | null;
  website: string | null;
  howHeard: string | null;
  notes: string | null;
  referralOwner: string | null;
  commissionStatus: string | null;
  lastContactAt: string | null;
  partnerCategory: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export const PARTNER_OPERATOR_FIELDS = [
  "id", "companyName", "contactName", "email", "phone", "partnerType", "affiliateCode", "commissionPercent", "status",
  "totalReferrals", "totalConversions", "totalPayouts", "totalClicks", "agreementDate", "website", "howHeard", "notes",
  "referralOwner", "commissionStatus", "lastContactAt", "partnerCategory", "createdAt", "updatedAt",
] as const satisfies readonly (keyof PartnerOperatorRecord)[];

/** Referral Pipeline row: the operator record plus aggregates computed from referrals and deals. */
export type PartnerPipelineRecord = PartnerOperatorRecord & {
  referredMerchantCount: number;
  /** Sum of total processing volume on the partner's referred contacts' open sales-stage production deals
   *  (not archived, each deal counted once) that have a valid stored amount. Processing volume, not revenue. */
  openPipelineVolume: number | null;
  openPipelineDealCount: number;
  /** Open deals whose stored amount is blank or not a valid amount (see shared/amount-contract). Never summed as zero. */
  openPipelineVolumeUnknownDeals: number;
  /** complete: every open deal has a valid amount (or there are none); partial: some do not; unavailable: none do (volume is null). */
  openPipelineVolumeStatus: "complete" | "partial" | "unavailable";
  nextFollowupDue: string | null;
};

/** Display text for one partner's open volume: a known total, a partial total with its unknown-deal count, or Unavailable. */
export function formatOpenPipelineVolume(p: Pick<PartnerPipelineRecord, "openPipelineVolume" | "openPipelineVolumeUnknownDeals" | "openPipelineVolumeStatus">, fmt: (n: number) => string): string {
  if (p.openPipelineVolumeStatus === "unavailable" || p.openPipelineVolume === null) return "Unavailable";
  if (p.openPipelineVolumeStatus === "partial") return `${fmt(p.openPipelineVolume)} (partial: ${p.openPipelineVolumeUnknownDeals} deal${p.openPipelineVolumeUnknownDeals === 1 ? "" : "s"} without a usable amount)`;
  return fmt(p.openPipelineVolume);
}

/** Total across partners; partial when any partner has deals without a usable amount, unavailable when no partner has a known amount. */
export function summarizeOpenPipelineVolume(partners: Array<Pick<PartnerPipelineRecord, "openPipelineVolume" | "openPipelineVolumeUnknownDeals" | "openPipelineVolumeStatus" | "openPipelineDealCount">>) {
  const total = partners.reduce((sum, p) => sum + (p.openPipelineVolume ?? 0), 0);
  const unknownDeals = partners.reduce((sum, p) => sum + p.openPipelineVolumeUnknownDeals, 0);
  const deals = partners.reduce((sum, p) => sum + p.openPipelineDealCount, 0);
  const status: "complete" | "partial" | "unavailable" = unknownDeals === 0 ? "complete" : unknownDeals >= deals ? "unavailable" : "partial";
  return { total: status === "unavailable" ? null : total, unknownDeals, status };
}
