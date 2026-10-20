import { useState } from "react";
import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CrmDataState } from "@/components/crm/CrmPresentation";

interface DeadLetterEvent {
  id: number;
  status: string;
  event: {
    queueName: string | null;
    jobName: string | null;
    failureCode: string;
    attempts: number | null;
    maxAttempts: number | null;
    occurredAt: string | null;
  };
  created_at: string | null;
}
interface DeadLetterPage { events: DeadLetterEvent[]; next_cursor: string | null }

const PAGE_SIZE = 25;
const URL_BASE = "/api/review-queue/dead-letter-events";

function isPage(value: unknown): value is DeadLetterPage {
  const page = value as DeadLetterPage | null;
  return !!page && Array.isArray(page.events) && (page.next_cursor === null || typeof page.next_cursor === "string");
}

/** Background-job failure alerts, read newest first through the paged history route. */
export function DeadLetterHistory({ counts }: { counts?: { pending: number; archived: number; total: number } }) {
  const [more, setMore] = useState<DeadLetterEvent[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);

  const first = useQuery<DeadLetterPage>({
    queryKey: [URL_BASE, "first-page"],
    queryFn: async ({ signal }) => {
      const res = await fetch(`${URL_BASE}?limit=${PAGE_SIZE}`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Queue failure history unavailable");
      const body = await res.json();
      if (!isPage(body)) throw new Error("Queue failure history shape unavailable");
      return body;
    },
  });

  const nextCursor = cursor === undefined ? first.data?.next_cursor ?? null : cursor;
  const events = [...(first.data?.events ?? []), ...more];

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const res = await fetch(`${URL_BASE}?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`, { credentials: "include" });
      const body = res.ok ? await res.json() : null;
      if (!isPage(body)) throw new Error("unavailable");
      setMore(previous => [...previous, ...body.events]);
      setCursor(body.next_cursor);
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Card data-testid="card-dead-letter-history">
      <CardHeader>
        <CardTitle className="text-base">Queue failure alerts</CardTitle>
        <p className="text-sm text-muted-foreground" data-testid="text-dead-letter-counts">
          Background jobs that failed repeatedly. Kept as history and not part of the review list above.
          {counts ? ` ${counts.pending} pending, ${counts.archived} archived, ${counts.total} total.` : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {first.isError ? (
          <CrmDataState state="unavailable" message="Queue failure history unavailable." onRetry={() => void first.refetch()} />
        ) : first.isLoading ? (
          <CrmDataState state="loading" message="Loading queue failure history." />
        ) : events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No queue failure alerts.</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Queue</TableHead>
                  <TableHead>Job</TableHead>
                  <TableHead>Failure</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Recorded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map(row => (
                  <TableRow key={row.id} data-testid={`row-dead-letter-${row.id}`}>
                    <TableCell className="text-sm">{row.event.queueName ?? "—"}</TableCell>
                    <TableCell className="text-sm">{row.event.jobName ?? "—"}</TableCell>
                    <TableCell className="text-sm">{row.event.failureCode}</TableCell>
                    <TableCell className="text-sm">
                      {row.event.attempts ?? "—"}{row.event.maxAttempts != null ? ` / ${row.event.maxAttempts}` : ""}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.status === "pending" ? "default" : "secondary"} className="text-xs capitalize">{row.status}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.created_at ? new Date(row.created_at).toLocaleString() : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {moreError && <CrmDataState state="unavailable" message="Could not load more alerts." onRetry={() => void loadMore()} />}
            {nextCursor && (
              <Button variant="outline" onClick={() => void loadMore()} disabled={loadingMore} data-testid="button-dead-letter-more">
                {loadingMore ? "Loading" : `Load ${PAGE_SIZE} more`}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
