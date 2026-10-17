export interface SfpAiVerticalResult {
  outcome: "target" | "non_target" | "review_required";
  confidence: number;
  reasonCodes: string[];
  resolvedVerticalId: string | null;
  /** Which retained source the quote comes from; null when the model gave no citation. */
  evidenceSource: "website" | "listing_category" | null;
  /** Service/category text the model quotes from that source. Verified server-side, never trusted. */
  evidenceQuote: string | null;
}

export function sfpAiVerticalResponseSchema(targetIds: string[]) {
  return {
    name: "sfp_vertical_classification",
    strict: true,
    schema: {
      type: "object",
      properties: {
        outcome: { type: "string", enum: ["target", "non_target", "review_required"] },
        confidence: { type: "number" },
        reasonCodes: { type: "array", items: { type: "string" } },
        resolvedVerticalId: { type: ["string", "null"], enum: [...new Set(targetIds), null] },
        evidenceSource: { type: ["string", "null"], enum: ["website", "listing_category", null] },
        evidenceQuote: { type: ["string", "null"] },
      },
      required: ["outcome", "confidence", "reasonCodes", "resolvedVerticalId", "evidenceSource", "evidenceQuote"],
      additionalProperties: false,
    },
  };
}

/** A generic "target" is not a usable vertical classification. */
export function validateSfpAiVerticalResult(value: unknown, targetIds: string[]): SfpAiVerticalResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const base = ["outcome", "confidence", "reasonCodes", "resolvedVerticalId"];
  const cited = [...base, "evidenceSource", "evidenceQuote"];
  // The legacy four-key shape (stored receipts from before citations) stays valid with no citation.
  const shape = keys.length === 4 ? base : cited;
  if (keys.length !== shape.length || !shape.every(k => keys.includes(k))) return null;
  if (!["target", "non_target", "review_required"].includes(String(record.outcome))) return null;
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) return null;
  if (!Array.isArray(record.reasonCodes) || !record.reasonCodes.every(r => typeof r === "string")) return null;
  if (record.outcome === "target") {
    if (typeof record.resolvedVerticalId !== "string" || !targetIds.includes(record.resolvedVerticalId)) return null;
  } else if (record.resolvedVerticalId !== null) return null;
  if (shape === cited) {
    if (record.evidenceSource !== null && record.evidenceSource !== "website" && record.evidenceSource !== "listing_category") return null;
    if (record.evidenceQuote !== null && typeof record.evidenceQuote !== "string") return null;
  }
  const evidenceSource = shape === cited ? (record.evidenceSource as SfpAiVerticalResult["evidenceSource"]) : null;
  const evidenceQuote = shape === cited && typeof record.evidenceQuote === "string"
    ? record.evidenceQuote.slice(0, 300) : null;
  return {
    evidenceSource,
    evidenceQuote,
    outcome: record.outcome as SfpAiVerticalResult["outcome"],
    confidence: Math.max(0, Math.min(1, record.confidence)),
    reasonCodes: record.reasonCodes.slice(0, 20) as string[],
    resolvedVerticalId: record.resolvedVerticalId as string | null,
  };
}