import { sql } from "drizzle-orm";

// The inverse transform verifies the ENTIRE approved upstream trigger body,
// not a substring or a newly recorded live hash. Only this exact address-scope
// change is permitted. Affiliation and all other native safeguards stay intact.
export const ORIGINAL_ADDRESS_RECEIPT_CLAUSE =
  "AND po.subject_type='business' AND po.subject_id=NEW.business_id";
export const CANONICAL_ADDRESS_RECEIPT_CLAUSE =
  "AND po.subject_type IN ('business','contact') /* canonical_address_receipt_v1 */";

export function canonicalAddressReceiptNativeFingerprint(prosrc: any) {
  return sql`(
    strpos(${prosrc},${CANONICAL_ADDRESS_RECEIPT_CLAUSE})>0
    AND strpos(${prosrc},${ORIGINAL_ADDRESS_RECEIPT_CLAUSE})=0
    AND md5(replace(${prosrc},${CANONICAL_ADDRESS_RECEIPT_CLAUSE},
      ${ORIGINAL_ADDRESS_RECEIPT_CLAUSE}))='fb3f7591d89f5a6445d9878cab4720e8'
  )`;
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