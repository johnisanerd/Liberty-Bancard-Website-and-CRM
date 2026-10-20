import { Link, useLocation, useSearch } from "wouter";
import { useCrmQuery } from "@/hooks/use-crm-query";
import { useCrmInfiniteQuery } from "@/hooks/use-crm-infinite-query";
import type {
  UploadLedgerPage, UploadLedgerRow, UploadLedgerRun, UploadLedgerSummary,
} from "@shared/canonical-upload-ledger";
import { Button } from "@/components/ui/button";

const numberFormat = new Intl.NumberFormat("en-US");
const label = (value: string) => value.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());

/** Reads carry the query's AbortSignal so a superseded selection or actor change cancels the request. */
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json() as Promise<T>;
}
const isDenied = (error: unknown) => error instanceof Error && /^40[13]$/.test(error.message);
const EXECUTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILTERS = ["all", "unfulfilled"] as const;
type LedgerFilter = typeof FILTERS[number];

function ReadFailure({ what, error, onRetry, busy }: { what: string; error: unknown; onRetry: () => void; busy?: boolean }) {
  const denied = isDenied(error);
  return <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 p-3 text-sm text-destructive">
    <span>{denied ? `Your account is not permitted to read ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} could not be loaded. This is not an empty result.`}</span>
    {!denied && <Button variant="outline" size="sm" onClick={onRetry} disabled={busy}>Retry</Button>}
  </div>;
}

const receiptCopy = {
  current: "Current receipt (coordinate, fingerprint and qualification version match)",
  stale: "Stale receipt (older qualification version)",
  inconsistent: "Inconsistent receipt (coordinate or fingerprint disagree with original accounting)",
  none: "No receipt",
} as const;

function Fact({ name, value, note }: { name: string; value: number; note: string }) {
  return <div className="rounded-xl border border-border/70 bg-card p-3">
    <dt className="text-xs text-muted-foreground">{name}</dt>
    <dd className="text-xl font-semibold tabular-nums">{numberFormat.format(value)}</dd>
    <dd className="text-xs text-muted-foreground">{note}</dd>
  </div>;
}

function LedgerRow({ row }: { row: UploadLedgerRow }) {
  const linked = row.mailboxes.filter(mailbox => mailbox.verifiedLink).length;
  return <details className="rounded-xl border border-border/70 bg-card p-4" data-testid={`ledger-row-${row.sourceRowNumber}`}>
    <summary className="cursor-pointer text-sm font-medium">
      Row {row.sourceRowNumber} · {label(row.disposition)} ·{" "}
      {row.businessOnly ? "Business only" : `${linked}/${row.mailboxes.length} mailboxes verified`} ·{" "}
      {label(row.receipt.status)} receipt
    </summary>
    <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
      <div><dt className="text-muted-foreground">Business name in original row</dt><dd className="break-words">{row.companyName ?? "Not available"}</dd></div>
      <div><dt className="text-muted-foreground">Original reason</dt><dd className="break-words">{row.reasonCode}</dd></div>
      <div><dt className="text-muted-foreground">Retained original</dt><dd>{row.originalFormat ?? "Unavailable"}</dd></div>
      <div><dt className="text-muted-foreground">Fulfillment item</dt><dd>{row.fulfillmentState ? label(row.fulfillmentState) : "Not recorded"}</dd></div>
      <div className="sm:col-span-2"><dt className="text-muted-foreground">Receipt</dt>
        <dd>{receiptCopy[row.receipt.status]}{row.receipt.qualificationVersion ? ` · ${row.receipt.qualificationVersion}` : ""}</dd></div>
      <div className="sm:col-span-2"><dt className="text-muted-foreground">Mailboxes</dt>
        <dd>{row.businessOnly ? <span>No mailbox on this row. The business is materialized without a placeholder contact.</span> :
          <ul className="mt-1 space-y-1">
            {row.mailboxes.map(mailbox => <li key={mailbox.email} className="break-all">
              {mailbox.contactId ? <Link href={`/dashboard/contacts/${mailbox.contactId}`} className="text-primary underline">{mailbox.email}</Link> : mailbox.email}
              {" · "}{!mailbox.hasProvenance ? "no provenance for this row"
                : mailbox.verifiedLink ? `verified link to business #${mailbox.businessId}`
                : mailbox.businessId ? `business #${mailbox.businessId} without a current verified decision` : "no business link yet"}
            </li>)}
          </ul>}
          {row.unexpectedContactIds.length > 0 && <p className="mt-1 text-xs text-muted-foreground">
            Other contacts carry provenance for this row: {row.unexpectedContactIds.join(", ")}.</p>}
        </dd></div>
    </dl>
  </details>;
}

