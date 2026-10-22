import { PageTitle } from "@/components/ui/page-header";
import { useState, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, getCsrfToken, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Rocket, SkipForward, RefreshCw, Users, Phone, Mail, Loader2,
  ChevronLeft, ChevronRight, MapPin, Building2, CheckCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Link } from "wouter";

// ─── Types ────────────────────────────────────────────────────────────────────
interface QueueContact {
  id: number;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  vertical: string | null;
  city: string | null;
  state: string | null;
  leadScore: number | null;
  scoreTier: "hot" | "warm" | "cold" | "unqualified";
  assignedTo: string | null;
  createdAt: string;
  lastScoredAt: string | null;
  emailStatus: string | null;
  primaryOfferPath: string | null;
  dataReadinessScore: number | null;
  decision: {
    qualified: boolean;
    channel: "email" | "manual_call" | "sms";
    sequenceId: number | null;
    policyVersion: number;
    expiresAt: string;
    reasonCodes: string[];
  };
}

interface QueuePage {
  data: QueueContact[];
  total: number | null;
  exactTotal: boolean;
  cursor: number;
  nextCursor: number | null;
  hasMore: boolean;
  limit: number;
  channel: "email" | "manual_call" | "sms";
  policyVersion: number;
  asOf: string;
  reasonBuckets: Record<string, number>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function ScoreBadge({ tier, score }: { tier: string; score: number | null }) {
  const cls =
    tier === "hot"  ? "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300" :
    tier === "warm" ? "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300" :
    tier === "cold" ? "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300" :
                      "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800 dark:text-gray-300";
  return (
    <Badge variant="outline" className={`capitalize text-[11px] ${cls}`}>
      {tier}{score != null ? ` (${score})` : ""}
    </Badge>
  );
}

function contactName(c: QueueContact) {
  const full = [c.firstName, c.lastName].filter(Boolean).join(" ");
  return full || c.companyName || `Contact #${c.id}`;
}

function formatDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

const VERTICALS = [
  "Restaurant", "Retail", "Automotive", "Salon / Spa", "Med Spa", "Medical",
  "Dental", "Gym", "Hotel", "Landscaping", "Cleaning", "Construction", "Legal",
  "Professional Services", "Other",
];

// ─── Main component ───────────────────────────────────────────────────────────
export default function OutreachQueue() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin" || user?.role === "manager";

  // ── Filters & pagination ───────────────────────────────────────────────────
  const [page, setPage] = useState(1);
  const [cursor, setCursor] = useState(0);
  const LIMIT = 50;
  const [filterScore,    setFilterScore]    = useState("all");
  const [filterVertical, setFilterVertical] = useState("all");
  const [filterAssigned, setFilterAssigned] = useState("all");
  const [channel, setChannel] = useState<"email" | "manual_call" | "sms">("email");

  // ── Selection ──────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // ── Successful enrollments (to show inline checkmark) ─────────────────────
  const [enrolledIds, setEnrolledIds] = useState<Set<number>>(new Set());

  const queueParams = new URLSearchParams({
    page: String(page),
    limit: String(LIMIT),
    ...(cursor ? { cursor: String(cursor) } : {}),
    ...(filterScore    !== "all" ? { score:    filterScore    } : {}),
    ...(filterVertical !== "all" ? { vertical: filterVertical } : {}),
    ...(filterAssigned !== "all" && isAdmin ? { assignedTo: filterAssigned } : {}),
    channel,
  });

