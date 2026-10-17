import { contactTargetVerticalSql } from "./contact-vertical-taxonomy";
import { relationshipReasonsSql } from "./relationship-evidence-sql";
import { sfpEvidenceCurrentSql } from "./sfp-input-fingerprint";

/** Admission tiers an effective-vertical reader may rely on: the deterministic exact-label tier and
 * the policy-accepted tier (supporting facts retained on the evidence row). */
export const EFFECTIVE_VERTICAL_ADMISSION_TIERS_SQL = "('resolved_high','policy_accepted')";

const alias = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error("VERTICAL_SQL_ALIAS_INVALID");
  return name;
};
function currentVerifiedRelationshipSql(c: string) {
  return `EXISTS (SELECT 1 FROM contact_business_link_decisions vl
    LEFT JOIN contact_business_system_link_evidence vproof ON vproof.id=vl.system_evidence_id
    WHERE vl.contact_id=${c}.id AND vl.business_id=${c}.business_id
      AND vl.decision='verified' AND vl.superseded_at IS NULL
      AND (vproof.id IS NULL OR ${relationshipReasonsSql(`${c}.id`, `${c}.business_id`, "vproof.source_link_id", "vproof.source_entity_id")}
        <@ ARRAY['current_link_decision_exists']::text[]))`;
}
/** Current immutable evidence wins; a conflicting/unresolved latest row cannot
 * silently revive an older target or a legacy label. */
export function effectiveBusinessVerticalSql(name: string): string {
  const b = alias(name);
  return `(CASE WHEN EXISTS (
    SELECT 1 FROM sfp_classification_evidence ev
    JOIN sfp_programs vp ON vp.is_active=TRUE AND vp.taxonomy_version=2
      AND vp.policy_version=ev.policy_version
    WHERE ev.business_id=${b}.id AND ev.taxonomy_version=2 AND ev.classifier_version=3
      AND ev.terminal_state='completed')
    THEN (SELECT CASE WHEN ev.outcome='target' AND ev.admission_tier IN ${EFFECTIVE_VERTICAL_ADMISSION_TIERS_SQL}
        AND ${sfpEvidenceCurrentSql("ev", b)}
      THEN ev.resolved_vertical_id ELSE NULL END
      FROM sfp_classification_evidence ev
      JOIN sfp_programs vp ON vp.is_active=TRUE AND vp.taxonomy_version=2
        AND vp.policy_version=ev.policy_version
      WHERE ev.business_id=${b}.id AND ev.taxonomy_version=2 AND ev.classifier_version=3
        AND ev.terminal_state='completed'
      ORDER BY ev.created_at DESC,ev.id DESC LIMIT 1)
    ELSE ${contactTargetVerticalSql(`${b}.vertical`)} END)`;
}
export function effectiveContactVerticalSql(name: string): string {
  const c = alias(name);
  return `(CASE WHEN ${c}.manual_vertical_override=TRUE
      THEN ${contactTargetVerticalSql(`${c}.vertical`)}
    WHEN ${currentVerifiedRelationshipSql(c)}
      THEN (SELECT ${effectiveBusinessVerticalSql("vb")} FROM businesses vb
        WHERE vb.id=${c}.business_id AND vb.record_class='canonical')
    WHEN EXISTS (SELECT 1 FROM contact_business_link_decisions bad
      WHERE bad.contact_id=${c}.id AND bad.superseded_at IS NULL AND bad.decision='verified') THEN NULL
    ELSE ${contactTargetVerticalSql(`${c}.vertical`)} END)`;
}

export function effectiveBusinessVerticalStatusSql(name: string): string {
  const b = alias(name);
  return `COALESCE((SELECT CASE
    WHEN ev.outcome IN ('non_target','not_target') THEN 'excluded'
    WHEN ev.reason_codes::text ILIKE '%conflict%' THEN 'conflicting'
    WHEN ev.outcome='target' AND ev.admission_tier IN ${EFFECTIVE_VERTICAL_ADMISSION_TIERS_SQL}
      AND ${sfpEvidenceCurrentSql("ev", b)} THEN 'mapped'
    ELSE 'unresolved' END
    FROM sfp_classification_evidence ev JOIN sfp_programs vp
      ON vp.is_active=TRUE AND vp.taxonomy_version=2 AND vp.policy_version=ev.policy_version
    WHERE ev.business_id=${b}.id AND ev.taxonomy_version=2 AND ev.classifier_version=3
      AND ev.terminal_state='completed' ORDER BY ev.created_at DESC,ev.id DESC LIMIT 1),
    CASE WHEN ${contactTargetVerticalSql(`${b}.vertical`)} IS NOT NULL THEN 'mapped'
      WHEN NULLIF(trim(${b}.vertical),'') IS NULL THEN 'missing' ELSE 'unresolved' END)`;
}
export function effectiveContactVerticalStatusSql(name: string): string {
  const c = alias(name);
  return `(CASE WHEN ${c}.manual_vertical_override=TRUE
    THEN CASE WHEN ${contactTargetVerticalSql(`${c}.vertical`)} IS NULL THEN 'unresolved' ELSE 'override' END
    WHEN ${currentVerifiedRelationshipSql(c)}
    THEN COALESCE((SELECT ${effectiveBusinessVerticalStatusSql("vsb")} FROM businesses vsb
      WHERE vsb.id=${c}.business_id AND vsb.record_class='canonical'),'conflicting')
    WHEN EXISTS (SELECT 1 FROM contact_business_link_decisions bad
      WHERE bad.contact_id=${c}.id AND bad.superseded_at IS NULL AND bad.decision='verified') THEN 'conflicting'
    WHEN ${contactTargetVerticalSql(`${c}.vertical`)} IS NOT NULL THEN 'mapped'
    WHEN NULLIF(trim(${c}.vertical),'') IS NULL THEN 'missing' ELSE 'unresolved' END)`;
}