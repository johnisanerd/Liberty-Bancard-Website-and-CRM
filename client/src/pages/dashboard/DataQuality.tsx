import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/crm/CrmPresentation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { ZeroBounceCampaign } from "@/components/ZeroBounceCampaign";
import {
  Users, Mail, Phone, Tag, User, CheckCircle2, XCircle, AlertCircle,
  Loader2, ShieldCheck, ShieldX, ShieldAlert, Zap,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface QualitySummary {
  total_contacts: number;
  blank_first_name: number;
  unvalidated_email: number;
  bad_email: number;
  missing_vertical: number;
  missing_phone: number;
  verified_valid: number;
  catch_all: number;
}

interface QualityContact {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string;
  email_status: string | null;
  phone: string | null;
  vertical: string | null;
  company_name: string | null;
  lead_score: number | null;
  created_at: string;
}

interface QualityScanResult {
  total: number;
  page: number;
  limit: number;
  data: QualityContact[];
}

interface BatchJobResult {
  jobId: string;
  queued: number;
  message: string;
}

const ISSUE_OPTIONS = [
  { value: "unvalidated_email", label: "Unvalidated email" },
  { value: "bad_email",         label: "Bounced / invalid / unsafe email" },
  { value: "blank_name",        label: "Blank first name" },
  { value: "missing_vertical",  label: "Missing vertical" },
  { value: "missing_phone",     label: "Missing phone" },
];

// ── Sub-components ───────────────────────────────────────────────────────────

function StatCard({
  label, value, total, icon, color,
}: {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-lg border bg-card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className={`flex items-center gap-2 text-sm font-medium ${color}`}>
          {icon}
          <span>{label}</span>
        </div>
        <span className="text-2xl font-bold">{value.toLocaleString()}</span>
      </div>
      <Progress value={pct} className="h-1.5" />
      <p className="text-xs text-muted-foreground text-right">{pct}% of {total.toLocaleString()} contacts</p>
    </div>
  );
}

function EmailStatusBadge({ status }: { status: string | null }) {
  if (!status || status === "active" || status === "unvalidated") {
    return <Badge variant="outline" className="text-xs text-yellow-700 border-yellow-300 bg-yellow-50">unvalidated</Badge>;
  }
  const map: Record<string, { label: string; icon: React.ReactNode; cls: string }> = {
    valid:      { label: "valid",      icon: <CheckCircle2 className="h-3 w-3" />, cls: "text-green-700 border-green-300 bg-green-50" },
    unsafe:     { label: "unsafe",     icon: <ShieldX className="h-3 w-3" />,      cls: "text-red-700 border-red-300 bg-red-50" },
    bounced:    { label: "bounced",    icon: <XCircle className="h-3 w-3" />,      cls: "text-red-700 border-red-300 bg-red-50" },
    invalid:    { label: "invalid",    icon: <XCircle className="h-3 w-3" />,      cls: "text-red-700 border-red-300 bg-red-50" },
    unverified: { label: "catch-all",  icon: <ShieldAlert className="h-3 w-3" />,  cls: "text-yellow-700 border-yellow-300 bg-yellow-50" },
    unknown:    { label: "unknown",    icon: <AlertCircle className="h-3 w-3" />,  cls: "text-gray-500 border-gray-300 bg-gray-50" },
  };
  const meta = map[status] ?? { label: status, icon: null, cls: "text-gray-500 border-gray-300 bg-gray-50" };
  return (
    <Badge variant="outline" className={`text-xs flex items-center gap-1 ${meta.cls}`}>
      {meta.icon}
      {meta.label}
    </Badge>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function DataQuality() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [selectedIssue, setSelectedIssue] = useState<string>("unvalidated_email");
  const [page, setPage] = useState(1);
  const [validatingId, setValidatingId] = useState<number | null>(null);
  const [batchJobId, setBatchJobId] = useState<string | null>(null);

  const { data: summary, isLoading: summaryLoading } = useQuery<QualitySummary>({
    queryKey: ["/api/contacts/quality-summary"],
    refetchInterval: 30_000,
  });

  const { data: scan, isLoading: scanLoading } = useQuery<QualityScanResult>({
    queryKey: ["/api/contacts/quality-scan", selectedIssue, page],
    queryFn: () =>
      apiRequest("GET", `/api/contacts/quality-scan?issue=${selectedIssue}&page=${page}&limit=50`)
        .then((r) => r.json()),
  });

  const { data: jobStatus, isLoading: jobLoading } = useQuery({
    queryKey: ["/api/contacts/validate-emails-batch", batchJobId],
    queryFn: () =>
      apiRequest("GET", `/api/contacts/validate-emails-batch/${batchJobId}`).then((r) => r.json()),
    enabled: !!batchJobId,
    refetchInterval: (data: any) => (data?.done ? false : 2000),
  });

  const batchMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/contacts/validate-emails-batch", {
        issue: selectedIssue,
        limit: 100,
        minLeadScore: 0,
      }).then((r) => r.json() as Promise<BatchJobResult>),
    onSuccess: (data) => {
      setBatchJobId(data.jobId);
      toast({ title: `Batch started — ${data.queued} email(s) queued`, description: data.message });
    },
    onError: (err: any) => {
      toast({ title: "Batch failed", description: err.message, variant: "destructive" });
    },
  });

  async function validateSingle(contactId: number) {
    setValidatingId(contactId);
    try {
      const res = await apiRequest("POST", `/api/contacts/${contactId}/validate-email`);
      const data = await res.json();
      if (data.success) {
        toast({ title: `Email validated: ${data.status}`, description: data.email });
        qc.invalidateQueries({ queryKey: ["/api/contacts/quality-scan"] });
        qc.invalidateQueries({ queryKey: ["/api/contacts/quality-summary"] });
      } else {
        toast({ title: "Validation failed", description: data.message, variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setValidatingId(null);
    }
  }

  const totalPages = scan ? Math.ceil(scan.total / scan.limit) : 1;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <PageHeader
        title="Data Quality Scanner"
        subtitle="Surface contacts with incomplete or unvalidated data. Validate eligible emails via ZeroBounce."
      />

      {/* ── Validation campaign tracker (task 1540C) ── */}
      <ZeroBounceCampaign
        fallbackEligible={summary?.unvalidated_email}
      />

      {/* ── Aggregate stat cards ── */}
      {summaryLoading ? (
        <div className="flex items-center gap-2 py-4 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading quality summary…
        </div>
      ) : summary ? (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          <StatCard
            label="Unvalidated email"
            value={summary.unvalidated_email}
            total={summary.total_contacts}
            icon={<Mail className="h-4 w-4" />}
            color="text-yellow-600"
          />
          <StatCard
            label="Bounced / unsafe"
            value={summary.bad_email}
            total={summary.total_contacts}
            icon={<XCircle className="h-4 w-4" />}
            color="text-red-600"
          />
          <StatCard
            label="ZeroBounce validated"
            value={summary.verified_valid}
            total={summary.total_contacts}
            icon={<CheckCircle2 className="h-4 w-4" />}
            color="text-green-600"
          />
          <StatCard
            label="Blank first name"
            value={summary.blank_first_name}
            total={summary.total_contacts}
            icon={<User className="h-4 w-4" />}
            color="text-orange-600"
          />
          <StatCard
            label="Missing vertical"
            value={summary.missing_vertical}
            total={summary.total_contacts}
            icon={<Tag className="h-4 w-4" />}
            color="text-purple-600"
          />
          <StatCard
            label="Missing phone"
            value={summary.missing_phone}
            total={summary.total_contacts}
            icon={<Phone className="h-4 w-4" />}
            color="text-blue-600"
          />
        </div>
      ) : null}

      {/* ── Filterable table ── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start gap-3 justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="h-4 w-4" /> Affected Contacts
              </CardTitle>
              <CardDescription>
                Showing the highest-scored contacts for the selected issue.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={selectedIssue} onValueChange={(v) => { setSelectedIssue(v); setPage(1); }}>
                <SelectTrigger className="w-52 text-sm h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ISSUE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => batchMutation.mutate()}
                disabled={batchMutation.isPending}
                data-testid="btn-validate-batch"
              >
                {batchMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Zap className="h-3 w-3 mr-1" />}
                Validate Filtered Batch
              </Button>
            </div>
          </div>

          {/* Batch job status */}
          {batchJobId && (
            <div className={`mt-2 rounded-md px-3 py-2 text-xs border ${jobStatus?.done ? "bg-green-50 border-green-200 text-green-800" : "bg-blue-50 border-blue-200 text-blue-800"}`}>
              {jobLoading || !jobStatus ? (
                <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Validating…</span>
              ) : jobStatus.done ? (
                <span>
                  ✓ Done — {jobStatus.processed} validated, {jobStatus.valid} valid,{" "}
                  {jobStatus.blocked} blocked, {jobStatus.errors} errors
                </span>
              ) : (
                <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> In progress…</span>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {scanLoading ? (
            <div className="flex items-center gap-2 py-8 text-muted-foreground text-sm justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : !scan || scan.data.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No contacts found for this filter. Great news — this category is clean!
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
                      <th className="text-left py-2 pr-3 font-medium">Vertical</th>
                      <th className="text-left py-2 pr-3 font-medium">Phone</th>
                      <th className="text-right py-2 font-medium">Score</th>
                      <th className="text-right py-2 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {scan.data.map((c) => (
                      <tr key={c.id} className="hover:bg-muted/30 transition-colors">
                        <td className="py-2 pr-3">
                          <div className="font-medium truncate max-w-[140px]">
                            {[c.first_name, c.last_name].filter(Boolean).join(" ") || <span className="text-muted-foreground italic">blank name</span>}
                          </div>
                          {c.company_name && (
                            <div className="text-xs text-muted-foreground truncate max-w-[140px]">{c.company_name}</div>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-xs font-mono truncate max-w-[160px]">{c.email}</td>
                        <td className="py-2 pr-3">
                          <EmailStatusBadge status={c.email_status} />
                        </td>
                        <td className="py-2 pr-3 text-xs">
                          {c.vertical || <span className="text-muted-foreground italic">—</span>}
                        </td>
                        <td className="py-2 pr-3 text-xs font-mono">
                          {c.phone || <span className="text-muted-foreground italic">—</span>}
                        </td>
                        <td className="py-2 text-right">
                          <Badge variant="secondary" className="text-xs">{c.lead_score ?? 0}</Badge>
                        </td>
                        <td className="py-2 text-right">
                          {(c.email_status == null || c.email_status === "active" || c.email_status === "unvalidated") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => validateSingle(c.id)}
                              disabled={validatingId === c.id}
                              data-testid={`btn-validate-${c.id}`}
                            >
                              {validatingId === c.id
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <><ShieldCheck className="h-3 w-3 mr-1" />Validate</>}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between pt-4 text-sm text-muted-foreground">
                <span>{scan.total.toLocaleString()} total</span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
                    Previous
                  </Button>
                  <span>Page {page} of {totalPages}</span>
                  <Button size="sm" variant="outline" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
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
