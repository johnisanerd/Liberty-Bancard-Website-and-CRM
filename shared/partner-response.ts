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
   *  (not archived, each deal counted once). Processing volume, not revenue. */
  openPipelineVolume: number;
  openPipelineDealCount: number;
  nextFollowupDue: string | null;
};
