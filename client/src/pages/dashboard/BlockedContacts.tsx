import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/crm/CrmPresentation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Download,
  Loader2,
  ShieldX,
  XCircle,
  AlertTriangle,
  Search,
} from "lucide-react";
import { Link } from "wouter";

// ── Types ────────────────────────────────────────────────────────────────────

interface BlockedContact {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string;
  phone: string | null;
  email_status: string | null;
  sms_status: string | null;
  do_not_contact: boolean;
  do_not_auto_contact: boolean;
  dnc_reason: string | null;
  suppression_reason: string | null;
  created_at: string;
}

interface BlockedContactsResult {
  total: number;
  page: number;
  limit: number;
  data: BlockedContact[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function EmailStatusBadge({ status }: { status: string | null }) {
  if (!status || status === "active") return null;
  const map: Record<string, { label: string; cls: string }> = {
    bounced:   { label: "bounced",    cls: "bg-red-100 text-red-700 border-red-200" },
    invalid:   { label: "invalid",    cls: "bg-red-100 text-red-700 border-red-200" },
    unsafe:    { label: "unsafe",     cls: "bg-orange-100 text-orange-700 border-orange-200" },
    opted_out: { label: "opted out",  cls: "bg-yellow-100 text-yellow-700 border-yellow-200" },
  };
  const meta = map[status] ?? { label: status, cls: "bg-gray-100 text-gray-600 border-gray-200" };
  return (
    <Badge variant="outline" className={`text-xs ${meta.cls}`}>
      {meta.label}
    </Badge>
  );
}

const EMAIL_STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "bounced",   label: "Bounced" },
  { value: "invalid",   label: "Invalid" },
  { value: "unsafe",    label: "Unsafe" },
  { value: "opted_out", label: "Opted out" },
];

const DNC_OPTIONS = [
  { value: "all",   label: "All" },
  { value: "true",  label: "DNC only" },
  { value: "false", label: "Non-DNC only" },
];

// ── Main component ────────────────────────────────────────────────────────────

export default function BlockedContacts() {
  const { user } = useAuth();
  const { toast } = useToast();

  const isAdminOrManager = user?.role === "admin" || user?.role === "manager";

  const [emailStatus, setEmailStatus] = useState<string>("all");
  const [doNotContact, setDoNotContact] = useState<string>("all");
  const [reason, setReason] = useState<string>("");
  const [reasonInput, setReasonInput] = useState<string>("");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const params = new URLSearchParams();
  if (emailStatus !== "all") params.set("emailStatus", emailStatus);
  if (doNotContact !== "all") params.set("doNotContact", doNotContact);
  if (reason) params.set("reason", reason);
  params.set("page", String(page));
  params.set("limit", "50");

  const { data, isLoading } = useQuery<BlockedContactsResult>({
    queryKey: ["/api/contacts/blocked", emailStatus, doNotContact, reason, page],
    queryFn: () =>
      apiRequest("GET", `/api/contacts/blocked?${params.toString()}`).then((r) => r.json()),
  });

  const totalPages = data ? Math.ceil(data.total / data.limit) : 1;

  function applyReasonSearch() {
    setReason(reasonInput.trim());
    setPage(1);
  }

  async function handleExport() {
    if (!isAdminOrManager) return;
    setExporting(true);
    try {
      const exportParams = new URLSearchParams();
      if (emailStatus !== "all") exportParams.set("emailStatus", emailStatus);
      if (doNotContact !== "all") exportParams.set("doNotContact", doNotContact);
      if (reason) exportParams.set("reason", reason);

      const res = await fetch(`/api/contacts/blocked/export-csv?${exportParams.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Export failed" }));
        throw new Error(err.message || "Export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().split("T")[0];
      const a = document.createElement("a");
      a.href = url;
      a.download = `blocked-contacts-${date}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Export started", description: "CSV download has begun." });
    } catch (err: any) {
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <PageHeader
        title="Blocked Contacts"
        subtitle="Contacts suppressed from outreach due to DNC flags, bounced email, opt-outs, or unsafe email addresses."
      />

      {/* ── Filters ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldX className="h-4 w-4 text-red-500" /> Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            {/* Email status filter */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground font-medium">Email Status</label>
              <Select
                value={emailStatus}
                onValueChange={(v) => { setEmailStatus(v); setPage(1); }}
              >
                <SelectTrigger className="w-44 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMAIL_STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* DNC filter */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground font-medium">Do Not Contact</label>
              <Select
                value={doNotContact}
                onValueChange={(v) => { setDoNotContact(v); setPage(1); }}
              >
                <SelectTrigger className="w-36 h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DNC_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Reason search */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground font-medium">Reason contains</label>
              <div className="flex items-center gap-1">
                <Input
                  className="h-8 text-sm w-44"
                  placeholder="e.g. do_not_contact"
                  value={reasonInput}
                  onChange={(e) => setReasonInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && applyReasonSearch()}
                />
                <Button size="sm" variant="ghost" className="h-8 px-2" onClick={applyReasonSearch}>
                  <Search className="h-3 w-3" />
                </Button>
              </div>
            </div>

            {/* Export button — admin/manager only */}
            {isAdminOrManager && (
              <div className="ml-auto">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-900/20"
                  onClick={handleExport}
                  disabled={exporting}
                  data-testid="button-export-blocked-contacts"
                >
                  {exporting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  Export CSV
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Results table ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-500" />
            {isLoading ? "Loading…" : `${(data?.total ?? 0).toLocaleString()} blocked contact${data?.total !== 1 ? "s" : ""}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : !data || data.data.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No blocked contacts match the current filters.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground text-xs">
                      <th className="text-left py-2 pr-3 font-medium">Contact</th>
                      <th className="text-left py-2 pr-3 font-medium">Email</th>
                      <th className="text-left py-2 pr-3 font-medium">Email Status</th>
                      <th className="text-left py-2 pr-3 font-medium">DNC</th>
                      <th className="text-left py-2 pr-3 font-medium">Reason</th>
                      <th className="text-left py-2 font-medium">Added</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.data.map((c) => {
                      const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
                      const blockedReason = c.dnc_reason || c.suppression_reason || "—";
                      return (
                        <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                          <td className="py-2 pr-3">
                            <Link href={`/dashboard/contacts/${c.id}`}>
                              <span className="font-medium text-blue-600 dark:text-blue-400 hover:underline cursor-pointer truncate max-w-[140px] block">
                                {name}
                              </span>
                            </Link>
                          </td>
                          <td className="py-2 pr-3 text-xs font-mono truncate max-w-[200px]">
                            {c.email}
                          </td>
                          <td className="py-2 pr-3">
                            <EmailStatusBadge status={c.email_status} />
                          </td>
                          <td className="py-2 pr-3">
                            {c.do_not_contact ? (
                              <Badge variant="destructive" className="text-xs">DNC</Badge>
                            ) : (
                              <span className="text-muted-foreground text-xs">—</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground max-w-[200px] truncate">
                            {blockedReason}
                          </td>
                          <td className="py-2 text-xs text-muted-foreground">
                            {c.created_at
                              ? new Date(c.created_at).toLocaleDateString()
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between pt-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-1 text-xs">
                  <AlertTriangle className="h-3 w-3 text-yellow-500" />
                  These contacts are suppressed from all automated outreach.
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                  >
                    Previous
                  </Button>
                  <span>Page {page} of {totalPages}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={page >= totalPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
