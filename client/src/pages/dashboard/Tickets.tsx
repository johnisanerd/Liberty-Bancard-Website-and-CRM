import { useState, useEffect } from "react";
import { useWorkCommands, invalidateWorkFacts } from "@/hooks/use-work-commands";
import {useTicketCreateCommand} from "@/hooks/use-rfi-command";
import { useSearch } from "wouter";
import {useAuthorizedSelectedRecord} from "@/hooks/use-authorized-selected-record";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Plus, AlertTriangle, Sparkles, Loader2, Download, Send, Lock, Globe, MessageSquareText, Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { exportToCSV } from "@/lib/export-csv";
import { useAuth } from "@/hooks/use-auth";
import SavedFilterBar from "@/components/SavedFilterBar";
import DashboardErrorState from "@/components/DashboardErrorState";
import { DataState } from "@/components/ui/data-state";
import { PageHeader } from "@/components/ui/page-header";
import { toastError } from "@/lib/toast-helpers";
import type { Ticket, Contact, TicketComment } from "@shared/schema";
import { TICKET_CATEGORIES, SUPPORT_STAGES } from "@shared/schema";
import { useTicketDraft } from "@/hooks/use-ticket-draft";

function getPriorityVariant(priority: string | null): "destructive" | "secondary" {
  return priority === "Urgent" ? "destructive" : "secondary";
}

function getStatusClasses(status: string | null): string {
  switch (status) {
    case "In Progress": return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
    case "Waiting on Merchant": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
    case "Resolved": return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
    case "Closed": return "bg-muted text-muted-foreground";
    default: return "";
  }
}

function isSlaBreached(ticket: Ticket): boolean {
  if (!ticket.slaDeadline) return false;
  if (ticket.status === "Resolved" || ticket.status === "Closed") return false;
  return new Date() > new Date(ticket.slaDeadline);
}

