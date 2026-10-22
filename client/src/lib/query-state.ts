/**
 * Distinguishes why an authorized read has no data. The shared query function throws `Error("<status>: <body>")` on a
 * non-OK response, so the status is the reliable signal. A failed read is never presented as an empty or zero result.
 */
export type ReadFailureKind = "denied" | "unavailable";
export function readFailureKind(error: unknown): ReadFailureKind {
  const status = Number(/^(\d{3})\b/.exec(String((error as { message?: string } | null)?.message ?? ""))?.[1]);
  return status === 401 || status === 403 ? "denied" : "unavailable";
}
/** Metric strip availability derived from the read itself: unknown with no data, stale when a refresh failed but data remains. */
export function metricAvailability(read: { isError: boolean; data: unknown }): "available" | "unknown" | "stale" {
  if (!read.isError) return "available";
  return read.data === undefined ? "unknown" : "stale";
}
