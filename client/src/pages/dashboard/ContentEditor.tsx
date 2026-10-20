import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ReaderStatus } from "@/components/dashboard/ReaderStatus";
import { readerState } from "@/lib/reader-state";
import { Loader2, Sparkles, Send, Calendar, Trash2, Eye, FileText, Edit3, ArrowLeft } from "lucide-react";

const PILLARS = ["Cost & Pricing", "Programs", "Industry", "Compliance & Security"] as const;
const CATEGORIES = ["Education", "Cost Savings", "Industry", "Programs", "Getting Started", "Technology", "Compliance", "Security"] as const;

interface Post {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  author: string;
  authorId?: number | null;
  readTime: string;
  status: string;
  pillar?: string | null;
  cluster?: string | null;
  seoTitle?: string | null;
  metaDescription: string;
  keywords: string;
  content: any[];
  faqs?: any[] | null;
  scheduledAt?: string | null;
  publishedAt?: string | null;
  createdAt: string;
  reviewerNotes?: string | null;
}

interface Author {
  id: number;
  slug: string;
  name: string;
  title: string;
}

export default function ContentEditor() {
  const { toast } = useToast();
  const [tab, setTab] = useState("queue");
  const [editingId, setEditingId] = useState<number | null>(null);

  // AI draft form state
  const [pillar, setPillar] = useState<string>("Cost & Pricing");
  const [cluster, setCluster] = useState("");
  const [topic, setTopic] = useState("");
  const [keywordInput, setKeywordInput] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [category, setCategory] = useState("Education");
  const [audience, setAudience] = useState("");

  const postsQuery = useQuery<Post[]>({
    queryKey: ["/api/content/posts"],
  });
  const posts = postsQuery.data ?? [];
  const postsState = readerState(postsQuery);
  const authorsQuery = useQuery<Author[]>({
    queryKey: ["/api/authors"],
  });
  const authors = authorsQuery.data ?? [];

  const editingPost = editingId ? posts.find((p) => p.id === editingId) || null : null;

  const draftMutation = useMutation({
    mutationFn: async () => {
      const body = {
        pillar,
        cluster: cluster || undefined,
        topic,
        keywords,
        category,
        audience: audience || undefined,
      };
      return await apiRequest("POST", "/api/content/draft", body);
    },
    onSuccess: () => {
      toast({ title: "Draft created", description: "Saved with status: needs_review" });
      queryClient.invalidateQueries({ queryKey: ["/api/content/posts"] });
      setTab("queue");
      setTopic("");
      setKeywords([]);
    },
    onError: (err: any) => toast({ title: "Draft failed", description: err.message || String(err), variant: "destructive" }),
  });

  const transitionMutation = useMutation({
    mutationFn: async ({ id, status, scheduledAt }: { id: number; status: string; scheduledAt?: string }) => {
      return await apiRequest("POST", `/api/content/posts/${id}/transition`, { status, scheduledAt });
    },
    onSuccess: (_d, vars) => {
      toast({ title: `Post moved to ${vars.status}` });
      queryClient.invalidateQueries({ queryKey: ["/api/content/posts"] });
    },
    onError: (err: any) => toast({ title: "Transition failed", description: err.message || String(err), variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: Partial<Post> }) => {
      return await apiRequest("PATCH", `/api/content/posts/${id}`, updates);
    },
    onSuccess: () => {
      toast({ title: "Saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/content/posts"] });
    },
    onError: (err: any) => toast({ title: "Save failed", description: err.message || String(err), variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/blog/generated/${id}`, undefined),
    onSuccess: () => {
      toast({ title: "Post deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/content/posts"] });
      setEditingId(null);
    },
  });

  const counts = {
    drafts: posts.filter((p) => p.status === "draft").length,
    needsReview: posts.filter((p) => p.status === "needs_review").length,
    scheduled: posts.filter((p) => p.status === "scheduled").length,
    published: posts.filter((p) => p.status === "published").length,
  };

  const addKeyword = () => {
    const k = keywordInput.trim();
    if (k && !keywords.includes(k)) setKeywords([...keywords, k]);
    setKeywordInput("");
  };

  if (editingPost) {
    return (
      <ContentEditorForm
        post={editingPost}
        authors={authors}
        onBack={() => setEditingId(null)}
        onSave={(updates) => updateMutation.mutate({ id: editingPost.id, updates })}
        onTransition={(status, scheduledAt) => transitionMutation.mutate({ id: editingPost.id, status, scheduledAt })}
        onDelete={() => deleteMutation.mutate(editingPost.id)}
        saving={updateMutation.isPending}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground" data-testid="text-content-heading">Content Engine</h2>
        <p className="text-muted-foreground mt-1">Editorial workflow for blog posts. Drafts → review → schedule → publish.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card><CardContent className="pt-6 text-center">
          <div className="text-3xl font-bold" data-testid="text-count-drafts">{counts.drafts}</div>
          <div className="text-sm text-muted-foreground">Drafts</div>
        </CardContent></Card>
        <Card><CardContent className="pt-6 text-center">
          <div className="text-3xl font-bold text-amber-600" data-testid="text-count-review">{counts.needsReview}</div>
          <div className="text-sm text-muted-foreground">Needs Review</div>
        </CardContent></Card>
        <Card><CardContent className="pt-6 text-center">
          <div className="text-3xl font-bold text-blue-600" data-testid="text-count-scheduled">{counts.scheduled}</div>
          <div className="text-sm text-muted-foreground">Scheduled</div>
        </CardContent></Card>
        <Card><CardContent className="pt-6 text-center">
          <div className="text-3xl font-bold text-green-600" data-testid="text-count-published">{counts.published}</div>
          <div className="text-sm text-muted-foreground">Published</div>
        </CardContent></Card>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="queue" data-testid="tab-queue">Editorial Queue</TabsTrigger>
          <TabsTrigger value="ai" data-testid="tab-ai-draft">AI-Assist Draft</TabsTrigger>
        </TabsList>

        <TabsContent value="queue" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-lg">All Posts ({postsState === "ready" || postsState === "stale" ? posts.length : "—"})</CardTitle></CardHeader>
            <CardContent>
              {postsState === "loading" || postsState === "unavailable" ? (
                <ReaderStatus state={postsState} subject="Posts" onRetry={() => void postsQuery.refetch()} />
              ) : posts.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center" data-testid="text-no-posts">No posts yet. Use AI-Assist Draft to generate one.</p>
              ) : (
                <div className="space-y-2">
                  <ReaderStatus state={postsState} subject="Posts" onRetry={() => void postsQuery.refetch()} />
                  {posts.map((p) => (
                    <div key={p.id} className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/30" data-testid={`row-content-${p.id}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-sm truncate">{p.title}</span>
                          <StatusBadge status={p.status} />
                          {p.pillar && <Badge variant="outline" className="text-xs">{p.pillar}</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground flex gap-3">
                          <span>{p.author}</span>
                          <span>{p.readTime}</span>
                          {p.scheduledAt && <span>Scheduled: {new Date(p.scheduledAt).toLocaleString()}</span>}
                          {p.publishedAt && <span>Published: {new Date(p.publishedAt).toLocaleDateString()}</span>}
                        </div>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {p.status === "published" && (
                          <Button size="icon" variant="ghost" aria-label="View post" onClick={() => window.open(`/blog/${p.slug}`, "_blank")} data-testid={`button-view-${p.id}`}>
                            <Eye className="w-4 h-4" />
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" aria-label="Edit post" onClick={() => setEditingId(p.id)} data-testid={`button-edit-${p.id}`}>
                          <Edit3 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ai" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-lg flex gap-2 items-center"><Sparkles className="w-5 h-5 text-primary" />AI-Assist Draft</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label>Pillar</Label>
                  <Select value={pillar} onValueChange={setPillar}>
                    <SelectTrigger data-testid="select-pillar"><SelectValue /></SelectTrigger>
                    <SelectContent>{PILLARS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Category</Label>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger data-testid="select-cat"><SelectValue /></SelectTrigger>
                    <SelectContent>{CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label>Cluster (topic group, optional)</Label>
                <Input value={cluster} onChange={(e) => setCluster(e.target.value)} placeholder="e.g., Effective Rate, Med Spas" data-testid="input-cluster" />
              </div>

              <div>
                <Label>Topic / working title</Label>
                <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="How to read your processing statement" data-testid="input-topic" />
              </div>

              <div>
                <Label>Target keywords</Label>
                <div className="flex gap-2">
                  <Input
                    value={keywordInput}
                    onChange={(e) => setKeywordInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addKeyword(); } }}
                    placeholder="Add a keyword and press Enter"
                    data-testid="input-keyword"
                  />
                  <Button variant="outline" onClick={addKeyword} data-testid="button-add-keyword">Add</Button>
                </div>
                {keywords.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {keywords.map((k) => (
                      <Badge key={k} variant="secondary" className="gap-1" data-testid={`badge-kw-${k}`}>
                        {k}
                        <button onClick={() => setKeywords(keywords.filter((x) => x !== k))} className="ml-1">×</button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <Label>Audience (optional)</Label>
                <Input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g., restaurant operators" data-testid="input-audience" />
              </div>

              <Button
                className="w-full gap-2"
                disabled={!topic || keywords.length === 0 || draftMutation.isPending}
                onClick={() => draftMutation.mutate()}
                data-testid="button-draft"
              >
                {draftMutation.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Drafting...</> : <><Sparkles className="w-4 h-4" /> Generate Draft (saves as needs_review)</>}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { variant: any; label: string }> = {
    draft: { variant: "outline", label: "Draft" },
    needs_review: { variant: "secondary", label: "Needs Review" },
    scheduled: { variant: "secondary", label: "Scheduled" },
    published: { variant: "default", label: "Published" },
    archived: { variant: "outline", label: "Archived" },
  };
  const m = map[status] || { variant: "outline", label: status };
  return <Badge variant={m.variant} className="text-xs">{m.label}</Badge>;
}

function ContentEditorForm({
  post, authors, onBack, onSave, onTransition, onDelete, saving,
}: {
  post: Post;
  authors: Author[];
  onBack: () => void;
  onSave: (updates: Partial<Post>) => void;
  onTransition: (status: string, scheduledAt?: string) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState(post.title);
  const [excerpt, setExcerpt] = useState(post.excerpt);
  const [seoTitle, setSeoTitle] = useState(post.seoTitle || post.title);
  const [metaDescription, setMetaDescription] = useState(post.metaDescription);
  const [keywords, setKeywords] = useState(post.keywords);
  const [authorId, setAuthorId] = useState<string>(post.authorId ? String(post.authorId) : "");
  const [reviewerNotes, setReviewerNotes] = useState(post.reviewerNotes || "");
  const [contentJson, setContentJson] = useState(JSON.stringify(post.content, null, 2));
  const [scheduleAt, setScheduleAt] = useState("");

  const handleSave = () => {
    let content;
    try {
      content = JSON.parse(contentJson);
    } catch {
      toast({ title: "Invalid JSON", description: "Content JSON is not valid — fix syntax before saving.", variant: "destructive" });
      return;
    }
    const author = authors.find((a) => String(a.id) === authorId);
    onSave({
      title,
      excerpt,
      seoTitle,
      metaDescription,
      keywords,
      content,
      reviewerNotes,
      authorId: authorId ? Number(authorId) : null,
      author: author?.name || post.author,
    } as any);
  };

  const handleSchedule = () => {
    if (!scheduleAt) {
      toast({ title: "No date selected", description: "Pick a publish date and time before scheduling.", variant: "destructive" });
      return;
    }
    onTransition("scheduled", new Date(scheduleAt).toISOString());
  };

  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack} className="gap-2" data-testid="button-back">
        <ArrowLeft className="w-4 h-4" /> Back to queue
      </Button>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold" data-testid="text-edit-title">Edit: {post.title}</h2>
          <div className="text-sm text-muted-foreground mt-1 flex gap-2 items-center">
            <StatusBadge status={post.status} />
            {post.pillar && <Badge variant="outline">{post.pillar}</Badge>}
            <span>/{post.slug}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {post.status === "published" && (
            <Button variant="outline" onClick={() => window.open(`/blog/${post.slug}`, "_blank")} className="gap-2">
              <Eye className="w-4 h-4" /> View
            </Button>
          )}
          <Button variant="destructive" onClick={() => { if (confirm("Delete this post?")) onDelete(); }} className="gap-2" data-testid="button-delete">
            <Trash2 className="w-4 h-4" /> Delete
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="input-title" />
          </div>
          <div>
            <Label>SEO title (≤ 60 chars)</Label>
            <Input value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} data-testid="input-seo-title" />
            <p className="text-xs text-muted-foreground mt-1">{seoTitle.length} / 60 characters</p>
          </div>
          <div>
            <Label>Excerpt</Label>
            <Textarea rows={2} value={excerpt} onChange={(e) => setExcerpt(e.target.value)} data-testid="input-excerpt" />
          </div>
          <div>
            <Label>Meta description (≤ 160 chars)</Label>
            <Textarea rows={2} value={metaDescription} onChange={(e) => setMetaDescription(e.target.value)} data-testid="input-meta" />
            <p className="text-xs text-muted-foreground mt-1">{metaDescription.length} / 160 characters</p>
          </div>
          <div>
            <Label>Keywords (comma separated)</Label>
            <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} data-testid="input-keywords" />
          </div>
          <div>
            <Label>Author</Label>
            <Select value={authorId} onValueChange={setAuthorId}>
              <SelectTrigger data-testid="select-author"><SelectValue placeholder={post.author} /></SelectTrigger>
              <SelectContent>
                {authors.map((a) => (<SelectItem key={a.id} value={String(a.id)}>{a.name} — {a.title}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Reviewer notes</Label>
            <Textarea rows={3} value={reviewerNotes} onChange={(e) => setReviewerNotes(e.target.value)} placeholder="Editorial notes for the next reviewer or author" data-testid="input-notes" />
          </div>
          <div>
            <Label>Content (JSON sections array)</Label>
            <Textarea
              rows={16}
              value={contentJson}
              onChange={(e) => setContentJson(e.target.value)}
              className="font-mono text-xs"
              data-testid="input-content"
            />
            <p className="text-xs text-muted-foreground mt-1">Each section: {"{ type: 'paragraph'|'heading'|'list'|'cta'|'quote', ... }"}</p>
          </div>
          <Button onClick={handleSave} disabled={saving} className="gap-2" data-testid="button-save">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} Save changes
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-lg">Workflow transitions</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={() => onTransition("draft")} data-testid="button-state-draft">Move to Draft</Button>
            <Button variant="outline" onClick={() => onTransition("needs_review")} data-testid="button-state-review">Send for Review</Button>
            <Button variant="outline" onClick={() => onTransition("archived")} data-testid="button-state-archive">Archive</Button>
            <Button variant="default" onClick={() => onTransition("published")} className="gap-2" data-testid="button-publish">
              <Send className="w-4 h-4" /> Publish now
            </Button>
          </div>
          <div className="flex gap-2 items-end pt-2 border-t">
            <div className="flex-1">
              <Label>Schedule for</Label>
              <Input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
                data-testid="input-schedule"
              />
            </div>
            <Button onClick={handleSchedule} variant="secondary" className="gap-2" data-testid="button-schedule">
              <Calendar className="w-4 h-4" /> Schedule
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
