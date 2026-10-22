import { sql, type SQL } from "drizzle-orm";
import { STORED_AMOUNT_PATTERN } from "@shared/amount-contract";

/** SQL predicate: the column holds a valid stored amount (same definition as parseStoredAmount). */
export function storedAmountIsValidSql(column: SQL): SQL {
  return sql`btrim(${column}) ~ ${STORED_AMOUNT_PATTERN}`;
}
/** SQL numeric value of a valid stored amount, NULL for blank or invalid. The cast only runs on strings the pattern accepted. */
export function storedAmountNumericSql(column: SQL): SQL {
  return sql`(CASE WHEN btrim(${column}) ~ ${STORED_AMOUNT_PATTERN} THEN regexp_replace(btrim(${column}), '[$,]', '', 'g')::numeric ELSE NULL END)`;
}

/** Same expression as a raw SQL string for readers that use pool.query text. The pattern contains no quote or backslash. */
export function storedAmountNumericRawSql(column: string): string {
  return `(CASE WHEN btrim(${column}) ~ '${STORED_AMOUNT_PATTERN}' THEN regexp_replace(btrim(${column}), '[$,]', '', 'g')::numeric ELSE NULL END)`;
}
