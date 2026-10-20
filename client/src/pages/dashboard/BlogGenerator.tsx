import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sparkles,
  FileText,
  Loader2,
  Plus,
  X,
  Send,
  Clock,
  CheckCircle,
  Trash2,
  Calendar,
  Eye,
  Mail,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ReaderStatus } from "@/components/dashboard/ReaderStatus";
import { readerState } from "@/lib/reader-state";
import { useQuery, useMutation } from "@tanstack/react-query";
import type { GeneratedBlogPostResponse } from "@/lib/all-blog-data";

const CATEGORIES = [
  "Education",
  "Cost Savings",
  "Industry",
  "Programs",
  "Getting Started",
  "Technology",
  "Compliance",
  "Security",
];

interface ArticleSignupRow {
  articleSlug: string;
  signupCount: number;
  lastSignupAt: string;
}

export default function BlogGenerator() {
  const { toast } = useToast();
  const [keyword, setKeyword] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [category, setCategory] = useState("Education");
  const [autoSchedule, setAutoSchedule] = useState(true);

  const signupsQuery = useQuery<ArticleSignupRow[]>({
    queryKey: ["/api/analytics/newsletter-article-signups"],
  });
  const articleSignups = signupsQuery.data ?? [];
  const signupsState = readerState(signupsQuery);

  const postsQuery = useQuery<GeneratedBlogPostResponse[]>({
    queryKey: ["/api/blog/generated"],
  });
  const savedPosts = postsQuery.data ?? [];
  const postsState = readerState(postsQuery);

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/blog/generate", {
        keywords,
        category,
        autoSchedule,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Blog post generated and saved" });
      setKeywords([]);
      queryClient.invalidateQueries({ queryKey: ["/api/blog/generated"] });
    },
    onError: (err: Error) => {
      toast({ title: "Generation failed", description: err.message, variant: "destructive" });
    },
  });

  const publishMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("PATCH", `/api/blog/generated/${id}/publish`, {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Post published" });
      queryClient.invalidateQueries({ queryKey: ["/api/blog/generated"] });
      queryClient.invalidateQueries({ queryKey: ["/api/blog/generated/published"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/blog/generated/${id}`, undefined);
    },
    onSuccess: () => {
      toast({ title: "Post deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/blog/generated"] });
    },
  });

  const addKeyword = () => {
    const trimmed = keyword.trim();
    if (trimmed && !keywords.includes(trimmed)) {
      setKeywords([...keywords, trimmed]);
      setKeyword("");
    }
  };

  const removeKeyword = (k: string) => {
    setKeywords(keywords.filter((kw) => kw !== k));
  };

  const drafts = savedPosts.filter((p) => p.status === "draft");
  const scheduled = savedPosts.filter((p) => p.status === "scheduled");
  const published = savedPosts.filter((p) => p.status === "published");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground" data-testid="text-blog-gen-heading">
          AI Blog Generator
        </h2>
        <p className="text-muted-foreground mt-1" data-testid="text-blog-gen-subtitle">
          Generate SEO-optimized blog posts and schedule them for automatic publication. Posts are saved to the database and auto-published on schedule.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6 text-center">
            <div className="text-3xl font-bold text-foreground" data-testid="text-draft-count">{drafts.length}</div>
            <div className="text-sm text-muted-foreground">Drafts</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <div className="text-3xl font-bold text-blue-600" data-testid="text-scheduled-count">{scheduled.length}</div>
            <div className="text-sm text-muted-foreground">Scheduled</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <div className="text-3xl font-bold text-green-600" data-testid="text-published-count">{published.length}</div>
            <div className="text-sm text-muted-foreground">Published</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-primary" />
              Generate New Post
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Target Keywords
              </label>
              <div className="flex gap-2">
                <Input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addKeyword();
                    }
                  }}
                  placeholder="e.g., cheapest credit card processing"
                  data-testid="input-keyword"
                />
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Add keyword"
                  onClick={addKeyword}
                  data-testid="button-add-keyword"
                >
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              {keywords.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {keywords.map((k) => (
                    <Badge key={k} variant="secondary" className="gap-1">
                      {k}
                      <button onClick={() => removeKeyword(k)} data-testid={`button-remove-keyword-${k}`}>
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="text-sm font-medium text-foreground mb-1.5 block">
                Category
              </label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger data-testid="select-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="autoSchedule"
                checked={autoSchedule}
                onChange={(e) => setAutoSchedule(e.target.checked)}
                className="rounded"
                data-testid="checkbox-auto-schedule"
              />
              <label htmlFor="autoSchedule" className="text-sm text-foreground">
                Auto-schedule for publication (2-3 posts/week cadence)
              </label>
            </div>

            <Button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending || keywords.length === 0}
              className="w-full gap-2"
              data-testid="button-generate"
            >
              {generateMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Generating & Saving...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Generate & Save Blog Post
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <FileText className="w-5 h-5 text-primary" />
              Quick Keyword Ideas
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {[
                "cheapest credit card processing for [industry]",
                "how to reduce payment processing fees",
                "best POS system for [industry]",
                "[industry] payment processing guide 2025",
                "interchange-plus vs flat-rate pricing",
                "cash discount program compliance",
                "how to avoid hidden processing fees",
                "payment processing for small business [city]",
                "credit card processing fees explained",
                "best merchant services for [industry]",
              ].map((idea, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setKeyword(idea);
                  }}
                  className="block w-full text-left text-sm text-muted-foreground hover:text-foreground px-3 py-2 rounded-md hover:bg-muted/50 transition-colors"
                  data-testid={`button-idea-${i}`}
                >
                  {idea}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Calendar className="w-5 h-5 text-primary" />
            Generated Posts ({postsState === "ready" || postsState === "stale" ? savedPosts.length : "—"})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {postsState === "loading" || postsState === "unavailable" ? (
            <ReaderStatus state={postsState} subject="Generated posts" onRetry={() => void postsQuery.refetch()} />
          ) : savedPosts.length === 0 ? (
            <p className="text-center text-muted-foreground py-8" data-testid="text-no-posts">
              No generated posts yet. Use the form above to generate your first AI blog post.
            </p>
          ) : (
            <div className="space-y-3">
              <ReaderStatus state={postsState} subject="Generated posts" onRetry={() => void postsQuery.refetch()} />
              {savedPosts.map((post) => (
                <div
                  key={post.id}
                  className="flex items-center justify-between p-4 border rounded-lg"
                  data-testid={`row-post-${post.id}`}
                >
                  <div className="flex-1 min-w-0 mr-4">
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-medium text-foreground truncate">{post.title}</h3>
                      <Badge
                        variant={post.status === "published" ? "default" : post.status === "scheduled" ? "secondary" : "outline"}
                        className="shrink-0"
                      >
                        {post.status === "published" && <CheckCircle className="w-3 h-3 mr-1" />}
                        {post.status === "scheduled" && <Clock className="w-3 h-3 mr-1" />}
                        {post.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{post.category}</span>
                      <span>{post.readTime}</span>
                      {post.scheduledAt && (
                        <span>Scheduled: {new Date(post.scheduledAt).toLocaleDateString()}</span>
                      )}
                      {post.publishedAt && (
                        <span>Published: {new Date(post.publishedAt).toLocaleDateString()}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {post.status === "published" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="View post"
                        onClick={() => window.open(`/blog/${post.slug}`, "_blank")}
                        data-testid={`button-view-${post.id}`}
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                    )}
                    {post.status !== "published" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Publish post"
                        onClick={() => publishMutation.mutate(post.id)}
                        disabled={publishMutation.isPending}
                        data-testid={`button-publish-${post.id}`}
                      >
                        <Send className="w-4 h-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete post"
                      onClick={() => deleteMutation.mutate(post.id)}
                      disabled={deleteMutation.isPending}
                      className="text-destructive hover:text-destructive"
                      data-testid={`button-delete-${post.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Mail className="w-5 h-5 text-primary" />
            Newsletter Signups by Article
          </CardTitle>
        </CardHeader>
        <CardContent>
          {signupsState === "loading" || signupsState === "unavailable" ? (
            <ReaderStatus state={signupsState} subject="Newsletter signups" onRetry={() => void signupsQuery.refetch()} />
          ) : articleSignups.length === 0 ? (
            <p className="text-center text-muted-foreground py-8" data-testid="text-no-article-signups">
              No article-attributed signups yet. Signups from blog posts will appear here once collected.
            </p>
          ) : (
            <div className="space-y-2">
              <ReaderStatus state={signupsState} subject="Newsletter signups" onRetry={() => void signupsQuery.refetch()} />
              {articleSignups.map((row) => (
                <div
                  key={row.articleSlug}
                  className="flex items-center justify-between p-3 border rounded-lg"
                  data-testid={`row-article-signup-${row.articleSlug}`}
                >
                  <div className="flex-1 min-w-0 mr-4">
                    <p className="text-sm font-medium text-foreground truncate">/blog/{row.articleSlug}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Last signup: {new Date(row.lastSignupAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge variant="secondary" className="shrink-0">
                    {row.signupCount} {row.signupCount === 1 ? "signup" : "signups"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
