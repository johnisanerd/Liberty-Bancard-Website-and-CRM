import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle2, User, ExternalLink, RefreshCw } from "lucide-react";
import { format } from "date-fns";

type EnrichedConflict = {
  id: number;
  contactId: number | null;
  fieldName: string;
  internalValue: string | null;
  ghlValue: string | null;
  resolution: string;
  resolvedAt: string | null;
  createdAt: string | null;
  contactName: string;
  contactEmail: string;
  ownerContactName: string;
  ownerContactEmail: string;
  ghlId: string;
};

const RESOLUTION_LABELS: Record<string, string> = {
  "kept-internal": "Kept Internal",
  "kept-ghl": "Kept GHL",
  manual: "Manual",
  pending: "Pending",
};

const RESOLUTION_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  "kept-internal": "default",
  "kept-ghl": "secondary",
  manual: "outline",
  pending: "destructive",
};

export default function GhlConflicts() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<string>("pending");

  const { data: conflicts = [], isLoading, refetch } = useQuery<EnrichedConflict[]>({
    queryKey: ["/api/admin/ghl/identity-conflicts", filter],
    queryFn: async () => {
      const url = filter === "all"
        ? "/api/admin/ghl/identity-conflicts"
        : `/api/admin/ghl/identity-conflicts?resolution=${filter}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const resolveMutation = useMutation({
    mutationFn: async ({ id, resolution }: { id: number; resolution: string }) => {
      const res = await apiRequest("POST", `/api/admin/ghl/identity-conflicts/${id}/resolve`, { resolution });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/ghl/identity-conflicts"] });
      toast({ title: "Conflict resolved", description: "The conflict has been marked as resolved." });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const pending = conflicts.filter(c => c.resolution === "pending").length;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div>
          <PageTitle className="text-2xl font-bold tracking-tight">GHL Identity Conflict Queue</PageTitle>
          <p className="text-muted-foreground mt-1">
            Contacts where a GHL contact ID is claimed by more than one local record.
            Review each conflict and choose which side to keep.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-conflicts">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {pending > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
          <p className="text-sm font-medium">
            {pending} pending conflict{pending !== 1 ? "s" : ""} require staff review before GHL sync
            can link these contacts.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">Show:</span>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-40" data-testid="select-conflict-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="kept-internal">Kept Internal</SelectItem>
            <SelectItem value="kept-ghl">Kept GHL</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground ml-2">
          {isLoading ? "Loading…" : `${conflicts.length} record${conflicts.length !== 1 ? "s" : ""}`}
        </span>
      </div>

      {!isLoading && conflicts.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500" />
            <p className="font-medium">No conflicts</p>
            <p className="text-sm text-muted-foreground">
              {filter === "pending"
                ? "No pending identity conflicts — all contacts are in sync."
                : "No conflicts found for the selected filter."}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {conflicts.map((c) => (
          <Card key={c.id} data-testid={`card-conflict-${c.id}`}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span data-testid={`text-conflict-contact-${c.id}`}>{c.contactName}</span>
                    {c.contactEmail && (
                      <span className="text-sm font-normal text-muted-foreground">({c.contactEmail})</span>
                    )}
                  </CardTitle>
                  <CardDescription className="mt-1">
                    Conflict #{c.id} · Field: <code className="text-xs bg-muted px-1 rounded">{c.fieldName}</code>
                    {c.createdAt && (
                      <> · Detected {format(new Date(c.createdAt), "MMM d, yyyy 'at' h:mm a")}</>
                    )}
                  </CardDescription>
                </div>
                <Badge variant={RESOLUTION_VARIANTS[c.resolution] ?? "outline"}>
                  {RESOLUTION_LABELS[c.resolution] ?? c.resolution}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="rounded-lg border p-3 space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    This contact (wants GHL ID)
                  </p>
                  <p className="text-sm font-medium">{c.contactName}</p>
                  {c.contactEmail && <p className="text-xs text-muted-foreground">{c.contactEmail}</p>}
                  <p className="text-xs font-mono text-blue-600 dark:text-blue-400">
                    GHL ID: {c.ghlId || c.internalValue}
                  </p>
                </div>
                <div className="rounded-lg border p-3 space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    Current owner (holds GHL ID)
                  </p>
                  <p className="text-sm font-medium">{c.ownerContactName}</p>
                  {c.ownerContactEmail && (
                    <p className="text-xs text-muted-foreground">{c.ownerContactEmail}</p>
                  )}
                  <p className="text-xs text-muted-foreground">Local contact #{c.ghlValue}</p>
                </div>
              </div>

              {c.resolution === "pending" && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`button-keep-internal-${c.id}`}
                    disabled={resolveMutation.isPending}
                    onClick={() => resolveMutation.mutate({ id: c.id, resolution: "kept-internal" })}
                  >
                    Keep internal link — skip GHL link
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid={`button-keep-ghl-${c.id}`}
                    disabled={resolveMutation.isPending}
                    onClick={() => resolveMutation.mutate({ id: c.id, resolution: "kept-ghl" })}
                  >
                    Reassign GHL ID to this contact
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`button-mark-manual-${c.id}`}
                    disabled={resolveMutation.isPending}
                    onClick={() => resolveMutation.mutate({ id: c.id, resolution: "manual" })}
                  >
                    Mark as manually resolved
                  </Button>
                  {c.ghlId && (
                    <a
                      href={`https://app.gohighlevel.com/v2/location/${process.env.GHL_LOCATION_ID}/contacts/${c.ghlId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline ml-auto self-center"
                      data-testid={`link-ghl-contact-${c.id}`}
                    >
                      <ExternalLink className="h-3 w-3" />
                      View in GHL
                    </a>
                  )}
                </div>
              )}

              {c.resolution !== "pending" && c.resolvedAt && (
                <p className="text-xs text-muted-foreground">
                  Resolved {format(new Date(c.resolvedAt), "MMM d, yyyy 'at' h:mm a")} as "{RESOLUTION_LABELS[c.resolution]}"
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
