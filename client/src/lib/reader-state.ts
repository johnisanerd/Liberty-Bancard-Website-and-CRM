/**
 * Distinct states for a query-backed reader so a failed read is never rendered as an
 * empty list: loading (no data yet), unavailable (failed, nothing to show), stale
 * (refresh failed but earlier data is still shown) and ready.
 */
export type ReaderState = "loading" | "unavailable" | "stale" | "ready";

export function readerState(q: { isLoading: boolean; isError: boolean; data: unknown }): ReaderState {
  if (q.isError) return q.data === undefined ? "unavailable" : "stale";
  if (q.isLoading) return "loading";
  return "ready";
}
