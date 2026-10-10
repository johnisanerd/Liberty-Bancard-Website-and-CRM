/** Identity normalization only: callers retain original source values. */
export function normalizeStateIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "FLORIDA" ? "FL" : normalized || null;
}

/** Read/native boundaries use the same deliberately narrow alias set. */
export function stateIdentitySql(expression: string): string {
  return `CASE WHEN upper(btrim(coalesce(${expression},'')))='FLORIDA' THEN 'FL' ELSE upper(btrim(coalesce(${expression},''))) END`;
}
