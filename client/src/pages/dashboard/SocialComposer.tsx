import { PageTitle } from "@/components/ui/page-header";
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
import { Loader2, Sparkles, Linkedin, Trash2, Copy, Send, Calendar, Edit3, Plus, ArrowLeft, Check } from "lucide-react";

const PILLARS = ["Cost & Pricing", "Programs", "Industry", "Compliance & Security"] as const;
const TONES = ["educational", "story", "data", "contrarian", "community"] as const;

interface SocialPost {
  id: number;
  platform: string;
  body: string;
  hashtags: string[] | null;
  linkUrl: string | null;
  status: string;
  pillar: string | null;
  cluster: string | null;
  authorName: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  externalPostUrl: string | null;
  createdAt: string;
}

export default function SocialComposer() {
  const { toast } = useToast();
  const [tab, setTab] = useState("drafts");
  const [editingId, setEditingId] = useState<number | null>(null);

  // Generate state
  const [genPillar, setGenPillar] = useState<string>("Cost & Pricing");
  const [genTopic, setGenTopic] = useState("");
  const [genTone, setGenTone] = useState<string>("educational");
  const [genLink, setGenLink] = useState("");
  const [genCount, setGenCount] = useState(1);

  // Manual compose
  const [body, setBody] = useState("");
  const [hashtagsInput, setHashtagsInput] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [composeStatus, setComposeStatus] = useState("draft");
  const [composePillar, setComposePillar] = useState<string>("Cost & Pricing");
  const [composeScheduledAt, setComposeScheduledAt] = useState("");

  const postsQuery = useQuery<SocialPost[]>({
    queryKey: ["/api/social/posts"],
  });
  const posts = postsQuery.data ?? [];
  const postsState = readerState(postsQuery);

  const editingPost = editingId ? posts.find((p) => p.id === editingId) : null;

  const generateMutation = useMutation({
    mutationFn: async () => apiRequest("POST", "/api/social/generate", {
      pillar: genPillar,
      topic: genTopic,
      tone: genTone,
      linkUrl: genLink || undefined,
      count: genCount,
    }),
    onSuccess: () => {
      toast({ title: "Drafts generated" });
      queryClient.invalidateQueries({ queryKey: ["/api/social/posts"] });
      setTab("drafts");
      setGenTopic("");
    },
    onError: (err: any) => toast({ title: "Generation failed", description: err.message || String(err), variant: "destructive" }),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const tags = hashtagsInput.split(",").map(s => s.trim()).filter(Boolean);
      const body0: any = {
        platform: "linkedin",
        body,
        hashtags: tags.length > 0 ? tags : undefined,
        linkUrl: linkUrl || undefined,
        pillar: composePillar,
        status: composeStatus,
      };
      if (composeStatus === "scheduled" && composeScheduledAt) {
        body0.scheduledAt = new Date(composeScheduledAt).toISOString();
      }
      return apiRequest("POST", "/api/social/posts", body0);
    },
    onSuccess: () => {
      toast({ title: "Post saved" });
      setBody(""); setHashtagsInput(""); setLinkUrl(""); setComposeScheduledAt("");
      queryClient.invalidateQueries({ queryKey: ["/api/social/posts"] });
      setTab("drafts");
    },
    onError: (err: any) => toast({ title: "Save failed", description: err.message || String(err), variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: any }) => apiRequest("PATCH", `/api/social/posts/${id}`, updates),
    onSuccess: () => {
      toast({ title: "Updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/social/posts"] });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("POST", `/api/social/posts/${id}/publish`, {}),
    onSuccess: (_d: any) => {
      toast({ title: "Marked published", description: "Use Copy and post to LinkedIn manually if needed." });
      queryClient.invalidateQueries({ queryKey: ["/api/social/posts"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => apiRequest("DELETE", `/api/social/posts/${id}`, undefined),
    onSuccess: () => {
      toast({ title: "Deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/social/posts"] });
      setEditingId(null);
    },
  });

  const counts = {
    drafts: posts.filter(p => p.status === "draft" || p.status === "needs_review").length,
    scheduled: posts.filter(p => p.status === "scheduled").length,
    published: posts.filter(p => p.status === "published" || p.status === "ready_to_publish").length,
  };

  const copyPost = async (p: SocialPost) => {
    const text = p.body + (p.hashtags && p.hashtags.length ? "\n\n" + p.hashtags.map(h => h.startsWith("#") ? h : "#" + h).join(" ") : "");
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({ title: "Copy failed", variant: "destructive" });
    }
  };

  if (editingPost) {
    return <EditingForm post={editingPost} onBack={() => setEditingId(null)} onSave={(u) => updateMutation.mutate({ id: editingPost.id, updates: u })} saving={updateMutation.isPending} />;
  }

  return (
    <div className="space-y-6">
      <div>
        <PageTitle className="text-2xl font-bold flex items-center gap-2" data-testid="text-social-heading">
          <Linkedin className="w-6 h-6 text-[#0A66C2]" /> LinkedIn Composer
        </PageTitle>
        <p className="text-muted-foreground mt-1">Draft, schedule, and track LinkedIn posts. Approved posts can be copied to clipboard or auto-published when LinkedIn API is enabled.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card><CardContent className="pt-6 text-center">
          <div className="text-3xl font-bold" data-testid="text-soc-drafts">{counts.drafts}</div>
          <div className="text-sm text-muted-foreground">Drafts</div>
        </CardContent></Card>
        <Card><CardContent className="pt-6 text-center">
          <div className="text-3xl font-bold text-blue-600" data-testid="text-soc-scheduled">{counts.scheduled}</div>
          <div className="text-sm text-muted-foreground">Scheduled</div>
        </CardContent></Card>
        <Card><CardContent className="pt-6 text-center">
          <div className="text-3xl font-bold text-green-600" data-testid="text-soc-published">{counts.published}</div>
          <div className="text-sm text-muted-foreground">Published / Ready</div>
        </CardContent></Card>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="drafts" data-testid="tab-drafts">Queue</TabsTrigger>
          <TabsTrigger value="compose" data-testid="tab-compose">Compose</TabsTrigger>
          <TabsTrigger value="ai" data-testid="tab-ai">AI Generate</TabsTrigger>
        </TabsList>

        <TabsContent value="drafts" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-lg">All posts ({postsState === "ready" || postsState === "stale" ? posts.length : "—"})</CardTitle></CardHeader>
            <CardContent>
              {postsState === "loading" || postsState === "unavailable" ? (
                <ReaderStatus state={postsState} subject="Posts" onRetry={() => void postsQuery.refetch()} />
              ) : posts.length === 0 ? (
                <p className="text-muted-foreground text-center py-6" data-testid="text-no-social">No LinkedIn posts yet.</p>
              ) : (
                <div className="space-y-3">
                  <ReaderStatus state={postsState} subject="Posts" onRetry={() => void postsQuery.refetch()} />
                  {posts.map(p => (
                    <div key={p.id} className="p-3 border rounded-lg" data-testid={`row-social-${p.id}`}>
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex flex-wrap gap-1.5 items-center text-xs">
                          <SocialBadge status={p.status} />
                          {p.pillar && <Badge variant="outline">{p.pillar}</Badge>}
                          {p.scheduledAt && <span className="text-muted-foreground">Sched: {new Date(p.scheduledAt).toLocaleString()}</span>}
                          {p.publishedAt && <span className="text-muted-foreground">Pub: {new Date(p.publishedAt).toLocaleDateString()}</span>}
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <Button size="icon" variant="ghost" aria-label="Copy post" onClick={() => copyPost(p)} title="Copy" data-testid={`button-copy-${p.id}`}>
                            <Copy className="w-4 h-4" />
                          </Button>
                          <Button size="icon" variant="ghost" aria-label="Edit post" onClick={() => setEditingId(p.id)} data-testid={`button-edit-soc-${p.id}`}>
                            <Edit3 className="w-4 h-4" />
                          </Button>
                          {p.status !== "published" && (
                            <Button size="icon" variant="ghost" aria-label="Mark published" onClick={() => publishMutation.mutate(p.id)} title="Mark published" data-testid={`button-pub-${p.id}`}>
                              <Send className="w-4 h-4" />
                            </Button>
                          )}
                          <Button size="icon" variant="ghost" aria-label="Delete post" onClick={() => { if (confirm("Delete?")) deleteMutation.mutate(p.id); }} className="text-destructive" data-testid={`button-del-${p.id}`}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      <p className="text-sm whitespace-pre-wrap" data-testid={`text-body-${p.id}`}>{p.body}</p>
                      {p.hashtags && p.hashtags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {p.hashtags.map((h, i) => <Badge key={i} variant="secondary" className="text-xs">{h.startsWith("#") ? h : "#" + h}</Badge>)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="compose" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-lg flex gap-2 items-center"><Plus className="w-5 h-5" /> Compose new LinkedIn post</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Pillar</Label>
                  <Select value={composePillar} onValueChange={setComposePillar}>
                    <SelectTrigger data-testid="select-compose-pillar"><SelectValue /></SelectTrigger>
                    <SelectContent>{PILLARS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Status</Label>
                  <Select value={composeStatus} onValueChange={setComposeStatus}>
                    <SelectTrigger data-testid="select-compose-status"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="needs_review">Needs Review</SelectItem>
                      <SelectItem value="scheduled">Scheduled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Body ({body.length} chars)</Label>
                <Textarea
                  rows={8}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write your LinkedIn post. Hook in line 1, 2-4 short paragraphs separated by single line breaks, one soft CTA."
                  data-testid="input-body"
                />
              </div>
              <div>
                <Label>Hashtags (comma separated)</Label>
                <Input value={hashtagsInput} onChange={(e) => setHashtagsInput(e.target.value)} placeholder="payments, smallbusiness" data-testid="input-hashtags" />
              </div>
              <div>
                <Label>Link URL (optional)</Label>
                <Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://libertybancard.com/blog/..." data-testid="input-link" />
              </div>
              {composeStatus === "scheduled" && (
                <div>
                  <Label>Schedule for</Label>
                  <Input type="datetime-local" value={composeScheduledAt} onChange={(e) => setComposeScheduledAt(e.target.value)} data-testid="input-compose-schedule" />
                </div>
              )}
              <Button
                disabled={!body || createMutation.isPending}
                onClick={() => createMutation.mutate()}
                className="gap-2"
                data-testid="button-create-post"
              >
                {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Save post
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ai" className="mt-4">
          <Card>
            <CardHeader><CardTitle className="text-lg flex gap-2 items-center"><Sparkles className="w-5 h-5 text-primary" /> AI generate drafts</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Pillar</Label>
                  <Select value={genPillar} onValueChange={setGenPillar}>
                    <SelectTrigger data-testid="select-gen-pillar"><SelectValue /></SelectTrigger>
                    <SelectContent>{PILLARS.map(p => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Tone</Label>
                  <Select value={genTone} onValueChange={setGenTone}>
                    <SelectTrigger data-testid="select-gen-tone"><SelectValue /></SelectTrigger>
                    <SelectContent>{TONES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>Topic</Label>
                <Input value={genTopic} onChange={(e) => setGenTopic(e.target.value)} placeholder="e.g., why effective rate matters more than quoted rate" data-testid="input-gen-topic" />
              </div>
              <div>
                <Label>Optional link</Label>
                <Input value={genLink} onChange={(e) => setGenLink(e.target.value)} placeholder="https://libertybancard.com/blog/..." data-testid="input-gen-link" />
              </div>
              <div>
                <Label>How many drafts? ({genCount})</Label>
                <Input type="number" min={1} max={5} value={genCount} onChange={(e) => setGenCount(Math.min(5, Math.max(1, Number(e.target.value) || 1)))} data-testid="input-gen-count" />
              </div>
              <Button
                disabled={!genTopic || generateMutation.isPending}
                onClick={() => generateMutation.mutate()}
                className="w-full gap-2"
                data-testid="button-generate-social"
              >
                {generateMutation.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating...</> : <><Sparkles className="w-4 h-4" /> Generate {genCount} draft{genCount > 1 ? "s" : ""}</>}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SocialBadge({ status }: { status: string }) {
  const map: Record<string, { variant: any; label: string }> = {
    draft: { variant: "outline", label: "Draft" },
    needs_review: { variant: "secondary", label: "Review" },
    scheduled: { variant: "secondary", label: "Scheduled" },
    ready_to_publish: { variant: "secondary", label: "Ready" },
    published: { variant: "default", label: "Published" },
    archived: { variant: "outline", label: "Archived" },
  };
  const m = map[status] || { variant: "outline", label: status };
  return <Badge variant={m.variant} className="text-xs">{m.label}</Badge>;
}

function EditingForm({ post, onBack, onSave, saving }: { post: SocialPost; onBack: () => void; onSave: (u: any) => void; saving: boolean }) {
  const [body, setBody] = useState(post.body);
  const [hashtags, setHashtags] = useState((post.hashtags || []).join(", "));
  const [linkUrl, setLinkUrl] = useState(post.linkUrl || "");
  const [scheduledAt, setScheduledAt] = useState(post.scheduledAt ? new Date(post.scheduledAt).toISOString().slice(0, 16) : "");
  const [status, setStatus] = useState(post.status);

  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack} className="gap-2" data-testid="button-back-soc">
        <ArrowLeft className="w-4 h-4" /> Back
      </Button>
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div>
            <Label>Body ({body.length} chars)</Label>
            <Textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} data-testid="input-edit-body" />
          </div>
          <div>
            <Label>Hashtags</Label>
            <Input value={hashtags} onChange={(e) => setHashtags(e.target.value)} data-testid="input-edit-tags" />
          </div>
          <div>
            <Label>Link URL</Label>
            <Input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} data-testid="input-edit-link" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger data-testid="select-edit-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="needs_review">Needs Review</SelectItem>
                  <SelectItem value="scheduled">Scheduled</SelectItem>
                  <SelectItem value="published">Published</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Scheduled for</Label>
              <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} data-testid="input-edit-schedule" />
            </div>
          </div>
          <Button
            disabled={saving}
            onClick={() => onSave({
              body,
              hashtags: hashtags.split(",").map(s => s.trim()).filter(Boolean),
              linkUrl: linkUrl || null,
              status,
              scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
            })}
            className="gap-2"
            data-testid="button-save-soc"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />} Save
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