function Summary({ executionId }: { executionId: string }) {
  const { data, isError, error, isLoading, refetch, isFetching } = useCrmQuery<UploadLedgerSummary>({
    queryKey: ["/api/canonical-enrichment/uploads", executionId, "summary"],
    queryFn: ({ signal }) => getJson(`/api/canonical-enrichment/uploads/${executionId}/summary`, signal),
    staleTime: 60_000, refetchOnWindowFocus: false,
  });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading upload totals…</p>;
  if (isError || !data) return <ReadFailure what="upload totals" error={error} onRetry={() => void refetch()} busy={isFetching} />;
  return <div className="space-y-2">
    <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Fact name="Original rows" value={data.rows} note="Immutable accounting; not contacts" />
      <Fact name="Distinct contacts" value={data.distinctContacts} note="With provenance in this upload" />
      <Fact name="Verified links" value={data.verifiedLinks} note="Contacts with a current verified decision" />
      <Fact name="Current receipts" value={data.receiptsCurrent} note={`Version ${data.qualificationVersion}`} />
      <Fact name="Stale or inconsistent" value={data.receiptsStale + data.receiptsInconsistent}
        note={`${numberFormat.format(data.receiptsStale)} stale · ${numberFormat.format(data.receiptsInconsistent)} inconsistent`} />
    </dl>
    <p className="text-xs text-muted-foreground">
      These are separate measures taken now and are not added together. Row accounting by original disposition:{" "}
      {Object.entries(data.byDisposition).map(([name, count]) => `${label(name)} ${numberFormat.format(count)}`).join(" · ") || "none"}.
    </p>
  </div>;
}

