// One definition of a stored money/volume string. Deal amounts are stored as free text, so every reader that sums
// them must agree on which strings count. The pattern uses only character classes (no backslash escapes), so it
// means the same thing in JavaScript, in a cooked template string, and in PostgreSQL.
//
// Accepted (after trimming): optional "$", optional "-", digits with either no thousands separator or correct
// groups of three ("1,000", "12,345,678.90"), and an optional decimal part ("1250.5", ".5" is NOT accepted).
// Not accepted: "1x25", "1.2.3", "1,00", "abc", "12 000", "1e5". Blank values are "blank", not zero.
export const STORED_AMOUNT_PATTERN = "^[$]?-?([0-9]{1,3}(,[0-9]{3})+|[0-9]+)([.][0-9]+)?$";
const STORED_AMOUNT_REGEX = new RegExp(STORED_AMOUNT_PATTERN);

export type StoredAmount =
  | { state: "valid"; value: number }
  | { state: "blank" }
  | { state: "invalid" };

export function parseStoredAmount(raw: string | null | undefined): StoredAmount {
  const text = String(raw ?? "").trim();
  if (!text) return { state: "blank" };
  if (!STORED_AMOUNT_REGEX.test(text)) return { state: "invalid" };
  const value = Number(text.replace(/[$,]/g, ""));
  return Number.isFinite(value) ? { state: "valid", value } : { state: "invalid" };
}

/** Availability of a sum over stored amounts: never a certified zero when amounts are unknown. */
export type AmountAvailability = "complete" | "partial" | "unavailable";
export function amountAvailability(rows: number, unknownRows: number): AmountAvailability {
  if (unknownRows <= 0) return "complete";
  return unknownRows >= rows ? "unavailable" : "partial";
}
