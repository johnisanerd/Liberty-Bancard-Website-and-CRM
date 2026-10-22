import { PageTitle } from "@/components/ui/page-header";
import { useState,useEffect } from "react";
import {useSearch,useLocation} from "wouter";
import {c4WorkspaceSelection,testimonialViews,testimonialUrl} from "@/lib/crm-destination-state";
import {useCrmQuery as useQuery,useCrmActorIdentity} from "@/hooks/use-crm-query";
import {CrmDataState} from "@/components/crm/CrmPresentation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  MessageSquareQuote,
  Mail,
  Phone,
  Building2,
  DollarSign,
  Eye,
  EyeOff,
} from "lucide-react";
import type { TestimonialSubmission } from "@shared/schema";

type SubmissionUpdate = {
  status?: "pending" | "approved" | "rejected";
  publish?: boolean;
  reviewNotes?: string | null;
};

type StatusFilter = "all" | "pending" | "approved" | "rejected";

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: any; className: string; label: string }> = {
    pending: { variant: "secondary", className: "", label: "Pending" },
    approved: { variant: "default", className: "bg-emerald-600 text-white dark:bg-emerald-600", label: "Approved" },
    rejected: { variant: "outline", className: "border-red-500/50 text-red-600 dark:text-red-400", label: "Rejected" },
  };
  const cfg = map[status] || {variant:"outline",className:"",label:status?`Unknown: ${status}`:"Status unavailable"};
  return (
    <Badge variant={cfg.variant} className={cfg.className} data-testid={`badge-status-${status}`}>
      {cfg.label}
    </Badge>
  );
}

