import { useState, useId } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { decodeJsonResponse, isRecord } from "@/lib/decode-json-response";
import { readerState } from "@/lib/reader-state";
import { ResourcesNav } from "@/components/dashboard/ResourcesNav";
import { CrmDataState, CrmPage, CrmPageHeader } from "@/components/crm/CrmPresentation";
import { useC4RetainedSelection } from "@/hooks/use-c4-retained-selection";
import { knowledgeAdminViews } from "@/lib/crm-destination-state";
import {
  BookOpen, Plus, RefreshCw, Globe, Lock, Users, Archive,
  CheckCircle2, Clock, HelpCircle, ThumbsUp, ThumbsDown, Eye,
  Layers, AlertTriangle, Zap, FileText
} from "lucide-react";
import { cn } from "@/lib/utils";

interface KnowledgeSource {
  id: number;
  title: string;
  sourceType: string;
  status: string;
  audience: string;
  version: number;
  lastIndexedAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  content?: string;
}

interface Stats {
  totalSources: number;
  publishedSources: number;
  totalChunks: number;
  indexedSources: number;
  openaiConfigured: boolean;
}

const AUDIENCE_ICONS: Record<string, JSX.Element> = {
  public: <Globe className="w-3 h-3" />,
  merchant: <Users className="w-3 h-3" />,
  staff: <Lock className="w-3 h-3" />,
  all: <Layers className="w-3 h-3" />,
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  published: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  archived: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const isReindexReceipt = (v: unknown): v is { ok: true; sources: number; chunks: number } =>
  isRecord(v) && v.ok === true && Number.isFinite(v.sources) && Number.isFinite(v.chunks);
const isIndexReceipt = (v: unknown): v is { ok: true; chunksWritten: number } =>
  isRecord(v) && v.ok === true && Number.isFinite(v.chunksWritten);

export default function KnowledgeAdmin() {
  const { toast } = useToast();
  const titleId = useId();
  const audienceId = useId();
  const contentId = useId();
  const contentHelpId = useId();
  const tabSelection = useC4RetainedSelection("/dashboard/knowledge-admin", "tab", knowledgeAdminViews, "sources");
  const queryClient = useQueryClient();
  const [newSourceOpen, setNewSourceOpen] = useState(false);
  const [editSource, setEditSource] = useState<KnowledgeSource | null>(null);
  const [form, setForm] = useState({ title: "", audience: "public", content: "" });

  const { data: statsData, isError: statsError, refetch: retryStats } = useQuery<Stats>({
    queryKey: ["/api/knowledge/stats"],
  });

  const { data: sourcesData, isLoading, isError: sourcesError, refetch: retrySources } = useQuery<{ sources: KnowledgeSource[] }>({
    queryKey: ["/api/knowledge/sources"],
  });

  const unansweredQuery = useQuery<{ questions: any[] }>({
    queryKey: ["/api/knowledge/unanswered"],
  });
  const unansweredData = unansweredQuery.data;

  const feedbackQuery = useQuery<{ feedback: any[] }>({
    queryKey: ["/api/knowledge/feedback"],
  });
  const feedbackData = feedbackQuery.data;
  const unansweredState = readerState(unansweredQuery);
  const feedbackState = readerState(feedbackQuery);
  const sourcesState = readerState({ isLoading, isError: sourcesError, data: sourcesData });

  const createMutation = useMutation({
    mutationFn: (data: { title: string; audience: string; content: string; status: string }) =>
      apiRequest("POST", "/api/knowledge/sources", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/sources"] });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/stats"] });
      setNewSourceOpen(false);
      setForm({ title: "", audience: "public", content: "" });
      toast({ title: "Source created", description: "Knowledge source added successfully." });
    },
    onError: () => toast({ title: "Error", description: "Failed to create source.", variant: "destructive" }),
  });

  const publishMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/knowledge/sources/${id}/publish`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/sources"] });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/stats"] });
      toast({ title: "Published", description: "Source is now live." });
    },
    onError: () => toast({ title: "Error", description: "Publish failed.", variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/knowledge/sources/${id}/archive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/sources"] });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/stats"] });
      toast({ title: "Archived" });
    },
    onError: () => toast({ title: "Archive failed", description: "The source was not archived. It is unchanged; try again.", variant: "destructive" }),
  });

  const indexMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/knowledge/sources/${id}/index`);
      return decodeJsonResponse(res, isIndexReceipt, "Index");
    },
    onSuccess: (receipt, id) => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/sources"] });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/stats"] });
      toast({ title: "Indexed", description: `Source ${id}: ${receipt.chunksWritten} chunk${receipt.chunksWritten === 1 ? "" : "s"} written.` });
    },
    onError: (e: Error) => toast({ title: "Index failed", description: e.message || "The source was not indexed.", variant: "destructive" }),
  });

  const reindexMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/knowledge/reindex");
      return decodeJsonResponse(res, isReindexReceipt, "Re-index");
    },
    onSuccess: (receipt) => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/sources"] });
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/stats"] });
      toast({ title: "Re-indexed", description: `${receipt.sources} sources, ${receipt.chunks} chunks.` });
    },
    onError: (e: Error) => toast({ title: "Re-index failed", description: e.message, variant: "destructive" }),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) =>
      apiRequest("POST", `/api/knowledge/unanswered/${id}/resolve`, { note }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge/unanswered"] });
      toast({ title: "Marked resolved" });
    },
    onError: () => toast({ title: "Could not mark resolved", description: "The question is still open; try again.", variant: "destructive" }),
  });

  const sources = sourcesData?.sources ?? [];
  const stats = statsData;
  const unanswered = unansweredData?.questions ?? [];
  const feedback = feedbackData?.feedback ?? [];

  return (
    <CrmPage className="space-y-6" data-testid="knowledge-admin-page">
      <ResourcesNav current="/dashboard/knowledge-admin" />
      {/* Header */}
      <div className="flex items-center justify-between">
        <CrmPageHeader title="Knowledge Base Admin" icon={<BookOpen className="w-6 h-6" />}
          description="Manage the Liberty Bancard knowledge sources that ground the AI assistant." />
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => reindexMutation.mutate()}
            disabled={reindexMutation.isPending || !stats?.openaiConfigured}
            data-testid="button-reindex-all"
          >
            <RefreshCw className={cn("w-4 h-4 mr-1.5", reindexMutation.isPending && "animate-spin")} />
            Re-index All
          </Button>
          <Button size="sm" onClick={() => setNewSourceOpen(true)} data-testid="button-add-source">
            <Plus className="w-4 h-4 mr-1.5" />
            Add Source
          </Button>
        </div>
      </div>

      {/* Stats */}
      {statsError && <div role="alert" className="space-y-2">
        <p>Whole-library statistics unavailable.</p>
        <Button variant="outline" onClick={() => void retryStats()}>Retry statistics</Button>
      </div>}
      {stats && !statsError && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Total Sources", value: stats.totalSources, icon: <FileText className="w-4 h-4 text-muted-foreground" /> },
            { label: "Published", value: stats.publishedSources, icon: <CheckCircle2 className="w-4 h-4 text-emerald-500" /> },
            { label: "Indexed Chunks", value: stats.totalChunks, icon: <Layers className="w-4 h-4 text-primary" /> },
            {
              label: "OpenAI",
              value: stats.openaiConfigured ? "Configured" : "Not Set",
              icon: <Zap className={cn("w-4 h-4", stats.openaiConfigured ? "text-emerald-500" : "text-amber-500")} />,
            },
          ].map(s => (
            <Card key={s.label}>
              <CardContent className="p-4 flex items-center gap-3">
                {s.icon}
                <div>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className="font-bold text-lg leading-tight">{s.value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {stats && !statsError && !stats.openaiConfigured && (
        <div className="flex items-center gap-2 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-amber-800 dark:text-amber-200 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          OpenAI is not configured. Sources can be created and published, but embeddings will not be generated and AI retrieval will fall back to keyword search. Configure <code className="mx-1 text-xs bg-amber-100 dark:bg-amber-900/40 px-1 py-0.5 rounded">AI_INTEGRATIONS_OPENAI_API_KEY</code> to enable semantic search.
        </div>
      )}

      <Tabs value={tabSelection.value} onValueChange={(v) => tabSelection.setValue(v as typeof knowledgeAdminViews[number])}>
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="sources" data-testid="tab-sources">Sources ({sourcesState === "unavailable" ? "unavailable" : sourcesState === "loading" ? "loading" : sources.length})</TabsTrigger>
          <TabsTrigger value="unanswered" data-testid="tab-unanswered">
            Unanswered {unansweredState === "unavailable" ? "(unavailable)" : unanswered.length > 0 && <Badge variant="destructive" className="ml-1 h-4 text-[10px]">{unanswered.length}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="feedback" data-testid="tab-feedback">Feedback</TabsTrigger>
        </TabsList>

        {/* Sources tab */}
        <TabsContent value="sources" className="mt-4">
          <p className="text-xs text-muted-foreground">Statistics above cover the whole library. This list shows all sources.</p>
          {sourcesState === "unavailable" ? (
            <div role="alert" className="py-6 space-y-3">
              <p>Knowledge sources are unavailable. This is not an empty library.</p>
              <Button variant="outline" onClick={() => void retrySources()}>Retry sources</Button>
            </div>
          ) : sourcesState === "loading" ? (
            <div className="text-center py-8 text-muted-foreground text-sm">Loading sources…</div>
          ) : sources.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p>No knowledge sources yet.</p>
              <p className="text-xs mt-1">Add sources to ground the AI assistant in Liberty Bancard content.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {sourcesState === "stale" && (
                <div role="alert" className="flex items-center gap-3 text-sm text-amber-800 dark:text-amber-200">
                  <span>Showing the last loaded sources; refreshing failed.</span>
                  <Button size="sm" variant="outline" onClick={() => void retrySources()}>Retry sources</Button>
                </div>
              )}
              {sources.map(src => (
                <Card key={src.id} className="hover:shadow-sm transition-shadow" data-testid={`source-card-${src.id}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm truncate">{src.title}</span>
                          <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full font-medium", STATUS_COLORS[src.status])}>
                            {src.status}
                          </span>
                          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground border rounded px-1 py-0.5">
                            {AUDIENCE_ICONS[src.audience] ?? <Globe className="w-3 h-3" />}
                            {src.audience}
                          </span>
                          <span className="text-[10px] text-muted-foreground">v{src.version}</span>
                        </div>
                        <div className="flex gap-3 mt-1 text-[10px] text-muted-foreground">
                          {src.lastIndexedAt && (
                            <span className="flex items-center gap-0.5">
                              <CheckCircle2 className="w-2.5 h-2.5 text-emerald-500" />
                              Indexed {new Date(src.lastIndexedAt).toLocaleDateString()}
                            </span>
                          )}
                          {!src.lastIndexedAt && src.status === "published" && (
                            <span className="flex items-center gap-0.5 text-amber-600">
                              <Clock className="w-2.5 h-2.5" /> Not indexed
                            </span>
                          )}
                          <span>Updated {new Date(src.updatedAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                        {src.status === "draft" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => publishMutation.mutate(src.id)}
                            disabled={publishMutation.isPending}
                            data-testid={`button-publish-${src.id}`}
                          >
                            Publish
                          </Button>
                        )}
                        {src.status === "published" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => indexMutation.mutate(src.id)}
                            disabled={indexMutation.isPending || !stats?.openaiConfigured}
                            data-testid={`button-index-${src.id}`}
                          >
                            <RefreshCw className={cn("w-3 h-3 mr-1", indexMutation.isPending && "animate-spin")} />
                            Re-index
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => setEditSource(src)}
                          data-testid={`button-view-${src.id}`}
                        >
                          <Eye className="w-3 h-3 mr-1" />
                          View
                        </Button>
                        {src.status !== "archived" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-muted-foreground"
                            onClick={() => archiveMutation.mutate(src.id)}
                            aria-label={`Archive source ${src.title ?? src.id}`}
                            data-testid={`button-archive-${src.id}`}
                          >
                            <Archive className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Unanswered tab */}
        <TabsContent value="unanswered" className="mt-4">
          {unansweredState === "loading" ? (
            <CrmDataState state="loading" message="Loading unanswered questions…" />
          ) : unansweredState === "unavailable" ? (
            <CrmDataState state="unavailable" message="Unanswered questions are unavailable. This is not an empty review queue." onRetry={() => void unansweredQuery.refetch()} />
          ) : unanswered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <HelpCircle className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p>No unanswered questions.</p>
              <p className="text-xs mt-1">Questions the AI couldn't answer well will appear here for review.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {unansweredState === "stale" && (
                <div role="alert" className="flex items-center gap-3 text-sm text-amber-800 dark:text-amber-200">
                  <span>Showing the last loaded questions; refreshing failed.</span>
                  <Button size="sm" variant="outline" onClick={() => void unansweredQuery.refetch()}>Retry</Button>
                </div>
              )}
              {unanswered.map((q: any) => (
                <Card key={q.id} data-testid={`unanswered-${q.id}`}>
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-[10px]">{q.audience}</Badge>
                      <span>{new Date(q.created_at).toLocaleString()}</span>
                    </div>
                    <p className="text-sm font-medium">"{q.question}"</p>
                    {q.ai_response && (
                      <p className="text-xs text-muted-foreground border-l-2 pl-2 italic">{q.ai_response.slice(0, 200)}…</p>
                    )}
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => resolveMutation.mutate({ id: q.id, note: "Reviewed — no action needed" })}
                        data-testid={`button-resolve-${q.id}`}
                      >
                        Mark Resolved
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => {
                          setForm({ title: `FAQ: ${q.question.slice(0, 60)}`, audience: q.audience, content: "" });
                          setNewSourceOpen(true);
                        }}
                        data-testid={`button-create-from-${q.id}`}
                      >
                        <Plus className="w-3 h-3 mr-1" />
                        Create Source
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Feedback tab */}
        <TabsContent value="feedback" className="mt-4">
          {feedbackState === "loading" ? (
            <CrmDataState state="loading" message="Loading feedback…" />
          ) : feedbackState === "unavailable" ? (
            <CrmDataState state="unavailable" message="Feedback is unavailable. This is not an empty feedback list." onRetry={() => void feedbackQuery.refetch()} />
          ) : feedback.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">No feedback yet.</div>
          ) : (
            <div className="space-y-2">
              {feedbackState === "stale" && (
                <div role="alert" className="flex items-center gap-3 text-sm text-amber-800 dark:text-amber-200">
                  <span>Showing the last loaded feedback; refreshing failed.</span>
                  <Button size="sm" variant="outline" onClick={() => void feedbackQuery.refetch()}>Retry</Button>
                </div>
              )}
              {feedback.map((f: any) => (
                <Card key={f.id}>
                  <CardContent className="p-3 flex items-start gap-3">
                    <div className={cn("mt-0.5", f.rating === "thumbs_up" ? "text-emerald-500" : "text-red-500")}>
                      {f.rating === "thumbs_up" ? <ThumbsUp className="w-4 h-4" /> : <ThumbsDown className="w-4 h-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-muted-foreground">{new Date(f.created_at).toLocaleString()}</p>
                      {f.message_content && (
                        <p className="text-sm mt-0.5 line-clamp-2">{f.message_content}</p>
                      )}
                      {f.comment && (
                        <p className="text-xs text-muted-foreground mt-0.5 italic">"{f.comment}"</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Add Source Dialog */}
      <Dialog open={newSourceOpen} onOpenChange={setNewSourceOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Knowledge Source</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label htmlFor={titleId} className="text-sm font-medium">Title <span aria-hidden="true">*</span></label>
              <Input
                id={titleId}
                required
                aria-required="true"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g., FAQ: Chargeback Prevention"
                className="mt-1"
                data-testid="input-source-title"
              />
            </div>
            <div>
              <label htmlFor={audienceId} className="text-sm font-medium">Audience</label>
              <Select value={form.audience} onValueChange={v => setForm(f => ({ ...f, audience: v }))}>
                <SelectTrigger id={audienceId} className="mt-1" data-testid="select-source-audience">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="public">Public — visible to all visitors</SelectItem>
                  <SelectItem value="merchant">Merchant — authenticated merchants only</SelectItem>
                  <SelectItem value="staff">Staff — authorized staff only</SelectItem>
                  <SelectItem value="all">All — all authenticated users</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor={contentId} className="text-sm font-medium">Content <span aria-hidden="true">*</span></label>
              <Textarea
                id={contentId}
                required
                aria-required="true"
                aria-describedby={contentHelpId}
                value={form.content}
                onChange={e => setForm(f => ({ ...f, content: e.target.value }))}
                placeholder="Paste or type the approved Liberty Bancard content here…"
                className="crm-prose-editor mt-1"
                data-testid="textarea-source-content"
              />
              <p id={contentHelpId} className="text-xs text-muted-foreground mt-1">{form.content.length.toLocaleString()} characters. Saved as a draft; nothing is published until you publish it.</p>
              {createMutation.isError && (
                <p role="alert" className="text-sm text-destructive mt-2">The source was not created. Your text is kept; fix the problem and try again.</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewSourceOpen(false)}>Cancel</Button>
            <Button
              onClick={() => createMutation.mutate({ ...form, status: "draft" })}
              disabled={createMutation.isPending || !form.title || !form.content}
              data-testid="button-create-source"
            >
              {createMutation.isPending ? "Creating…" : "Create Draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View/Edit Source Dialog */}
      {editSource && (
        <Dialog open={!!editSource} onOpenChange={() => setEditSource(null)}>
          <DialogContent className="max-w-2xl max-h-[80vh]">
            <DialogHeader>
              <DialogTitle>{editSource.title}</DialogTitle>
            </DialogHeader>
            <div className="overflow-y-auto space-y-3">
              <div className="flex gap-2 flex-wrap">
                <Badge variant="outline">{editSource.status}</Badge>
                <Badge variant="outline">{editSource.audience}</Badge>
                <Badge variant="outline">v{editSource.version}</Badge>
                {editSource.lastIndexedAt && (
                  <Badge variant="outline" className="text-emerald-700">
                    <CheckCircle2 className="w-3 h-3 mr-1" />
                    Indexed {new Date(editSource.lastIndexedAt).toLocaleDateString()}
                  </Badge>
                )}
              </div>
              <div className="bg-muted rounded-lg p-3 text-sm leading-5 whitespace-pre-wrap max-h-[400px] overflow-y-auto">
                {editSource.content ?? "Content not loaded."}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditSource(null)}>Close</Button>
              {editSource.status === "draft" && (
                <Button
                  onClick={() => { publishMutation.mutate(editSource.id); setEditSource(null); }}
                  disabled={publishMutation.isPending}
                >
                  Publish
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </CrmPage>
  );
}
