import { useCallback, useEffect, useRef, useState } from "react";

export interface CompanySearchItem { id: number; legalName: string; dba: string | null }
interface CompanySearchPage { items: CompanySearchItem[]; total: number; limit: number; nextCursor: string | null }
export type CompanySearchStatus = "idle" | "loading" | "ready" | "error";

export interface CompanySearchState {
  items: CompanySearchItem[];
  total: number | null;
  status: CompanySearchStatus;
  loadingMore: boolean;
  moreError: boolean;
  hasMore: boolean;
  /** Query the visible results answer (lags the input while the debounce and request run). */
  settledQuery: string;
  loadMore: () => void;
  retry: () => void;
}

const DEBOUNCE_MS = 250;
const PAGE_SIZE = 25;

/** Bounded, authorized company search. Every change of query, contact or open state aborts the in-flight read and
 * discards its result, so a slow earlier response can never overwrite a newer one. Nothing is fetched while closed. */
export function useCompanySearch(opts: { enabled: boolean; query: string; contactId: number }): CompanySearchState {
  const { enabled, query, contactId } = opts;
  const [items, setItems] = useState<CompanySearchItem[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState<CompanySearchStatus>("idle");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [settledQuery, setSettledQuery] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const generation = useRef(0);
  const moreController = useRef<AbortController | null>(null);

  const url = useCallback((q: string, after: string | null) => {
    const p = new URLSearchParams({ limit: String(PAGE_SIZE), excludeContactId: String(contactId) });
    if (q.trim()) p.set("q", q.trim());
    if (after) p.set("cursor", after);
    return `/api/companies/search?${p.toString()}`;
  }, [contactId]);

  useEffect(() => {
    generation.current += 1;
    moreController.current?.abort();
    setLoadingMore(false);
    setMoreError(false);
    if (!enabled) {
      setItems([]); setTotal(null); setCursor(null); setStatus("idle"); setSettledQuery("");
      return;
    }
    const mine = generation.current;
    const controller = new AbortController();
    setStatus("loading");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(url(query, null), { credentials: "include", signal: controller.signal });
        if (!res.ok) throw new Error(`company search ${res.status}`);
        const page = (await res.json()) as CompanySearchPage;
        if (generation.current !== mine) return;
        setItems(page.items); setTotal(page.total); setCursor(page.nextCursor); setSettledQuery(query.trim()); setStatus("ready");
      } catch (error) {
        if (controller.signal.aborted || generation.current !== mine) return;
        setItems([]); setTotal(null); setCursor(null); setStatus("error");
      }
    }, query.trim() ? DEBOUNCE_MS : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, query, url, retryNonce]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore || status !== "ready") return;
    const mine = generation.current;
    const controller = new AbortController();
    moreController.current = controller;
    setLoadingMore(true); setMoreError(false);
    void (async () => {
      try {
        const res = await fetch(url(settledQuery, cursor), { credentials: "include", signal: controller.signal });
        if (!res.ok) throw new Error(`company search ${res.status}`);
        const page = (await res.json()) as CompanySearchPage;
        if (generation.current !== mine) return;
        setItems(prev => {
          const seen = new Set(prev.map(c => c.id));
          return [...prev, ...page.items.filter(c => !seen.has(c.id))];
        });
        setTotal(page.total); setCursor(page.nextCursor); setLoadingMore(false);
      } catch {
        if (controller.signal.aborted || generation.current !== mine) return;
        setLoadingMore(false); setMoreError(true);
      }
    })();
  }, [cursor, loadingMore, status, url, settledQuery]);

  const retry = useCallback(() => setRetryNonce(n => n + 1), []);
  return { items, total, status, loadingMore, moreError, hasMore: cursor !== null, settledQuery, loadMore, retry };
}
