import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Star, Send, MessageCircle, ThumbsUp, Loader2, Clock } from "lucide-react";
import type { ReviewRequest } from "@shared/schema";
import { REVIEW_PLATFORMS } from "@shared/schema";

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`w-4 h-4 ${star <= rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30"}`}
        />
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "secondary" | "default" | "outline"> = {
    pending: "secondary",
    sent: "outline",
    responded: "default",
  };
  const colors: Record<string, string> = {
    pending: "",
    sent: "border-blue-500/50 text-blue-600 dark:text-blue-400",
    responded: "bg-green-600 text-white dark:bg-green-600",
  };
  return (
    <Badge variant={variants[status] || "secondary"} className={colors[status] || ""} data-testid={`badge-status-${status}`}>
      {status}
    </Badge>
  );
}

export default function ReviewRequests() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dealId, setDealId] = useState("");
  const [contactId, setContactId] = useState("");
  const [channel, setChannel] = useState("email");
  const [platform, setPlatform] = useState("Google");
  const { toast } = useToast();

  const { data: requests, isLoading } = useQuery<ReviewRequest[]>({
    queryKey: ["/api/review-requests"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { dealId: number; contactId: number; channel: string; platform: string }) => {
      const res = await apiRequest("POST", "/api/review-requests", data);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/review-requests"] });
      setDialogOpen(false);
      setDealId("");
      setContactId("");
      setChannel("email");
      setPlatform("Google");
      toast({ title: "Review request sent", description: "The review request has been created successfully." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: number; updates: Partial<ReviewRequest> }) => {
      const res = await apiRequest("PATCH", `/api/review-requests/${id}`, updates);
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/review-requests"] });
      toast({ title: "Updated", description: "Review request status updated." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleSubmit = () => {
    if (!dealId || !contactId) {
      toast({ title: "Validation Error", description: "Deal ID and Contact ID are required.", variant: "destructive" });
      return;
    }
    createMutation.mutate({
      dealId: parseInt(dealId),
      contactId: parseInt(contactId),
      channel,
      platform,
    });
  };

  const allRequests = requests || [];
  const totalSent = allRequests.length;
  const responsesReceived = allRequests.filter((r) => r.status === "responded").length;
  const pendingCount = allRequests.filter((r) => r.status === "pending").length;
  const ratingsOnly = allRequests.filter((r) => r.rating != null);
  const avgRating = ratingsOnly.length > 0
    ? (ratingsOnly.reduce((sum, r) => sum + (r.rating || 0), 0) / ratingsOnly.length).toFixed(1)
    : "N/A";

  const ratingCounts: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  ratingsOnly.forEach((r) => {
    if (r.rating && ratingCounts[r.rating] !== undefined) {
      ratingCounts[r.rating]++;
    }
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8" data-testid="page-review-requests">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <PageTitle className="text-2xl font-bold" data-testid="text-page-title">Review & Testimonial Requests</PageTitle>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button data-testid="button-send-review-request">
              <Send className="w-4 h-4 mr-2" />
              Send Review Request
            </Button>
          </DialogTrigger>
          <DialogContent data-testid="dialog-send-request">
            <DialogHeader>
              <DialogTitle>Send Review Request</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label htmlFor="dealId">Deal ID</Label>
                <Input
                  id="dealId"
                  type="number"
                  placeholder="Enter deal ID"
                  value={dealId}
                  onChange={(e) => setDealId(e.target.value)}
                  data-testid="input-deal-id"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contactId">Contact ID</Label>
                <Input
                  id="contactId"
                  type="number"
                  placeholder="Enter contact ID"
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                  data-testid="input-contact-id"
                />
              </div>
              <div className="space-y-2">
                <Label>Channel</Label>
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger data-testid="select-channel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="sms">SMS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Platform</Label>
                <Select value={platform} onValueChange={setPlatform}>
                  <SelectTrigger data-testid="select-platform">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REVIEW_PLATFORMS.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                className="w-full"
                onClick={handleSubmit}
                disabled={createMutation.isPending}
                data-testid="button-submit-request"
              >
                {createMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <Send className="w-4 h-4 mr-2" />
                )}
                Send Request
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card data-testid="card-kpi-total-sent">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Requests Sent</CardTitle>
            <Send className="w-4 h-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-sent">{totalSent}</div>
          </CardContent>
        </Card>

        <Card data-testid="card-kpi-responses">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Responses Received</CardTitle>
            <MessageCircle className="w-4 h-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-responses-received">{responsesReceived}</div>
          </CardContent>
        </Card>

        <Card data-testid="card-kpi-avg-rating">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Average Rating</CardTitle>
            <Star className="w-4 h-4 fill-amber-400 text-amber-400" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold" data-testid="text-avg-rating">{avgRating}</span>
              {avgRating !== "N/A" && <StarRating rating={Math.round(parseFloat(avgRating))} />}
            </div>
          </CardContent>
        </Card>

        <Card data-testid="card-kpi-pending">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Requests</CardTitle>
            <Clock className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-pending-count">{pendingCount}</div>
          </CardContent>
        </Card>
      </div>

      {ratingsOnly.length > 0 && (
        <Card data-testid="card-rating-summary">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ThumbsUp className="w-5 h-5 text-primary" />
              <CardTitle className="text-base">Rating Summary</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-6 flex-wrap">
              <div className="flex items-center gap-3">
                <span className="text-3xl font-bold" data-testid="text-summary-avg">{avgRating}</span>
                <div>
                  <StarRating rating={Math.round(parseFloat(avgRating as string))} />
                  <p className="text-xs text-muted-foreground mt-1">{ratingsOnly.length} review{ratingsOnly.length !== 1 ? "s" : ""}</p>
                </div>
              </div>
              <div className="space-y-1">
                {[5, 4, 3, 2, 1].map((star) => (
                  <div key={star} className="flex items-center gap-2 text-sm" data-testid={`text-rating-count-${star}`}>
                    <span className="w-16 text-muted-foreground">{star} star{star !== 1 ? "s" : ""}:</span>
                    <span className="font-medium">{ratingCounts[star]}</span>
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-requests-table">
        <CardHeader>
          <CardTitle className="text-base">Review Requests</CardTitle>
        </CardHeader>
        <CardContent>
          {allRequests.length === 0 ? (
            <div className="text-center text-muted-foreground py-12" data-testid="text-no-requests">
              No review requests yet. Send your first request to get started.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Deal ID</TableHead>
                    <TableHead>Contact ID</TableHead>
                    <TableHead>Channel</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Sent Date</TableHead>
                    <TableHead>Response Date</TableHead>
                    <TableHead>Rating</TableHead>
                    <TableHead>Review</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {allRequests.map((req) => (
                    <TableRow key={req.id} data-testid={`row-request-${req.id}`}>
                      <TableCell data-testid={`text-deal-id-${req.id}`}>{req.dealId}</TableCell>
                      <TableCell data-testid={`text-contact-id-${req.id}`}>{req.contactId}</TableCell>
                      <TableCell data-testid={`text-channel-${req.id}`}>
                        <Badge variant="secondary">{req.channel}</Badge>
                      </TableCell>
                      <TableCell data-testid={`text-platform-${req.id}`}>{req.platform || "—"}</TableCell>
                      <TableCell>
                        <StatusBadge status={req.status || "pending"} />
                      </TableCell>
                      <TableCell data-testid={`text-sent-date-${req.id}`}>
                        {req.sentAt ? new Date(req.sentAt).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell data-testid={`text-response-date-${req.id}`}>
                        {req.respondedAt ? new Date(req.respondedAt).toLocaleDateString() : "—"}
                      </TableCell>
                      <TableCell data-testid={`text-rating-${req.id}`}>
                        {req.rating ? <StarRating rating={req.rating} /> : "—"}
                      </TableCell>
                      <TableCell data-testid={`text-review-${req.id}`}>
                        {req.reviewText ? (
                          <span className="max-w-[200px] truncate block text-sm" title={req.reviewText}>
                            {req.reviewText}
                          </span>
                        ) : "—"}
                      </TableCell>
                      <TableCell>
                        {req.status === "pending" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => updateMutation.mutate({ id: req.id, updates: { status: "sent", sentAt: new Date() } })}
                            disabled={updateMutation.isPending}
                            data-testid={`button-mark-sent-${req.id}`}
                          >
                            Mark Sent
                          </Button>
                        )}
                        {req.status === "sent" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => updateMutation.mutate({ id: req.id, updates: { status: "responded", respondedAt: new Date() } })}
                            disabled={updateMutation.isPending}
                            data-testid={`button-mark-responded-${req.id}`}
                          >
                            Mark Responded
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