export default function TestimonialSubmissions() {
  const { toast } = useToast();
  const viewState=c4WorkspaceSelection(useSearch(),"testimonialView",testimonialViews,"pending");
  const filter=viewState.value;
  const [,navigate]=useLocation();
  const setFilter=(value:StatusFilter)=>navigate(testimonialUrl(window.location.search,window.location.hash,value));
  const [notesById, setNotesById] = useState<Record<number, string>>({});
  const actorIdentity=useCrmActorIdentity();
  useEffect(()=>setNotesById({}),[actorIdentity]);

  const queryKey = filter === "all" ? ["/api/testimonial-submissions"] : ["/api/testimonial-submissions", filter];

  const { data: submissions, isLoading,isError,error,refetch } = useQuery<TestimonialSubmission[]>({
    queryKey,
    enabled:!viewState.issues.length,
    queryFn: async ({signal}) => {
      const url = filter === "all"
        ? "/api/testimonial-submissions"
        : `/api/testimonial-submissions?status=${filter}`;
      const res = await fetch(url, { credentials: "include",signal });
      if (!res.ok) throw new Error(`${res.status}: Story records unavailable`);
      const rows=await res.json();
      if(!Array.isArray(rows)||rows.some(row=>!Number.isInteger(row?.id)))throw new Error("Story record shape unavailable");
      return rows;
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: SubmissionUpdate }) => {
      if(viewState.issues.length||isLoading||isError||!submissions?.some(row=>row.id===id))
        throw new Error("Current matching story read required");
      const res = await apiRequest("PATCH", `/api/testimonial-submissions/${id}`, updates);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/testimonial-submissions"] });
      toast({ title: "Updated", description: "Submission updated successfully." });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const readAvailable=!viewState.issues.length&&!isLoading&&!isError&&!!submissions;
  const list = readAvailable?submissions || []:[];
  const counts = {
    pending: list.filter((s) => s.status === "pending").length,
    approved: list.filter((s) => s.status === "approved").length,
    rejected: list.filter((s) => s.status === "rejected").length,
    published: list.filter((s) => s.status === "approved" && s.publish).length,
  };

  return (
    <div className="space-y-6" data-testid="page-testimonial-submissions">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <PageTitle className="text-2xl font-bold" data-testid="text-page-title">Testimonial Submissions</PageTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Review merchant stories submitted from /testimonials/submit. Approve and toggle publish to feature them on the public testimonials page.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card data-testid="card-stat-pending">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending</CardTitle>
            <Clock className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className={`${readAvailable?"text-2xl":"text-sm"} font-bold`} data-testid="text-count-pending">{isLoading?"Loading":readAvailable?counts.pending:"Unavailable"}</div>
          </CardContent>
        </Card>
        <Card data-testid="card-stat-approved">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Approved</CardTitle>
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          </CardHeader>
          <CardContent>
            <div className={`${readAvailable?"text-2xl":"text-sm"} font-bold`} data-testid="text-count-approved">{isLoading?"Loading":readAvailable?counts.approved:"Unavailable"}</div>
          </CardContent>
        </Card>
        <Card data-testid="card-stat-rejected">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Rejected</CardTitle>
            <XCircle className="w-4 h-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className={`${readAvailable?"text-2xl":"text-sm"} font-bold`} data-testid="text-count-rejected">{isLoading?"Loading":readAvailable?counts.rejected:"Unavailable"}</div>
          </CardContent>
        </Card>
        <Card data-testid="card-stat-published">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Published</CardTitle>
            <Eye className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className={`${readAvailable?"text-2xl":"text-sm"} font-bold`} data-testid="text-count-published">{isLoading?"Loading":readAvailable?counts.published:"Unavailable"}</div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={filter} onValueChange={(v) => setFilter(v as StatusFilter)}>
        <TabsList data-testid="tabs-status-filter">
          <TabsTrigger value="pending" data-testid="tab-pending">Pending</TabsTrigger>
          <TabsTrigger value="approved" data-testid="tab-approved">Approved</TabsTrigger>
          <TabsTrigger value="rejected" data-testid="tab-rejected">Rejected</TabsTrigger>
          <TabsTrigger value="all" data-testid="tab-all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      <p className="text-xs text-muted-foreground">Counts describe returned story records in the selected status, not the merchant population. Publish counts are recorded flags, not an independent public-page receipt. Source: submitted-story store; period, timezone, shared snapshot clock and contact-class completeness are not supplied.</p>
      {viewState.issues.length?<CrmDataState state="unavailable" message="Invalid/conflicting testimonial view; no default story read was requested."/>
      :isError?<CrmDataState state={/^403:/.test(error?.message||"")?"denied":"unavailable"} message="Story records unavailable; this is not a no-submissions result." onRetry={()=>void refetch()}/>
      :isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground" data-testid="text-no-submissions">
            No submissions in this view.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {list.map((s) => (
            <Card key={s.id} data-testid={`card-submission-${s.id}`}>
              <CardContent className="p-5 space-y-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-lg font-semibold" data-testid={`text-name-${s.id}`}>{s.name}</h3>
                      <StatusBadge status={s.status} />
                      {s.status === "approved" && s.publish && (
                        <Badge variant="outline" className="border-primary/50 text-primary" data-testid={`badge-published-${s.id}`}>
                          <Eye className="w-3 h-3 mr-1" /> Published
                        </Badge>
                      )}
                      {s.industry && (
                        <Badge variant="secondary" data-testid={`badge-industry-${s.id}`}>{s.industry}</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground mt-1 flex-wrap">
                      {s.businessName && (
                        <span className="flex items-center gap-1" data-testid={`text-business-${s.id}`}>
                          <Building2 className="w-3.5 h-3.5" />{s.businessName}
                        </span>
                      )}
                      <span className="flex items-center gap-1" data-testid={`text-email-${s.id}`}>
                        <Mail className="w-3.5 h-3.5" />{s.email}
                      </span>
                      {s.phone && (
                        <span className="flex items-center gap-1" data-testid={`text-phone-${s.id}`}>
                          <Phone className="w-3.5 h-3.5" />{s.phone}
                        </span>
                      )}
                      {s.savingsAmount && (
                        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400" data-testid={`text-savings-${s.id}`}>
                          <DollarSign className="w-3.5 h-3.5" />{s.savingsAmount}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground" data-testid={`text-created-${s.id}`}>
                    {s.createdAt ? new Date(s.createdAt).toLocaleString() : ""}
                  </div>
                </div>

                <div className="bg-muted/40 rounded-md p-4 border border-border">
                  <div className="flex items-start gap-2">
                    <MessageSquareQuote className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <p className="text-sm leading-relaxed whitespace-pre-wrap" data-testid={`text-story-${s.id}`}>
                      {s.story}
                    </p>
                  </div>
                </div>

                {s.videoLink && (
                  <a
                    href={s.videoLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary inline-flex items-center gap-1 hover:underline"
                    data-testid={`link-video-${s.id}`}
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> Open video link
                  </a>
                )}

                {s.reviewedBy && (
                  <div className="text-xs text-muted-foreground" data-testid={`text-reviewed-by-${s.id}`}>
                    Reviewed by <span className="font-medium">{s.reviewedBy}</span>
                    {s.reviewedAt && <> on {new Date(s.reviewedAt).toLocaleString()}</>}
                  </div>
                )}

                {s.reviewNotes && (
                  <div className="text-sm text-muted-foreground italic" data-testid={`text-review-notes-${s.id}`}>
                    Notes: {s.reviewNotes}
                  </div>
                )}

                <div className="space-y-3 pt-2 border-t">
                  <Textarea
                    placeholder="Internal review notes (optional)…"
                    value={notesById[s.id] ?? ""}
                    onChange={(e) => setNotesById((m) => ({ ...m, [s.id]: e.target.value }))}
                    rows={2}
                    data-testid={`textarea-notes-${s.id}`}
                  />

                  <div className="flex flex-wrap items-center gap-3 justify-between">
                    <div className="flex items-center gap-3">
                      {s.status !== "approved" && (
                        <Button
                          size="sm"
                          onClick={() =>
                            updateMutation.mutate({
                              id: s.id,
                              updates: {
                                status: "approved",
                                reviewNotes: notesById[s.id] || s.reviewNotes || null,
                              },
                            })
                          }
                          disabled={updateMutation.isPending}
                          data-testid={`button-approve-${s.id}`}
                        >
                          <CheckCircle2 className="w-4 h-4 mr-1" /> Approve
                        </Button>
                      )}
                      {s.status !== "rejected" && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            updateMutation.mutate({
                              id: s.id,
                              updates: {
                                status: "rejected",
                                publish: false,
                                reviewNotes: notesById[s.id] || s.reviewNotes || null,
                              },
                            })
                          }
                          disabled={updateMutation.isPending}
                          data-testid={`button-reject-${s.id}`}
                        >
                          <XCircle className="w-4 h-4 mr-1" /> Reject
                        </Button>
                      )}
                      {s.status !== "pending" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            updateMutation.mutate({
                              id: s.id,
                              updates: { status: "pending", publish: false },
                            })
                          }
                          disabled={updateMutation.isPending}
                          data-testid={`button-reopen-${s.id}`}
                        >
                          <Clock className="w-4 h-4 mr-1" /> Reopen
                        </Button>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      {s.publish ? <Eye className="w-4 h-4 text-primary" /> : <EyeOff className="w-4 h-4 text-muted-foreground" />}
                      <span className="text-sm" data-testid={`text-publish-label-${s.id}`}>
                        Publish on /testimonials
                      </span>
                      <Switch
                        checked={!!s.publish}
                        disabled={updateMutation.isPending || s.status !== "approved"}
                        onCheckedChange={(checked) =>
                          updateMutation.mutate({
                            id: s.id,
                            updates: { publish: checked },
                          })
                        }
                        data-testid={`switch-publish-${s.id}`}
                      />
                    </div>
                  </div>
                  {s.status !== "approved" && (
                    <p className="text-xs text-muted-foreground">
                      Approve the submission first to enable publishing.
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
