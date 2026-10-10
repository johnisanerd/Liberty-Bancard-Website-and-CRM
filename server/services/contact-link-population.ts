import {db,pool} from "../db";
import {assertSystemLinkDatabaseGuard} from "./commercial-link-authority";

/** Current audited population, separate from cumulative worker attempts.
 * Unavailable authority/query results are never represented as zero.
 */
export async function readContactLinkAssignmentPopulation() {
  let nativeContractVerified=false;
  try {
    await assertSystemLinkDatabaseGuard(db);
    nativeContractVerified=true;
    const result=await pool.query(`WITH population AS (
      SELECT c.id,c.business_id,d.business_id audited_business_id,d.decision,b.record_class business_class
      FROM contacts c LEFT JOIN contact_business_link_decisions d
        ON d.contact_id=c.id AND d.superseded_at IS NULL
      LEFT JOIN businesses b ON b.id=d.business_id
      WHERE c.archived_at IS NULL AND c.record_class IS NOT NULL
        AND c.record_class NOT IN ('test','demo','synthetic')
    ) SELECT count(*)::int total,
      count(*) FILTER(WHERE decision='verified' AND business_id=audited_business_id AND business_class='canonical')::int verified,
      count(*) FILTER(WHERE business_id IS NOT NULL AND
        NOT coalesce(decision='verified' AND business_id=audited_business_id AND business_class='canonical',FALSE))::int legacy_projection
      FROM population`);
    const row=result.rows[0];
    return {state:"current" as const,observedAt:new Date().toISOString(),nativeContractVerified:true,
      totalActiveProduction:Number(row.total),currentVerified:Number(row.verified),
      currentUnresolved:Number(row.total)-Number(row.verified),
      legacyProjectedWithoutCurrentVerifiedAssignment:Number(row.legacy_projection),reasonCode:null};
  } catch(error:any) {
    const blocked=String(error?.message ?? "").includes("COMMERCIAL_SYSTEM_LINK_DATABASE_GUARD_MISSING");
    return {state:"unavailable" as const,observedAt:new Date().toISOString(),nativeContractVerified,
      totalActiveProduction:null,currentVerified:null,currentUnresolved:null,
      legacyProjectedWithoutCurrentVerifiedAssignment:null,
      reasonCode:blocked ? "NATIVE_RELATIONSHIP_CONTRACT_UNAVAILABLE" : "CONTACT_LINK_POPULATION_READ_FAILED"};
  }
}
