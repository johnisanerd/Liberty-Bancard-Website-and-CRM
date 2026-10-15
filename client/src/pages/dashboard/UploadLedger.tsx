import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import type {
  UploadLedgerPage, UploadLedgerRow, UploadLedgerRun, UploadLedgerSummary,
} from "@shared/canonical-upload-ledger";
import { Button } from "@/components/ui/button";

const numberFormat = new Intl.NumberFormat("en-US");
const label = (value: string) => value.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json() as Promise<T>;
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
  const { data, isError, isLoading } = useQuery<UploadLedgerSummary>({
    queryKey: ["/api/canonical-enrichment/uploads", executionId, "summary"],
    queryFn: () => getJson(`/api/canonical-enrichment/uploads/${executionId}/summary`),
  });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading upload totals…</p>;
  if (isError || !data) return <p className="text-sm text-destructive">Upload totals are unavailable. Nothing was calculated.</p>;
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

export function UploadLedger({ initialFilter = "all" }: { initialFilter?: "all" | "unfulfilled" }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState(initialFilter);
  const uploads = useQuery<{ uploads: UploadLedgerRun[] }>({
    queryKey: ["/api/canonical-enrichment/uploads"],
    queryFn: () => getJson("/api/canonical-enrichment/uploads"),
  });
  useEffect(() => {
    if (!selected && uploads.data?.uploads.length) setSelected(uploads.data.uploads[0].executionId);
  }, [selected, uploads.data]);
  const rows = useInfiniteQuery<UploadLedgerPage>({
    queryKey: ["/api/canonical-enrichment/uploads", selected, "rows", filter],
    enabled: !!selected,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getJson(
      `/api/canonical-enrichment/uploads/${selected}/rows?limit=25&after=${pageParam}&filter=${filter}`),
    getNextPageParam: last => last.nextAfter,
  });
  const list = rows.data?.pages.flatMap(page => page.rows) ?? [];
  return <section className="my-5 space-y-4" aria-labelledby="upload-ledger-title">
    <div>
      <h3 id="upload-ledger-title" className="font-semibold">Upload ledger by original row</h3>
      <p className="text-sm text-muted-foreground">
        Every original row of the selected upload, in coordinate order, including business-only rows and every mailbox.
        Original accounting, provenance, current links and fulfillment receipts are separate facts.
      </p>
    </div>
    {uploads.isError && <p className="text-sm text-destructive">The upload list is unavailable.</p>}
    {uploads.data && !uploads.data.uploads.length && <p className="rounded-xl border p-4 text-sm text-muted-foreground">No uploads have original-row accounting yet.</p>}
    {uploads.data && uploads.data.uploads.length > 0 && <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">
        <span className="mb-1 block text-muted-foreground">Upload</span>
        <select className="rounded-md border bg-background px-2 py-1.5 text-sm" value={selected ?? ""}
          onChange={event => setSelected(event.target.value)} data-testid="ledger-upload-select">
          {uploads.data.uploads.map(upload => <option key={upload.executionId} value={upload.executionId}>
            {(upload.fileName ?? label(upload.importType))} · {upload.startedAt ? new Date(upload.startedAt).toLocaleDateString("en-US") : "undated"} · {numberFormat.format(upload.accountedRows)} rows
          </option>)}
        </select>
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-muted-foreground">Show</span>
        <select className="rounded-md border bg-background px-2 py-1.5 text-sm" value={filter}
          onChange={event => setFilter(event.target.value as "all" | "unfulfilled")}>
          <option value="all">All original rows</option>
          <option value="unfulfilled">Rows without a fulfilled item</option>
        </select>
      </label>
    </div>}
    {selected && <Summary executionId={selected} />}
    {rows.isError && <p className="text-sm text-destructive">This page of rows is unavailable.</p>}
    <div className="space-y-3">{list.map(row => <LedgerRow key={row.sourceRowNumber} row={row} />)}</div>
    {selected && rows.isSuccess && !list.length && <p className="rounded-xl border p-4 text-sm text-muted-foreground">No rows match this view.</p>}
    {rows.hasNextPage && <Button variant="outline" onClick={() => rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
      {rows.isFetchingNextPage ? "Loading…" : "Load next 25 rows"}
    </Button>}
    {list.length > 0 && <p className="text-xs text-muted-foreground">
      Showing {numberFormat.format(list.length)} rows{rows.hasNextPage ? "; more remain" : "; end of upload"}.</p>}
  </section>;
}
