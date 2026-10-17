import { createHash } from "node:crypto";
import {
  SFP_INPUT_FINGERPRINT_SEPARATOR,
  SFP_INPUT_FINGERPRINT_VERSION,
} from "../../../shared/sfp-input-fingerprint";

export interface SfpInputFingerprintFields {
  vertical?: string | null;
  industryPrimary?: string | null;
  industrySecondary?: string | null;
}

export function sfpInputFingerprint(fields: SfpInputFingerprintFields): string {
  const text = [
    SFP_INPUT_FINGERPRINT_VERSION,
    fields.vertical ?? "",
    fields.industryPrimary ?? "",
    fields.industrySecondary ?? "",
  ].join(SFP_INPUT_FINGERPRINT_SEPARATOR);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