export function UploadLedger({ initialFilter = "all" }: { initialFilter?: LedgerFilter }) {
  // Selection lives in the URL (typed, validated) so reload and Back restore it; other parameters are preserved.
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const urlExecution = params.getAll("ledgerExecution");
  const urlFilter = params.getAll("ledgerFilter");
  const executionParam = urlExecution.length === 1 && EXECUTION_ID.test(urlExecution[0]) ? urlExecution[0].toLowerCase() : null;
  const filter: LedgerFilter = urlFilter.length === 1 && (FILTERS as readonly string[]).includes(urlFilter[0]) ? urlFilter[0] as LedgerFilter : initialFilter;
  const selectionIssue = (urlExecution.length > 1 || (urlExecution.length === 1 && !executionParam)
    || urlFilter.length > 1 || (urlFilter.length === 1 && !(FILTERS as readonly string[]).includes(urlFilter[0])))
    ? "The upload or filter in the address was not valid; showing the default selection." : null;
  const write = (next: { execution?: string; filter?: LedgerFilter }) => {
    const out = new URLSearchParams(search);
    out.delete("ledgerExecution"); out.delete("ledgerFilter");
    out.set("ledgerExecution", next.execution ?? selected ?? "");
    out.set("ledgerFilter", next.filter ?? filter);
    if (!out.get("ledgerExecution")) out.delete("ledgerExecution");
    navigate(`${location}?${out.toString()}${window.location.hash}`);
  };
  const uploads = useCrmQuery<{ uploads: UploadLedgerRun[] }>({
    queryKey: ["/api/canonical-enrichment/uploads"],
    queryFn: ({ signal }) => getJson("/api/canonical-enrichment/uploads", signal),
    staleTime: 60_000, refetchOnWindowFocus: false,
  });
  const known = uploads.data?.uploads ?? [];
  const requestedMissing = !!executionParam && !!uploads.data && !known.some(u => u.executionId.toLowerCase() === executionParam);
  const selected: string | null = executionParam && !requestedMissing ? executionParam : known[0]?.executionId ?? null;
  const rows = useCrmInfiniteQuery<UploadLedgerPage, Error, any, any, number>({
    queryKey: ["/api/canonical-enrichment/uploads", selected, "rows", filter],
    enabled: !!selected,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => getJson(
      `/api/canonical-enrichment/uploads/${selected}/rows?limit=25&after=${pageParam}&filter=${filter}`, signal),
    getNextPageParam: last => last.nextAfter,
    staleTime: 60_000, refetchOnWindowFocus: false,
  });
  const list: UploadLedgerRow[] = rows.data?.pages.flatMap((page: UploadLedgerPage) => page.rows) ?? [];
  return <section className="my-5 space-y-4" aria-labelledby="upload-ledger-title">
    <div>
      <h3 id="upload-ledger-title" className="font-semibold">Upload ledger by original row</h3>
      <p className="text-sm text-muted-foreground">
        Every original row of the selected upload, in coordinate order, including business-only rows and every mailbox.
        Original accounting, provenance, current links and fulfillment receipts are separate facts. This is intake accounting only:
        a listed row is not enrichment, a deal or a delivered email, and one page of one upload does not show that all uploads are complete.
      </p>
    </div>
    {(selectionIssue || requestedMissing) && <p role="status" className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="ledger-selection-issue">
      {requestedMissing ? "The upload in the address is not in the ledger list; showing the most recent upload." : selectionIssue}</p>}
    {uploads.isLoading && <p className="text-sm text-muted-foreground">Loading uploads…</p>}
    {uploads.isError && <ReadFailure what="the upload list" error={uploads.error} onRetry={() => void uploads.refetch()} busy={uploads.isFetching} />}
    {uploads.data && !uploads.data.uploads.length && <p className="rounded-xl border p-4 text-sm text-muted-foreground">No uploads have original-row accounting yet.</p>}
    {uploads.data && uploads.data.uploads.length > 0 && <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">
        <span className="mb-1 block text-muted-foreground">Upload</span>
        <select className="min-h-11 rounded-md border bg-background px-2 py-1.5 text-sm" value={selected ?? ""}
          onChange={event => write({ execution: event.target.value })} data-testid="ledger-upload-select">
          {uploads.data.uploads.map(upload => <option key={upload.executionId} value={upload.executionId}>
            {(upload.fileName ?? label(upload.importType))} · {upload.startedAt ? new Date(upload.startedAt).toLocaleDateString("en-US") : "undated"} · {numberFormat.format(upload.accountedRows)} rows
          </option>)}
        </select>
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-muted-foreground">Show</span>
        <select className="min-h-11 rounded-md border bg-background px-2 py-1.5 text-sm" value={filter}
          onChange={event => write({ filter: event.target.value as LedgerFilter })}>
          <option value="all">All original rows</option>
          <option value="unfulfilled">Rows without a fulfilled item</option>
        </select>
      </label>
    </div>}
    {selected && <Summary executionId={selected} />}
    {rows.isError && <ReadFailure what="this page of rows" error={rows.error} onRetry={() => void rows.refetch()} busy={rows.isFetching} />}
    {rows.isLoading && !!selected && <p className="text-sm text-muted-foreground">Loading rows…</p>}
    <div className="space-y-3">{list.map(row => <LedgerRow key={row.sourceRowNumber} row={row} />)}</div>
    {selected && rows.isSuccess && !list.length && <p className="rounded-xl border p-4 text-sm text-muted-foreground">No rows match this view.</p>}
    {rows.hasNextPage && <Button variant="outline" onClick={() => rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
      {rows.isFetchingNextPage ? "Loading…" : "Load next 25 rows"}
    </Button>}
    {list.length > 0 && <p className="text-xs text-muted-foreground">
      Showing {numberFormat.format(list.length)} rows{rows.hasNextPage ? "; more remain" : "; end of upload"}.</p>}
  </section>;
}
