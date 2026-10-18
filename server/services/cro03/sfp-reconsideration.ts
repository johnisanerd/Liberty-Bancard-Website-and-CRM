/**
 * When does an existing classification stop standing, so the business is reconsidered?
 *
 * One definition shared by the classification bridge's selection and the free continuation's
 * discovery sweep, so the two cannot disagree about which businesses are due.
 *
 * A completed evidence row no longer stands when:
 *  - it predates input fingerprints, is a taxonomy-v2 target, and carries no admission tier (an
 *    unsupported target from before the acceptance policy existed);
 *  - its input fingerprint no longer matches the business as stored (category fields or retained
 *    identity-matched listing category evidence changed), or its website decision's domain changed;
 *  - a later completed row superseded it;
 *  - it was decided under an older acceptance policy version.
 * Website content changing on the same domain cannot be seen without reading the site, so website
 * decisions are re-read on a schedule (SFP_WEBSITE_RECHECK_DAYS).
 */
import { sfpEvidenceCurrentSql } from "../../../shared/sfp-input-fingerprint";
import { SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION } from "./sfp-vertical-acceptance";

export const SFP_WEBSITE_RECHECK_DAYS = 30;

export interface SfpReconsiderationVersions {
  policyVersion: number;
  classifierVersion: number;
  taxonomyVersion: 1 | 2;
}

function int(value: number): number {
  if (!Number.isInteger(value)) throw new Error("SFP_RECONSIDERATION_VERSION_INVALID");
  return value;
}

/** SQL fragment (for sql.raw): TRUE when completed evidence row `e` no longer stands for business `b`. */
export function sfpReconsiderationDueSql(e: string, b: string, v: SfpReconsiderationVersions): string {
  const legacyUntiered = v.taxonomyVersion === 2
    ? `(${e}.input_fingerprint IS NULL AND ${e}.outcome='target' AND ${e}.admission_tier IS NULL)`
    : "FALSE";
  const policyStale = v.taxonomyVersion === 2
    ? `OR ${e}.acceptance_policy_version IS DISTINCT FROM ${SFP_VERTICAL_ACCEPTANCE_POLICY_VERSION}`
    : "";
  return `(${legacyUntiered} OR (${e}.input_fingerprint IS NOT NULL AND (
      NOT ${sfpEvidenceCurrentSql(e, b)}
      OR ${e}.id <> (SELECT l.id FROM sfp_classification_evidence l
                      WHERE l.business_id=${b}.id AND l.policy_version=${int(v.policyVersion)}
                        AND l.classifier_version=${int(v.classifierVersion)} AND l.taxonomy_version=${int(v.taxonomyVersion)}
                        AND l.terminal_state='completed'
                      ORDER BY l.created_at DESC,l.id DESC LIMIT 1)
      ${policyStale})))`;
}

/** TRUE when a business is selectable for classification: no completed row for it still stands. */
export function sfpSettledEvidenceSql(e: string, b: string, v: SfpReconsiderationVersions): string {
  return `${e}.outcome IN ('target','non_target') AND NOT ${sfpReconsiderationDueSql(e, b, v)}`;
}
