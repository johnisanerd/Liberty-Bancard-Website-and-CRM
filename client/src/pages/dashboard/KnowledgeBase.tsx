import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { ReaderStatus } from "@/components/dashboard/ReaderStatus";
import { readerState } from "@/lib/reader-state";
import { ResourcesNav } from "@/components/dashboard/ResourcesNav";
import { useToast } from "@/hooks/use-toast";
import { Search, BookOpen, HelpCircle, Plus, Eye, ThumbsUp, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import type { KnowledgeBaseArticle } from "@shared/schema";
import { KB_CATEGORIES } from "@shared/schema";

const ALL_CATEGORIES = ["All", ...KB_CATEGORIES] as const;

export default function KnowledgeBase() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "admin";

  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [formTitle, setFormTitle] = useState("");
  const [formCategory, setFormCategory] = useState<string>(KB_CATEGORIES[0]);
  const [formContent, setFormContent] = useState("");
  const [formTags, setFormTags] = useState("");
  const [formPublished, setFormPublished] = useState(true);

  const articlesQuery = useQuery<KnowledgeBaseArticle[]>({
    queryKey: ["/api/knowledge-base"],
  });
  const articles = articlesQuery.data;
  const articlesState = readerState(articlesQuery);

  const createMutation = useMutation({
    mutationFn: async (data: {
      title: string;
      category: string;
      content: string;
      tags: string[];
      isPublished: boolean;
    }) => {
      const res = await apiRequest("POST", "/api/knowledge-base", data);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/knowledge-base"] });
      setDialogOpen(false);
      resetForm();
      toast({ title: "Article created", description: "Knowledge base article has been published." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create article.", variant: "destructive" });
    },
  });

  function resetForm() {
    setFormTitle("");
    setFormCategory(KB_CATEGORIES[0]);
    setFormContent("");
    setFormTags("");
    setFormPublished(true);
  }

  function handleSubmit() {
    if (!formTitle.trim() || !formContent.trim()) return;
    const tags = formTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    createMutation.mutate({
      title: formTitle,
      category: formCategory,
      content: formContent,
      tags,
      isPublished: formPublished,
    });
  }

  const filtered = (articles || []).filter((a) => {
    if (selectedCategory !== "All" && a.category !== selectedCategory) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return (
        a.title.toLowerCase().includes(q) ||
        a.content.toLowerCase().includes(q)
      );
    }
    return true;
  });

  if (articlesState === "loading") {
    return (
      <div className="flex items-center justify-center py-20" data-testid="loading-knowledge-base">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="page-knowledge-base">
      <ResourcesNav current="/dashboard/knowledge-base" />
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <BookOpen className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold" data-testid="heading-knowledge-base">Knowledge Base</h1>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search articles..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 w-64"
              data-testid="input-search-articles"
            />
          </div>
          {isAdmin && (
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button data-testid="button-add-article">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Article
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Add Knowledge Base Article</DialogTitle>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="kb-title">Title</Label>
                    <Input
                      id="kb-title"
                      value={formTitle}
                      onChange={(e) => setFormTitle(e.target.value)}
                      placeholder="Article title"
                      data-testid="input-article-title"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="kb-category">Category</Label>
                    <Select value={formCategory} onValueChange={setFormCategory}>
                      <SelectTrigger data-testid="select-article-category">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {KB_CATEGORIES.map((cat) => (
                          <SelectItem key={cat} value={cat}>
                            {cat}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="kb-content">Content</Label>
                    <Textarea
                      id="kb-content"
                      value={formContent}
                      onChange={(e) => setFormContent(e.target.value)}
                      placeholder="Article content..."
                      rows={6}
                      data-testid="input-article-content"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="kb-tags">Tags (comma-separated)</Label>
                    <Input
                      id="kb-tags"
                      value={formTags}
                      onChange={(e) => setFormTags(e.target.value)}
                      placeholder="e.g. terminal, setup, PCI"
                      data-testid="input-article-tags"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="kb-published"
                      checked={formPublished}
                      onCheckedChange={(checked) => setFormPublished(!!checked)}
                      data-testid="checkbox-article-published"
                    />
                    <Label htmlFor="kb-published">Published</Label>
                  </div>
                  <Button
                    onClick={handleSubmit}
                    disabled={createMutation.isPending || !formTitle.trim() || !formContent.trim()}
                    className="w-full"
                    data-testid="button-submit-article"
                  >
                    {createMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : null}
                    Create Article
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      <ReaderStatus state={articlesState === "stale" ? "stale" : "ready"} subject="Knowledge base articles" onRetry={() => void articlesQuery.refetch()} />
      <div className="flex flex-wrap gap-2" data-testid="category-filters">
        {ALL_CATEGORIES.map((cat) => (
          <Button
            key={cat}
            variant={selectedCategory === cat ? "default" : "outline"}
            size="sm"
            onClick={() => setSelectedCategory(cat)}
            data-testid={`button-category-${cat.toLowerCase().replace(/\s+/g, "-").replace(/&/g, "and")}`}
          >
            {cat}
          </Button>
        ))}
      </div>

      {articlesState === "unavailable" ? (
        <ReaderStatus state="unavailable" subject="Knowledge base articles" onRetry={() => void articlesQuery.refetch()} />
      ) : filtered.length === 0 ? (
        <Card data-testid="empty-state">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <HelpCircle className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2" data-testid="text-no-articles">No articles found</h3>
            <p className="text-sm text-muted-foreground">
              {search.trim()
                ? "Try adjusting your search terms or clearing the filter."
                : "Check back later for new knowledge base articles."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="articles-grid">
          {filtered.map((article) => {
            const isExpanded = expandedId === article.id;
            return (
              <Card
                key={article.id}
                className="cursor-pointer hover-elevate transition-all"
                onClick={() => setExpandedId(isExpanded ? null : article.id)}
                data-testid={`card-article-${article.id}`}
              >
                <CardHeader className="flex flex-row items-start justify-between gap-2 pb-2">
                  <div className="space-y-1 min-w-0">
                    <Badge variant="secondary" className="text-xs" data-testid={`badge-category-${article.id}`}>
                      {article.category}
                    </Badge>
                    <CardTitle className="text-base" data-testid={`text-title-${article.id}`}>
                      {article.title}
                    </CardTitle>
                  </div>
                  {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0 mt-1" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 mt-1" />
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <p
                    className={`text-sm text-muted-foreground ${isExpanded ? "whitespace-pre-line" : "line-clamp-3"}`}
                    data-testid={`text-content-${article.id}`}
                  >
                    {isExpanded ? article.content : article.content.slice(0, 150) + (article.content.length > 150 ? "..." : "")}
                  </p>

                  {article.tags && article.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1" data-testid={`tags-${article.id}`}>
                      {article.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1" data-testid={`views-${article.id}`}>
                      <Eye className="w-3 h-3" />
                      {article.viewCount || 0}
                    </span>
                    <span className="flex items-center gap-1" data-testid={`helpful-${article.id}`}>
                      <ThumbsUp className="w-3 h-3" />
                      {article.helpfulCount || 0}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