// #317 — SLA countdown ("2h 30m left" / "1d 4h left" / "Overdue")
function formatSlaCountdown(deadline: string | Date | null, status: string): string | null {
  if (!deadline) return null;
  if (status === "Resolved" || status === "Closed") return null;
  const diff = new Date(deadline).getTime() - Date.now();
  if (diff <= 0) return "Overdue";
  const totalMinutes = Math.floor(diff / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${mins}m left`;
}

function getInitials(name: string | null | undefined): string {
  if (!name) return "?";
  return name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);
}

function formatTimestamp(date: string | Date | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const QUICK_REPLIES = [
  {
    label: "Acknowledge & Investigating",
    category: "general",
    text: "Thanks for the additional details — that's really helpful. I'm looking into this now and will have an update for you shortly. If anything else comes to mind in the meantime, feel free to add it here.",
  },
  {
    label: "Request More Info",
    category: "general",
    text: "I want to make sure we get this right for you. Could you share a bit more detail? Specifically:\n\n- [What additional info is needed]\n\nOnce I have that, I can move this forward quickly. No rush — just reply here when you get a chance.",
  },
  {
    label: "Terminal Troubleshooting",
    category: "Terminal",
    text: "Let's try a quick fix first — these usually do the trick:\n\n1. Hold the power button for 10 seconds to do a full restart\n2. Make sure the charging cable is firmly connected\n3. Check that your Wi-Fi is working (try loading a webpage on your phone)\n\nIf it's still not cooperating after that, let me know and we'll look at getting you a replacement. We don't want you losing sales over a terminal issue.",
  },
  {
    label: "Deposit Timing Explanation",
    category: "Funding / Deposits",
    text: "I checked your account and here's what I'm seeing on the deposit side:\n\n- Your batch typically settles within [X] business days\n- The most recent batch was processed on [date]\n\nIf a specific deposit seems delayed or missing, send me the date and approximate amount and I'll trace it through the system. Sometimes it's just a bank processing delay, but I want to make sure everything's accounted for.",
  },
  {
    label: "Chargeback Next Steps",
    category: "Chargeback / Dispute",
    text: "I've pulled up the dispute details. Here's what we need to respond with before the deadline:\n\n1. A signed copy of the receipt or invoice\n2. Proof of delivery or service completion (tracking number, signed work order, etc.)\n3. Any communication with the cardholder (emails, texts, etc.)\n\nI know gathering docs is a pain, but the stronger our response the better our chances of winning this. Forward what you have to support@libertybancard.com and I'll put the response package together for you.",
  },
  {
    label: "PCI Compliance Guidance",
    category: "PCI Compliance",
    text: "I took a look at your PCI compliance status. Here's where things stand:\n\n- Your annual SAQ (Self-Assessment Questionnaire) is [due/overdue/current]\n- [Any specific compliance items]\n\nIf you need to complete or renew your SAQ, I can send you the direct link — it usually takes about 15-20 minutes. Staying current on this avoids the monthly non-compliance fee and keeps your account in good standing.\n\nLet me know if you'd like me to walk you through it.",
  },
  {
    label: "Escalation Notice",
    category: "general",
    text: "I want to make sure this gets the attention it deserves, so I've brought in our senior team to take a closer look. They'll be reviewing everything we've discussed and will reach out directly.\n\nYou should hear from them within the next few hours. In the meantime, if anything urgent comes up, our direct line is 954-266-8214.",
  },
  {
    label: "Follow-Up Check-In",
    category: "general",
    text: "Just checking in — wanted to make sure everything's been working smoothly since we last spoke. If the issue came back or if there's anything else on your mind, I'm here.\n\nOtherwise, I'll go ahead and close this out in a day or two. No action needed on your end if all is well.",
  },
];

function TicketConversation({
  ticket,
  draftToInsert,
  onDraftInserted,
}: {
  ticket: Ticket;
  draftToInsert?: { text: string; nonce: number } | null;
  onDraftInserted?: () => void;
}) {
  const { toast } = useToast();
  const { replyContent, setReplyContent: handleReplyContentChange, discard: handleDiscardDraft, clearAfterSend } = useTicketDraft(
    ticket.id,
    draftToInsert,
    onDraftInserted
  );
  const [isInternal, setIsInternal] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  useEffect(() => {
    if (draftToInsert && draftToInsert.text) {
      setIsInternal(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftToInsert?.nonce]);

  const { data: comments, isLoading: commentsLoading } = useQuery<TicketComment[]>({
    queryKey: ["/api/tickets", ticket.id, "comments"],
    queryFn: async () => {
      const res = await fetch(`/api/tickets/${ticket.id}/comments`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch comments");
      return res.json();
    },
  });

  const addCommentMutation = useMutation({
    mutationFn: async (data: { content: string; isInternal: boolean }) => {
      const res = await apiRequest("POST", `/api/tickets/${ticket.id}/comments`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tickets", ticket.id, "comments"] });
      clearAfterSend();
      toast({ title: "Reply added" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add reply", description: err.message, variant: "destructive" });
    },
  });

  const handleSubmitReply = () => {
    if (!replyContent.trim()) return;
    addCommentMutation.mutate({ content: replyContent.trim(), isInternal });
  };

  return (
    <div className="space-y-4" data-testid="ticket-conversation">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold">Conversation</h4>
        <Badge variant="secondary" className="text-xs no-default-hover-elevate" data-testid="badge-comment-count">
          {comments?.length ?? 0}
        </Badge>
      </div>

      <div className="space-y-3 max-h-64 overflow-y-auto pr-1" data-testid="conversation-thread">
        {commentsLoading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Loading conversation...
          </div>
        ) : !comments || comments.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground text-sm" data-testid="text-no-comments">
            No replies yet. Start the conversation below.
          </div>
        ) : (
          comments.map((comment) => (
            <div
              key={comment.id}
              className={`flex gap-3 ${comment.isInternal ? "opacity-80" : ""}`}
              data-testid={`comment-${comment.id}`}
            >
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarFallback className="text-xs" data-testid={`avatar-comment-${comment.id}`}>
                  {getInitials(comment.authorName)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium" data-testid={`text-comment-author-${comment.id}`}>
                    {comment.authorName || "Unknown"}
                  </span>
                  <span className="text-xs text-muted-foreground" data-testid={`text-comment-time-${comment.id}`}>
                    {formatTimestamp(comment.createdAt)}
                  </span>
                  {comment.isInternal ? (
                    <Badge variant="outline" className="text-xs gap-1 no-default-hover-elevate" data-testid={`badge-internal-${comment.id}`}>
                      <Lock className="w-3 h-3" />
                      Internal
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs gap-1 no-default-hover-elevate" data-testid={`badge-external-${comment.id}`}>
                      <Globe className="w-3 h-3" />
                      External
                    </Badge>
                  )}
                </div>
                <p className="text-sm mt-1 whitespace-pre-wrap" data-testid={`text-comment-content-${comment.id}`}>
                  {comment.content}
                </p>
              </div>
            </div>
          ))
        )}
      </div>

      <Separator />

      <div className="space-y-3" data-testid="reply-form">
        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowTemplates(!showTemplates)}
            className="gap-1.5 text-xs mb-2"
            data-testid="button-quick-replies"
          >
            <MessageSquareText className="w-3.5 h-3.5" />
            Quick Replies
          </Button>
          {showTemplates && (
            <div className="absolute z-10 left-0 top-full mt-1 w-72 bg-popover border rounded-md shadow-lg max-h-64 overflow-y-auto" data-testid="quick-replies-dropdown">
              {QUICK_REPLIES
                .filter(qr => qr.category === "general" || qr.category === (ticket.category || ""))
                .map((qr, i) => (
                  <button
                    key={i}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors border-b last:border-b-0"
                    onClick={() => {
                      handleReplyContentChange(qr.text);
                      setShowTemplates(false);
                      setIsInternal(false);
                    }}
                    data-testid={`quick-reply-${i}`}
                  >
                    <span className="font-medium text-foreground">{qr.label}</span>
                    <span className="block text-xs text-muted-foreground mt-0.5 line-clamp-2">{qr.text.split("\n")[0]}</span>
                  </button>
                ))}
            </div>
          )}
        </div>
        <Textarea
          value={replyContent}
          onChange={(e) => handleReplyContentChange(e.target.value)}
          placeholder={isInternal ? "Add an internal note..." : "Type your reply..."}
          className="resize-none"
          rows={4}
          data-testid="input-reply-content"
        />
        {replyContent.trim() && (
          <p className="text-xs text-muted-foreground" data-testid="text-draft-saved-indicator">
            Draft saved for this ticket — it will still be here if you navigate away.
          </p>
        )}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Switch
              checked={isInternal}
              onCheckedChange={setIsInternal}
              data-testid="switch-internal-note"
            />
            <Label className="text-sm cursor-pointer" data-testid="label-internal-note">
              {isInternal ? "Internal note" : "External reply"}
            </Label>
            {isInternal && (
              <Lock className="w-3.5 h-3.5 text-muted-foreground" />
            )}
          </div>
          <div className="flex items-center gap-2">
            {replyContent.trim() && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDiscardDraft}
                disabled={addCommentMutation.isPending}
                data-testid="button-discard-draft"
              >
                Discard draft
              </Button>
            )}
            <Button
              onClick={handleSubmitReply}
              disabled={!replyContent.trim() || addCommentMutation.isPending}
              className="gap-2"
              data-testid="button-submit-reply"
            >
              {addCommentMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              {isInternal ? "Add Note" : "Send Reply"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Tickets() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const [newTicket, setNewTicket] = useState({
    contactId: "",
    subject: "",
    description: "",
    category: "Other",
    priority: "Normal",
  });

  const [editStatus, setEditStatus] = useState("");
  const [editAssignedTo, setEditAssignedTo] = useState("");
  // #511 — Status filter
  const [statusFilter, setStatusFilter] = useState("");
  // #551 — Search filter
  const [searchTerm, setSearchTerm] = useState("");
  // #575 — Assigned to me filter
  const [assignedToMe, setAssignedToMe] = useState(false);
  // #425 — Bulk resolve tickets
  const [selectedTicketIds, setSelectedTicketIds] = useState<Set<number>>(new Set());
  const toggleTicketSelect = (id: number) => setSelectedTicketIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const bulkResolveMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      const res = await apiRequest("POST", "/api/tickets/bulk-complete", workCommands.bulk(ids));
      return res.json();
    },
    onSuccess: (data) => {
      invalidateWorkFacts();
      setSelectedTicketIds(new Set());
      toast({ title: data.replayed ? "Resolution already saved" : `${data.changed} tickets resolved` });
    },
    onError: (err: Error) => { toastError(err, { title: "Bulk resolve failed" }); },
  });
  const [aiResult, setAiResult] = useState<{category: string; priority: string; suggestedResponse: string; tags: string[]; estimatedResolutionHours: number} | null>(null);
  const [draftToInsert, setDraftToInsert] = useState<{ text: string; nonce: number } | null>(null);

  const { data: ticketsResult, isLoading, isError, refetch } = useQuery<{ data: Ticket[]; total: number }>({
    queryKey: ["/api/tickets"],
    queryFn: async () => {
      const res = await fetch("/api/tickets?limit=500", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch tickets");
      return res.json();
    },
  });
  const allTickets = ticketsResult?.data;
  // #532 — Apply status filter; #551 — Apply search
  const tickets = allTickets?.filter(t => {
    if (statusFilter && t.status !== statusFilter) return false;
    if (assignedToMe && t.assignedTo !== user?.email) return false;
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      if (!t.subject?.toLowerCase().includes(s) && !t.description?.toLowerCase().includes(s)) return false;
    }
    return true;
  });

  const { data: contactsResult } = useQuery<{ data: Contact[]; total: number }>({
    queryKey: ["/api/contacts"],
    queryFn: async () => {
      const res = await fetch("/api/contacts?limit=500", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch contacts");
      return res.json();
    },
  });
  const contacts = contactsResult?.data;

  // #497 — Agents list for bulk reassign
  const { data: agentsList } = useQuery<{ id: number; email: string; firstName?: string | null; lastName?: string | null }[]>({
    queryKey: ["/api/agents"],
  });

  const workCommands = useWorkCommands("ticket", selectedTicketIds, tickets);
  const ticketCreation=useTicketCreateCommand();
  useEffect(()=>{
    setCreateOpen(false);
    setNewTicket({contactId:"",subject:"",description:"",category:"Other",priority:"Normal"});
  },[ticketCreation.context]);
  function acceptTicketCreation(result:any){
    void invalidateWorkFacts();
    setCreateOpen(false);
    setNewTicket({contactId:"",subject:"",description:"",category:"Other",priority:"Normal"});
    toast({title:result.command.reused?"Existing active ticket retained":"Local ticket creation confirmed",
      description:"No native delivery was attempted."});
  }
  const createTicketMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      return ticketCreation.execute(data);
    },
    onSuccess:acceptTicketCreation,
    onError: (err: Error) => {
      toastError(err, { title: "Failed to create ticket" });
    },
  });

  const updateTicketMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: number } & Record<string, unknown>) => {
      const res = await apiRequest("PUT", `/api/tickets/${id}`, data);
      return res.json();
    },
    onSuccess: (_data, variables) => {
      setSelectedTicket(_data);
      setEditStatus(_data.status ?? "");
      setEditAssignedTo(_data.assignedTo ?? "");
      invalidateWorkFacts();
      queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
      if (variables.id) {
        queryClient.invalidateQueries({ queryKey: ["/api/tickets", variables.id, "comments"] });
      }
      toast({ title: "Ticket updated successfully" });
    },
    onError: (err: Error) => {
      toastError(err, { title: "Failed to update ticket" });
    },
  });

  const classifyMutation = useMutation({
    mutationFn: async (ticketId: number) => {
      const res = await apiRequest("POST", "/api/ai/classify-ticket", { ticketId });
      return res.json();
    },
    onSuccess: (data) => {
      if (data?.error) {
        toast({ title: data.errorType === "credential" ? "AI Credentials Issue" : data.errorType === "quota" ? "AI Quota Exceeded" : "AI Unavailable", description: data.message || "AI classification is temporarily unavailable.", variant: "destructive" });
        return;
      }
      setAiResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/tickets"] });
      toast({ title: "Ticket classified by AI", description: `Category: ${data.category}, Priority: ${data.priority}` });
    },
    onError: (err: Error) => {
      toast({ title: "AI classification failed", description: err.message, variant: "destructive" });
    },
  });

  const handleCreateTicket = () => {
    if (!newTicket.subject || !newTicket.description) {
      toast({ title: "Subject and description are required", variant: "destructive" });
      return;
    }
    const payload: Record<string, unknown> = {
      subject: newTicket.subject,
      description: newTicket.description,
      category: newTicket.category,
      priority: newTicket.priority,
    };
    if (newTicket.contactId) {
      payload.contactId = Number(newTicket.contactId);
    }
    createTicketMutation.mutate(payload);
  };

  const handleUpdateTicket = () => {
    if (!selectedTicket) return;
    const updates: Record<string, unknown> = {};
    if (editStatus && editStatus !== selectedTicket.status) updates.status = editStatus;
    if (editAssignedTo !== (selectedTicket.assignedTo || "")) updates.assignedTo = editAssignedTo || null;
    if (Object.keys(updates).length === 0) {
      return;
    }
    updateTicketMutation.mutate({ id: selectedTicket.id, ...workCommands.edit(selectedTicket, updates) });
  };

  const openTicketDetail = (ticket: Ticket) => {
    setSelectedTicket(ticket);
    setEditStatus(ticket.status || "New Ticket");
    setEditAssignedTo(ticket.assignedTo || "");
    setAiResult(null);
    setDraftToInsert(null);
    setDetailOpen(true);
  };

  const search = useSearch();
  const selectedRecord=useAuthorizedSelectedRecord<Ticket>("/api/tickets",search);
  useEffect(() => {
    const id=selectedRecord.id;
    if(id===null) return;
    const ticket=selectedRecord.data;
    if (ticket && (!detailOpen || selectedTicket?.id !== id)) {
      openTicketDetail(ticket);
    }
  }, [selectedRecord.id,selectedRecord.data]);
  useEffect(()=>{if(selectedRecord.isError || selectedRecord.invalid) {setDetailOpen(false);setSelectedTicket(null);}},
    [selectedRecord.isError,selectedRecord.invalid]);

  if (isError) {
    return <DashboardErrorState title="Failed to load tickets" onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-6" data-testid="tickets-page">
      {ticketCreation.uncertain.includes("create")&&<div role="alert" data-testid="ticket-create-unconfirmed" className="rounded-lg border p-4">
        Local ticket intent is unconfirmed. Its original payload/version is retained; this is not a delivery receipt.
        <Button data-testid="button-retry-ticket-create" onClick={()=>void ticketCreation.retry("create")
          .then(acceptTicketCreation).catch(error=>toastError(error,{title:"Ticket intent remains unconfirmed"}))}>
          Retry frozen intent
        </Button>
      </div>}
      {(selectedRecord.isError || selectedRecord.invalid) && <div role="alert">Requested record unavailable.
        {!selectedRecord.invalid && <Button onClick={()=>void selectedRecord.refetch()}>Retry selected record</Button>}
      </div>}
      <PageHeader
      title={ticketCreation.uncertain.includes("create")?"Support Tickets · Intent unconfirmed":
        `Support Tickets${tickets ? ` (${tickets.length} loaded)` : ""}`}
        testId="text-tickets-title"
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const exportData = (tickets || []).map(t => ({
                  subject: t.subject,
                  status: t.status || "",
                  priority: t.priority || "",
                  category: t.category || "",
                  assignedTo: t.assignedTo || "",
                  createdAt: t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "",
                }));
                exportToCSV(exportData, "tickets", [
                  { key: "subject", label: "Subject" },
                  { key: "status", label: "Status" },
                  { key: "priority", label: "Priority" },
                  { key: "category", label: "Category" },
                  { key: "assignedTo", label: "Assigned To" },
                  { key: "createdAt", label: "Created At" },
                ]);
              }}
              data-testid="button-export-tickets"
            >
              <Download className="w-4 h-4 mr-1" /> Export Tickets
            </Button>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button data-testid="button-new-ticket" className="gap-2">
                  <Plus className="w-4 h-4" />
                  New Ticket
                </Button>
              </DialogTrigger>
          <DialogContent data-testid="dialog-create-ticket">
            <DialogHeader>
              <DialogTitle>Create Support Ticket</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>Contact</Label>
                <Select value={newTicket.contactId} onValueChange={(v) => setNewTicket({ ...newTicket, contactId: v })}>
                  <SelectTrigger data-testid="select-ticket-contact">
                    <SelectValue placeholder="Select a contact (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    {contacts?.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.firstName} {c.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Subject</Label>
                <Input
                  value={newTicket.subject}
                  onChange={(e) => setNewTicket({ ...newTicket, subject: e.target.value })}
                  placeholder="Ticket subject"
                  data-testid="input-ticket-subject"
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={newTicket.description}
                  onChange={(e) => setNewTicket({ ...newTicket, description: e.target.value })}
                  placeholder="Describe the issue..."
                  data-testid="input-ticket-description"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select value={newTicket.category} onValueChange={(v) => setNewTicket({ ...newTicket, category: v })}>
                    <SelectTrigger data-testid="select-ticket-category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TICKET_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Priority</Label>
                  <Select value={newTicket.priority} onValueChange={(v) => setNewTicket({ ...newTicket, priority: v })}>
                    <SelectTrigger data-testid="select-ticket-priority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Normal">Normal</SelectItem>
                      <SelectItem value="Urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setCreateOpen(false)} data-testid="button-cancel-ticket">
                  Cancel
                </Button>
                <Button onClick={handleCreateTicket} disabled={createTicketMutation.isPending||ticketCreation.uncertain.includes("create")} data-testid="button-submit-ticket">
                  {createTicketMutation.isPending ? "Creating..." : "Create Ticket"}
                </Button>
              </div>
            </div>
          </DialogContent>
            </Dialog>
          </>
        }
      />

      {/* #511 — Status filter; #551 — Search */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs w-[220px]"
            placeholder="Search tickets…"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            data-testid="input-ticket-search"
          />
        </div>
        <Select value={statusFilter || "__all__"} onValueChange={v => setStatusFilter(v === "__all__" ? "" : v)}>
          <SelectTrigger className="h-8 w-[160px] text-xs" data-testid="select-ticket-status-filter">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All statuses</SelectItem>
            {["Open", "In Progress", "Resolved", "Closed"].map(s => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* #575 — Assigned to me chip */}
        <button
          onClick={() => setAssignedToMe(v => !v)}
          data-testid="chip-assigned-to-me-tickets"
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
            assignedToMe
              ? "bg-primary/10 border-primary/30 text-primary"
              : "bg-background border-border text-muted-foreground hover:bg-muted"
          }`}
        >
          Assigned to me
        </button>
      </div>

      <SavedFilterBar
        entityType="ticket"
        currentFilters={{}}
        onApplyFilter={() => {}}
      />

      {/* #425 — Bulk resolve action bar */}
      {selectedTicketIds.size > 0 && (
        <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm flex-wrap" data-testid="bulk-ticket-bar">
          <span className="text-muted-foreground">{selectedTicketIds.size} selected</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => bulkResolveMutation.mutate(Array.from(selectedTicketIds))}
            disabled={bulkResolveMutation.isPending}
            data-testid="button-bulk-resolve-tickets"
          >
            {bulkResolveMutation.isPending ? "Resolving..." : "Mark Resolved"}
          </Button>
          {/* #497 — Bulk reassign tickets */}
          {(user?.role === "admin" || user?.role === "manager") && (
            <select
              className="text-xs border border-border rounded px-1.5 py-1 bg-background"
              defaultValue=""
              data-testid="select-bulk-reassign-tickets"
              onChange={async e => {
                const assignedTo = e.target.value;
                if (!assignedTo) return;
                try {
                  const response = await apiRequest("POST", "/api/tickets/bulk-assign",
                    workCommands.bulk(Array.from(selectedTicketIds), { assignedTo }));
                  const outcome = await response.json();
                  invalidateWorkFacts();
                  setSelectedTicketIds(new Set());
                  toast({ title: outcome.replayed ? "Assignment already saved" : `${outcome.changed} tickets reassigned` });
                } catch (err: any) {
                  toast({ title: "Reassign failed", description: err.message, variant: "destructive" });
                }
              }}
            >
              <option value="">Reassign to…</option>
              {agentsList?.map((a: any) => (
                <option key={a.id} value={a.email}>
                  {a.firstName && a.lastName ? `${a.firstName} ${a.lastName}` : a.email.split("@")[0]}
                </option>
              ))}
            </select>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelectedTicketIds(new Set())} data-testid="button-clear-ticket-selection">
            Clear
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto" data-testid="table-tickets-scroll">
          <Table data-testid="table-tickets">
            <TableHeader>
              <TableRow>
                {/* #425 — Bulk select checkbox col */}
                <TableHead className="w-8">
                  <Checkbox
                    checked={tickets && tickets.length > 0 && selectedTicketIds.size === tickets.length}
                    onCheckedChange={(v) => setSelectedTicketIds(v ? new Set(tickets?.map(t => t.id) ?? []) : new Set())}
                    aria-label="Select all"
                    data-testid="checkbox-select-all-tickets"
                  />
                </TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="hidden md:table-cell">Category</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden lg:table-cell">SLA Deadline</TableHead>
                {/* #384 — Assignee column */}
                <TableHead className="hidden sm:table-cell">Assigned To</TableHead>
                <TableHead className="hidden sm:table-cell">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading || isError || !tickets || tickets.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9}>
                    <DataState
                      query={{ isLoading, isError, data: tickets, refetch }}
                      testId="tickets"
                      errorTitle="Failed to load tickets"
                      emptyTitle={ticketCreation.uncertain.includes("create")?"List snapshot is unconfirmed":"No tickets yet"}
                      emptyMessage={ticketCreation.uncertain.includes("create")?
                        "The last authorized list may predate the intent. Reconcile its frozen identity; no empty population is assumed.":
                        "Support tickets will appear here once submitted."}
                      emptyAction={
                        <Button size="sm" className="gap-1 mt-1" onClick={() => setCreateOpen(true)} data-testid="button-empty-create-ticket">
                          <Plus className="w-3.5 h-3.5" /> Create Ticket
                        </Button>
                      }
                      loadingFallback={
                        <div className="space-y-2 py-4">
                          {Array.from({ length: 4 }).map((_, i) => (
                            <Skeleton key={i} className="h-10 w-full" />
                          ))}
                        </div>
                      }
                    >
                      {null}
                    </DataState>
                  </TableCell>
                </TableRow>
              ) : (
                tickets.map((ticket) => (
                  <TableRow
                    key={ticket.id}
                    className="cursor-pointer"
                    onClick={() => openTicketDetail(ticket)}
                    data-testid={`row-ticket-${ticket.id}`}
                  >
                    {/* #425 — Row checkbox */}
                    <TableCell onClick={e => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedTicketIds.has(ticket.id)}
                        onCheckedChange={() => toggleTicketSelect(ticket.id)}
                        aria-label={`Select ticket #${ticket.id}`}
                        data-testid={`checkbox-ticket-${ticket.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium" data-testid={`text-ticket-id-${ticket.id}`}>
                      #{ticket.id}
                      {/* #460 — Contact name; #638 — Contact email */}
                      {ticket.contactId && contacts && (() => {
                        const c = contacts.find(x => x.id === ticket.contactId);
                        if (!c) return null;
                        return (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            <div>{`${c.firstName ?? ""} ${c.lastName ?? ""}`.trim()}</div>
                            {c.email && <div className="text-[11px] opacity-75">{c.email}</div>}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell data-testid={`text-ticket-subject-${ticket.id}`}>{ticket.subject}</TableCell>
                    <TableCell className="hidden md:table-cell" data-testid={`text-ticket-category-${ticket.id}`}>{ticket.category}</TableCell>
                    <TableCell>
                      <Badge variant={getPriorityVariant(ticket.priority)} data-testid={`badge-priority-${ticket.id}`}>
                        {ticket.priority}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${getStatusClasses(ticket.status)}`} data-testid={`badge-status-${ticket.id}`}>
                        {ticket.status}
                      </span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell" data-testid={`text-ticket-sla-${ticket.id}`}>
                      <div className="flex items-center gap-2">
                        {ticket.slaDeadline ? new Date(ticket.slaDeadline).toLocaleString() : "N/A"}
                        {/* #317 — SLA countdown timer */}
                        {ticket.slaDeadline && !isSlaBreached(ticket) && (
                          <span className="text-xs text-muted-foreground" data-testid={`text-sla-countdown-${ticket.id}`}>
                            {formatSlaCountdown(ticket.slaDeadline != null ? String(ticket.slaDeadline) : null, ticket.status ?? "")}
                          </span>
                        )}
                        {isSlaBreached(ticket) && (
                          <Badge variant="destructive" className="text-xs gap-1" data-testid={`badge-sla-breached-${ticket.id}`}>
                            <AlertTriangle className="w-3 h-3" />
                            SLA Breached
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    {/* #362 — Comment count badge */}
                    <TableCell className="hidden md:table-cell" data-testid={`text-ticket-comments-${ticket.id}`}>
                      {(ticket as any).commentCount != null && (ticket as any).commentCount > 0 ? (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          💬 {(ticket as any).commentCount}
                        </span>
                      ) : <span className="text-muted-foreground/40 text-xs">—</span>}
                    </TableCell>
                    {/* #384 — Assignee cell */}
                    <TableCell className="hidden sm:table-cell" data-testid={`text-ticket-assignee-${ticket.id}`}>
                      {(ticket as any).assignedTo || <span className="text-muted-foreground text-xs">Unassigned</span>}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell" data-testid={`text-ticket-created-${ticket.id}`}>
                      {ticket.createdAt ? new Date(ticket.createdAt).toLocaleDateString() : "N/A"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="dialog-ticket-detail">
          <DialogHeader>
            <DialogTitle>Ticket #{selectedTicket?.id}</DialogTitle>
          </DialogHeader>
          {selectedTicket && (
            <div className="space-y-4 pt-2">
              {/* #614 — Contact info in ticket detail */}
              {selectedTicket.contactId && contacts && (() => {
                const c = contacts.find(x => x.id === selectedTicket.contactId);
                return c ? (
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm flex items-center gap-3" data-testid="ticket-detail-contact">
                    <div>
                      <div className="font-medium">{c.firstName} {c.lastName}</div>
                      {c.email && <div className="text-xs text-muted-foreground">{c.email}</div>}
                    </div>
                  </div>
                ) : null;
              })()}
              <div className="space-y-2">
                <div className="text-sm text-muted-foreground">Subject</div>
                <div className="font-medium" data-testid="text-detail-subject">{selectedTicket.subject}</div>
              </div>
              <div className="space-y-2">
                <div className="text-sm text-muted-foreground">Description</div>
                <div className="text-sm whitespace-pre-wrap" data-testid="text-detail-description">{selectedTicket.description}</div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Category</span>
                  <div className="font-medium" data-testid="text-detail-category">{selectedTicket.category}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Priority</span>
                  <div>
                    <Badge variant={getPriorityVariant(selectedTicket.priority)} data-testid="badge-detail-priority">
                      {selectedTicket.priority}
                    </Badge>
                  </div>
                </div>
              </div>

              {isSlaBreached(selectedTicket) && (
                <Badge variant="destructive" className="gap-1" data-testid="badge-detail-sla-breached">
                  <AlertTriangle className="w-3 h-3" />
                  SLA Breached
                </Badge>
              )}

              <div className="border-t pt-3 space-y-3">
                <Button
                  variant="outline"
                  className="gap-2 w-full"
                  onClick={() => classifyMutation.mutate(selectedTicket.id)}
                  disabled={classifyMutation.isPending}
                  data-testid="button-ai-classify-ticket"
                >
                  {classifyMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  AI Classify & Suggest Response
                </Button>
                {aiResult && (
                  <Card>
                    <CardContent className="p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-sm font-medium">AI Analysis</span>
                        <Badge variant="outline" className="text-xs no-default-hover-elevate">{aiResult.estimatedResolutionHours}h est.</Badge>
                      </div>
                      <div className="flex gap-1 flex-wrap">
                        {aiResult.tags.map(tag => (
                          <Badge key={tag} variant="secondary" className="text-xs no-default-hover-elevate">{tag}</Badge>
                        ))}
                      </div>
                      <div className="text-sm text-muted-foreground bg-muted/50 p-2 rounded-md" data-testid="text-ai-suggested-response">
                        <div className="font-medium text-xs mb-1">Suggested Response:</div>
                        {aiResult.suggestedResponse}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 text-xs"
                        onClick={() =>
                          setDraftToInsert({ text: aiResult.suggestedResponse, nonce: Date.now() })
                        }
                        data-testid="button-insert-ai-response"
                      >
                        <MessageSquareText className="w-3.5 h-3.5" />
                        Insert into Reply
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        This only fills the reply box below — nothing is sent until you review it and click Send Reply.
                      </p>
                    </CardContent>
                  </Card>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={editStatus} onValueChange={setEditStatus}>
                    <SelectTrigger data-testid="select-edit-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORT_STAGES.map((s) => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Assigned To</Label>
                  <Input
                    value={editAssignedTo}
                    onChange={(e) => setEditAssignedTo(e.target.value)}
                    placeholder="Assign to..."
                    data-testid="input-edit-assigned-to"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setDetailOpen(false)} data-testid="button-cancel-ticket-edit">
                  Cancel
                </Button>
                <Button onClick={handleUpdateTicket} disabled={updateTicketMutation.isPending} data-testid="button-save-ticket">
                  {updateTicketMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </div>

              <Separator />

              <TicketConversation
                ticket={selectedTicket}
                draftToInsert={draftToInsert}
                onDraftInserted={() => setDraftToInsert(null)}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}