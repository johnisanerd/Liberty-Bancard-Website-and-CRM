import {createHash} from "node:crypto";

/** Safe to import in a DB-less maintenance client. No provider or DB imports. */
export function contactLifecycleIdentityFingerprint(row: Record<string,unknown>): string {
  return createHash("sha256").update(JSON.stringify([
    row.email,row.firstName,row.lastName,row.companyName,row.phone,row.address,
    row.city,row.state,row.ghlContactId,row.businessId,row.archivedAt,
  ])).digest("hex");
}
