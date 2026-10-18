import { createHash } from "node:crypto";
import {
  normalizeWebsiteDomainForMarker,
  SFP_WEBSITE_EXTRACTOR_VERSION,
  SFP_WEBSITE_SOURCE_MARKER_PREFIX,
  SFP_INPUT_FINGERPRINT_SEPARATOR,
  SFP_INPUT_FINGERPRINT_VERSION,
} from "../../../shared/sfp-input-fingerprint";

export interface SfpInputFingerprintFields {
  vertical?: string | null;
  industryPrimary?: string | null;
  industrySecondary?: string | null;
  /** normalized_value_hash of each retained identity-matched listing category. */
  listingCategoryHashes?: string[];
}

export function sfpInputFingerprint(fields: SfpInputFingerprintFields): string {
  const text = [
    SFP_INPUT_FINGERPRINT_VERSION,
    fields.vertical ?? "",
    fields.industryPrimary ?? "",
    fields.industrySecondary ?? "",
    [...(fields.listingCategoryHashes ?? [])].sort().join(","),
  ].join(SFP_INPUT_FINGERPRINT_SEPARATOR);
  return createHash("sha256").update(text, "utf8").digest("hex");
}


/** Same value as sfpWebsiteSourceMarkerSql() computes in SQL for the stored domain. */
export function sfpWebsiteSourceMarker(domain: string | null | undefined): string {
  const normalized = normalizeWebsiteDomainForMarker(domain);
  const tag = normalized === "" ? "none" : createHash("md5").update(normalized, "utf8").digest("hex").slice(0, 12);
  return `${SFP_WEBSITE_SOURCE_MARKER_PREFIX}v${SFP_WEBSITE_EXTRACTOR_VERSION}:${tag}`;
}
