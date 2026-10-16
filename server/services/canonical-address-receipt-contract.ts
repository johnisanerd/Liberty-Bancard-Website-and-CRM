import { sql } from "drizzle-orm";

// The inverse transform verifies the ENTIRE approved upstream trigger body,
// not a substring or a newly recorded live hash. Only this exact address-scope
// change is permitted. Affiliation and all other native safeguards stay intact.
export const ORIGINAL_ADDRESS_RECEIPT_CLAUSE =
  "AND po.subject_type='business' AND po.subject_id=NEW.business_id";
export const CANONICAL_ADDRESS_RECEIPT_CLAUSE =
  "AND po.subject_type IN ('business','contact') /* canonical_address_receipt_v1 */";

// Inverse-transform hashes of the two approved routine bodies. The PRE-first-party body is what the
// managed production database holds today (migrations 0314+0330+0349); Publish cannot replace PL/pgSQL
// bodies, so the owner-console install moves production to the CURRENT body. Until then every existing
// link writer keeps working on the legacy body, while the first-party writer requires the current one.
export const PRE_FIRST_PARTY_ROUTINE_INVERSE_MD5 = "db87fee060dbdf3fa4b8c1f07070e5c7";
export const CURRENT_ROUTINE_INVERSE_MD5 = "36151ce032505a66054e6b8c70daa259";

function inverseMd5Matches(prosrc: any, hash: string) {
  return sql`(
    strpos(${prosrc},${CANONICAL_ADDRESS_RECEIPT_CLAUSE})>0
    AND strpos(${prosrc},${ORIGINAL_ADDRESS_RECEIPT_CLAUSE})=0
    AND md5(replace(${prosrc},${CANONICAL_ADDRESS_RECEIPT_CLAUSE},
      ${ORIGINAL_ADDRESS_RECEIPT_CLAUSE}))=${hash}
  )`;
}

/** Any approved reviewed-link routine body (legacy production body or current body). */
export function canonicalAddressReceiptNativeFingerprint(prosrc: any) {
  return sql`(${inverseMd5Matches(prosrc, PRE_FIRST_PARTY_ROUTINE_INVERSE_MD5)}
    OR ${inverseMd5Matches(prosrc, CURRENT_ROUTINE_INVERSE_MD5)})`;
}

/** Only the current body, which contains the first-party staged-email branch. */
export function currentReviewedLinkRoutineFingerprint(prosrc: any) {
  return inverseMd5Matches(prosrc, CURRENT_ROUTINE_INVERSE_MD5);
}

export async function assertCanonicalAddressReceiptContract(
  executor: { execute(query: any): Promise<any> },
) {
  const result = await executor.execute(sql`
    SELECT ${canonicalAddressReceiptNativeFingerprint(sql`p.prosrc`)} AS installed
      FROM pg_proc p
     WHERE p.oid=to_regprocedure('public.enforce_reviewed_contact_business_link()')
  `);
  if ((result?.rows ?? result)?.[0]?.installed !== true) {
    throw new Error("CANONICAL_ADDRESS_NATIVE_CONTRACT_REQUIRED");
  }
}