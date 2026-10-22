import { PARTNER_OPERATOR_FIELDS, type PartnerOperatorRecord, type PartnerPipelineRecord } from "@shared/partner-response";

type Row = Record<string, unknown>;

const toWire = (value: unknown) => value instanceof Date ? value.toISOString() : value;

/** Allowlisted operator view of a partner storage row. Unknown or future columns are never copied. */
export function toPartnerOperatorRecord(row: object): PartnerOperatorRecord {
  const source = row as Row;
  const out: Row = {};
  for (const key of PARTNER_OPERATOR_FIELDS) out[key] = toWire(source[key] ?? null);
  return out as unknown as PartnerOperatorRecord;
}

export function toPartnerPipelineRecord(row: object, aggregates: {
  referredMerchantCount: number; openPipelineVolume: number; openPipelineDealCount: number; nextFollowupDue: Date | string | null;
}): PartnerPipelineRecord {
  return {
    ...toPartnerOperatorRecord(row),
    referredMerchantCount: aggregates.referredMerchantCount,
    openPipelineVolume: aggregates.openPipelineVolume,
    openPipelineDealCount: aggregates.openPipelineDealCount,
    nextFollowupDue: aggregates.nextFollowupDue instanceof Date ? aggregates.nextFollowupDue.toISOString() : aggregates.nextFollowupDue,
  };
}

/** Private partner payloads must not be stored by shared caches or the browser. */
export function privatePartnerResponse(res: { setHeader(name: string, value: string): unknown }) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");
}