  const queueQuery = useQuery<QueuePage>({
    queryKey: ["/api/outreach-queue", cursor, filterScore, filterVertical, filterAssigned, channel],
    queryFn: async () => {
      const r = await fetch(`/api/outreach-queue?${queueParams}`, { credentials: "include" });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    placeholderData: (prev) => prev,
  });

  // Server-backed assignee list so the filter shows all reps, not just the current page
  const assigneesQuery = useQuery<{ assignees: (string | null)[] }>({
    queryKey: ["/api/outreach-queue/assignees", channel],
    queryFn: async () => {
      const r = await fetch(`/api/outreach-queue/assignees?channel=${channel}`, { credentials: "include" });
      if (!r.ok) return { assignees: [] };
      return r.json();
    },
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  });

  const contacts = queueQuery.data?.data ?? [];
  const total    = queueQuery.data?.total ?? null;

  // ── Mutations ──────────────────────────────────────────────────────────────
  const startMutation = useMutation({
    mutationFn: async (contact: QueueContact) => {
      if (!contact.decision.sequenceId) throw new Error("No qualified sequence is available");
      const r = await fetch(`/api/outreach-queue/${contact.id}/start`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": getCsrfToken() ?? "",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ channel, sequenceId: contact.decision.sequenceId }),
      });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    onSuccess: (data: any, contact) => {
      if (data.alreadyEnrolled) {
        toast({ title: "Already enrolled", description: data.message });
      } else {
        toast({
          title: "Outreach started!",
          description: `Enrolled in ${data.sequenceName ?? "sequence"}${data.dealAdvanced ? " · deal advanced to Enriched" : ""}`,
        });
        setEnrolledIds(prev => new Set(prev).add(contact.id));
      }
      queryClient.invalidateQueries({ queryKey: ["/api/outreach-queue"] });
    },
    onError: (e: Error) => toast({ title: "Failed to start outreach", description: e.message, variant: "destructive" }),
  });

  const skipMutation = useMutation({
    mutationFn: async (contactId: number) => {
      const r = await apiRequest("POST", `/api/outreach-queue/${contactId}/skip`, {});
      return r.json();
    },
    onSuccess: (_data, contactId) => {
      toast({ title: "Lead skipped", description: "It will reappear if re-enriched." });
      setSelectedIds(prev => { const n = new Set(prev); n.delete(contactId); return n; });
      queryClient.invalidateQueries({ queryKey: ["/api/outreach-queue"] });
    },
    onError: (e: Error) => toast({ title: "Skip failed", description: e.message, variant: "destructive" }),
  });

  const BULK_CAP = 50;

  const bulkEnrollMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      // Strictly cap at 50; excess IDs are left selected so the rep can act on them next.
      const toEnroll = ids.slice(0, BULK_CAP);
      const skipped  = ids.length - toEnroll.length;
      const results = await Promise.allSettled(
        toEnroll.map(id => {
          const contact = contacts.find((candidate) => candidate.id === id);
          if (!contact?.decision.sequenceId) return Promise.reject(new Error("No qualified sequence"));
          return fetch(`/api/outreach-queue/${id}/start`, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": getCsrfToken() ?? "",
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify({ channel, sequenceId: contact.decision.sequenceId }),
          }).then(async (r) => {
            if (!r.ok) throw new Error(await r.text());
            return r.json();
          });
        })
      );
      const succeeded = results.filter(r => r.status === "fulfilled").length;
      const failed    = results.filter(r => r.status === "rejected").length;
      return { succeeded, failed, total: toEnroll.length, skipped, enrolledIds: toEnroll };
    },
    onSuccess: (data) => {
      toast({
        title: `${data.succeeded} lead${data.succeeded !== 1 ? "s" : ""} enrolled`,
        description: [
          data.failed > 0 ? `${data.failed} failed.` : "",
          data.skipped > 0 ? `${data.skipped} remaining — select and enroll again.` : "",
        ].filter(Boolean).join(" ") || "Outreach sequences started.",
      });
      // Only clear the IDs that were submitted; leave excess selected.
      const submitted = new Set(data.enrolledIds);
      setSelectedIds(prev => { const next = new Set(prev); submitted.forEach(id => next.delete(id)); return next; });
      queryClient.invalidateQueries({ queryKey: ["/api/outreach-queue"] });
    },
    onError: (e: Error) => toast({ title: "Bulk enroll failed", description: e.message, variant: "destructive" }),
  });

  // ── Selection helpers ──────────────────────────────────────────────────────
  const allPageSelected = contacts.length > 0 && contacts.every(c => selectedIds.has(c.id));
  const someSelected    = selectedIds.size > 0;

  const toggleAll = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allPageSelected) contacts.forEach(c => next.delete(c.id));
      else contacts.forEach(c => next.add(c.id));
      return next;
    });
  }, [contacts, allPageSelected]);

  const toggleOne = useCallback((id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const isPending = (id: number) =>
    (startMutation.isPending && startMutation.variables?.id === id) ||
    (skipMutation.isPending && skipMutation.variables === id);

  // ── Server-backed rep list for manager filter ──────────────────────────────
  const repList = (assigneesQuery.data?.assignees ?? []).filter((a): a is string => !!a);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 pb-12">
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <PageTitle className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Rocket className="h-6 w-6 text-primary" />
            Ready for Outreach
          </PageTitle>
          <p className="text-muted-foreground text-sm mt-0.5">
            Channel-qualified leads from policy v{queueQuery.data?.policyVersion ?? "—"}.
            {total != null && total > 0 && (
              <span className="ml-1 font-medium text-foreground">{total.toLocaleString()} waiting.</span>
            )}
          </p>
        </div>
        <Button
          variant="outline" size="sm"
          onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/outreach-queue"] })}
          className="gap-1.5 self-start sm:self-auto"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        <Select value={channel} onValueChange={(value) => { setChannel(value as typeof channel); setPage(1); setCursor(0); setSelectedIds(new Set()); }}>
          <SelectTrigger className="w-44 h-8 text-sm">
            <SelectValue placeholder="Channel" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="email">Email qualified</SelectItem>
            <SelectItem value="manual_call">Manual call qualified</SelectItem>
            <SelectItem value="sms">SMS qualified</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterScore} onValueChange={v => { setFilterScore(v); setPage(1); setCursor(0); }}>
          <SelectTrigger className="w-36 h-8 text-sm">
            <SelectValue placeholder="All scores" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All scores</SelectItem>
            <SelectItem value="hot">🔥 Hot (≥70)</SelectItem>
            <SelectItem value="warm">🌤 Warm (≥45)</SelectItem>
            <SelectItem value="cold">❄️ Cold (≥20)</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterVertical} onValueChange={v => { setFilterVertical(v); setPage(1); setCursor(0); }}>
          <SelectTrigger className="w-44 h-8 text-sm">
            <SelectValue placeholder="All verticals" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All verticals</SelectItem>
            {VERTICALS.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
          </SelectContent>
        </Select>

        {isAdmin && (
          <Select value={filterAssigned} onValueChange={v => { setFilterAssigned(v); setPage(1); setCursor(0); }}>
            <SelectTrigger className="w-48 h-8 text-sm">
              <SelectValue placeholder="All reps" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All reps</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {repList.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* ── Bulk action bar ───────────────────────────────────────────────── */}
      {false && someSelected && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 rounded-lg border border-primary/20">
          <Checkbox checked={allPageSelected} onCheckedChange={toggleAll} aria-label="Select all leads on this page" className="shrink-0" />
          <span className="text-sm font-medium">
            {selectedIds.size} lead{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <Button
            size="sm" className="gap-1.5 h-8"
            onClick={() => bulkEnrollMutation.mutate([...selectedIds])}
            disabled={bulkEnrollMutation.isPending}
          >
            {bulkEnrollMutation.isPending
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Rocket className="h-3.5 w-3.5" />}
            Enroll All ({Math.min(selectedIds.size, 50)})
          </Button>
          <Button
            size="sm" variant="ghost" className="h-8 text-muted-foreground"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={allPageSelected} onCheckedChange={toggleAll} aria-label="Select all" />
                </TableHead>
                <TableHead>Company / Contact</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Vertical</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Location</TableHead>
                {isAdmin && <TableHead>Assigned To</TableHead>}
                <TableHead>Added</TableHead>
                <TableHead className="text-right w-28">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {queueQuery.isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: isAdmin ? 10 : 9 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : contacts.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isAdmin ? 10 : 9} className="text-center h-40">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <CheckCircle className="h-8 w-8 text-green-400" />
                      <p className="font-medium text-foreground">{queueQuery.data?.hasMore ? "No matches in this scan" : "All caught up"}</p>
                      <p className="text-sm">{queueQuery.data?.hasMore
                        ? "Continue to scan the next bounded set of leads."
                        : "No leads ready for outreach right now."}</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                contacts.map((contact) => {
                  const wasEnrolled = enrolledIds.has(contact.id);
                  return (
                    <TableRow
                      key={contact.id}
                      className={[
                        selectedIds.has(contact.id) ? "bg-primary/5" : "",
                        wasEnrolled ? "opacity-60" : "",
                      ].join(" ")}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(contact.id)}
                          onCheckedChange={() => toggleOne(contact.id)}
                          disabled={wasEnrolled}
                        />
                      </TableCell>

                      {/* Company / Contact */}
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          {contact.companyName && (
                            <Link
                              href={`/dashboard/contacts/${contact.id}`}
                              className="font-medium text-sm hover:underline"
                            >
                              {contact.companyName}
                            </Link>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "—"}
                          </span>
                        </div>
                      </TableCell>

                      {/* Phone */}
                      <TableCell>
                        {contact.phone
                          ? <a href={`tel:${contact.phone}`} className="text-sm text-blue-600 hover:underline flex items-center gap-1"><Phone className="h-3 w-3" />{contact.phone}</a>
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>

                      {/* Email */}
                      <TableCell>
                        {contact.email
                          ? <a href={`mailto:${contact.email}`} className="text-sm text-blue-600 hover:underline flex items-center gap-1 max-w-[180px] truncate"><Mail className="h-3 w-3 shrink-0" /><span className="truncate">{contact.email}</span></a>
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>

                      {/* Vertical */}
                      <TableCell>
                        {contact.vertical
                          ? <Badge variant="outline" className="text-[10px] px-1.5">{contact.vertical}</Badge>
                          : <span className="text-muted-foreground text-xs">—</span>}
                      </TableCell>

                      {/* Score */}
                      <TableCell>
                        <ScoreBadge tier={contact.scoreTier} score={contact.leadScore} />
                      </TableCell>

                      {/* Location */}
                      <TableCell>
                        <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                          {contact.city || contact.state
                            ? <><MapPin className="h-3 w-3 shrink-0" />{[contact.city, contact.state].filter(Boolean).join(", ")}</>
                            : "—"}
                        </span>
                      </TableCell>

                      {/* Assigned To (admin/manager only) */}
                      {isAdmin && (
                        <TableCell>
                          <span className="text-xs text-muted-foreground truncate max-w-[120px] block">
                            {contact.assignedTo ?? <span className="italic">Unassigned</span>}
                          </span>
                        </TableCell>
                      )}

                      {/* Added date */}
                      <TableCell>
                        <span className="text-xs text-muted-foreground">{formatDate(contact.createdAt)}</span>
                      </TableCell>

                      {/* Actions */}
                      <TableCell className="text-right">
                        {wasEnrolled ? (
                          <span className="text-xs text-green-600 flex items-center gap-1 justify-end">
                            <CheckCircle className="h-3.5 w-3.5" /> Enrolled
                          </span>
                        ) : (
                          <div className="flex items-center gap-1 justify-end">
                            <Button
                              size="sm"
                              className="h-7 text-xs gap-1 px-2"
                              onClick={() => startMutation.mutate(contact)}
                              disabled
                              title="Freeze an authorized cohort before enrollment"
                            >
                              {startMutation.isPending && startMutation.variables?.id === contact.id
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <Rocket className="h-3 w-3" />}
                              Start
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs gap-1 px-2 text-muted-foreground"
                              onClick={() => skipMutation.mutate(contact.id)}
                              disabled={isPending(contact.id) || skipMutation.isPending}
                              title="Skip — hides this lead until re-enriched"
                            >
                              <SkipForward className="h-3 w-3" />
                              Skip
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {(page > 1 || queueQuery.data?.hasMore) && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {total == null ? `Showing continuation page ${page}` : `Showing ${((page - 1) * LIMIT) + 1}–${Math.min(page * LIMIT, total)} of ${total.toLocaleString()}`}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline" size="sm" className="h-7 px-2"
              onClick={() => { setPage(1); setCursor(0); }}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="px-2 text-xs">Page {page}{total == null ? " (partial)" : ""}</span>
            <Button
              variant="outline" size="sm" className="h-7 px-2"
              onClick={() => { if (queueQuery.data?.nextCursor != null) { setCursor(queueQuery.data.nextCursor); setPage(p => p + 1); } }}
              disabled={!queueQuery.data?.hasMore || queueQuery.data.nextCursor == null}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
