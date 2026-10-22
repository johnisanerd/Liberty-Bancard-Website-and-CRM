import { CrmPage, CrmPageHeader } from "@/components/crm/CrmPresentation";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Copy,
  ExternalLink,
  Send,
  MoreVertical,
  Zap,
  CheckCircle,
  Clock,
  AlertCircle,
  Search,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { format } from "date-fns";
import type { CoBrandedProposal, Contact } from "@shared/schema";

type ProposalWithContact = CoBrandedProposal & {
  contact: Pick<Contact, "id" | "firstName" | "lastName" | "email" | "ghlContactId"> | null;
  partnerName: string | null;
  viewerUrl?: string;
};

type SortKey = "merchantName" | "status" | "viewCount" | "createdAt";

function SortTh({
  label, skey, sortKey, sortDir, onSort,
}: {
  label: string; skey: SortKey; sortKey: SortKey; sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === skey;
  return (
    <button
      className="flex items-center gap-1 hover:text-foreground transition-colors whitespace-nowrap"
      onClick={() => onSort(skey)}
      data-testid={`sort-${skey}`}
    >
      {label}
      {active
        ? sortDir === "asc" ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
        : <ChevronDown className="w-3 h-3 opacity-30" />}
    </button>
  );
}

export default function CoBrandedProposals() {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [selectedProposal, setSelectedProposal] = useState<ProposalWithContact | null>(null);
  const [workflowKey, setWorkflowKey] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const { data: proposals = [], isLoading } = useQuery<ProposalWithContact[]>({
    queryKey: ["/api/co-branded-proposals"],
  });

  const sendMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/co-branded-proposals/${id}/send`);
    },
    onSuccess: () => {
      toast({ title: "Proposal sent successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/co-branded-proposals"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to send proposal",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const enrollMutation = useMutation({
    mutationFn: async ({ id, workflowKey }: { id: number; workflowKey: string }) => {
      await apiRequest("POST", `/api/co-branded-proposals/${id}/enroll-workflow`, { workflowKey });
    },
    onSuccess: () => {
      toast({ title: "Enrolled in workflow successfully" });
      setSelectedProposal(null);
      setWorkflowKey("");
    },
    onError: (err: Error) => {
      toast({
        title: "Enrollment failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const copyLink = (token: string) => {
    const url = `${window.location.origin}/co-branded-proposal/${token}`;
    navigator.clipboard.writeText(url);
    toast({ title: "Link copied to clipboard" });
  };

  const filteredProposals = proposals.filter((p) =>
    p.merchantName?.toLowerCase().includes(search.toLowerCase()) ||
    p.token.toLowerCase().includes(search.toLowerCase())
  );

  const sortedProposals = [...filteredProposals].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    switch (sortKey) {
      case "merchantName": return dir * (a.merchantName ?? "").localeCompare(b.merchantName ?? "");
      case "status":       return dir * (a.status ?? "").localeCompare(b.status ?? "");
      case "viewCount":    return dir * ((a.viewCount ?? 0) - (b.viewCount ?? 0));
      case "createdAt":    return dir * (new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
      default: return 0;
    }
  });

  return (
    <CrmPage className="space-y-6">
      <CrmPageHeader title="Co-Branded Proposals" description="Manage and track all co-branded partner proposals" titleTestId="text-page-title" />

      <div className="flex items-center gap-2 max-w-sm">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search merchants..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-proposals"
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <SortTh label="Merchant" skey="merchantName" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                </TableHead>
                <TableHead>Partner</TableHead>
                <TableHead>
                  <SortTh label="Status" skey="status" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                </TableHead>
                <TableHead>
                  <SortTh label="Views" skey="viewCount" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                </TableHead>
                <TableHead>Accepted</TableHead>
                <TableHead>
                  <SortTh label="Created" skey="createdAt" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                </TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : sortedProposals.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center h-24 text-muted-foreground">
                    No proposals found.
                  </TableCell>
                </TableRow>
              ) : (
                sortedProposals.map((proposal) => (
                  <TableRow key={proposal.id} data-testid={`row-proposal-${proposal.id}`}>
                    <TableCell>
                      <div className="font-medium">{proposal.merchantName}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {proposal.token}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {proposal.partnerName ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={proposal.status === "accepted" ? "default" : "secondary"}
                        className="capitalize"
                      >
                        {proposal.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm tabular-nums" data-testid={`text-view-count-${proposal.id}`}>
                      {proposal.viewCount ?? 0}
                    </TableCell>
                    <TableCell className="text-sm" data-testid={`text-accepted-at-${proposal.id}`}>
                      {proposal.acceptedAt
                        ? format(new Date(proposal.acceptedAt), "MMM d, yyyy")
                        : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {proposal.createdAt ? format(new Date(proposal.createdAt), "MMM d, yyyy") : "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" data-testid={`button-actions-${proposal.id}`}>
                            <MoreVertical className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem
                            onClick={() => copyLink(proposal.token)}
                            className="gap-2"
                            data-testid={`button-copy-link-${proposal.id}`}
                          >
                            <Copy className="w-4 h-4" /> Copy Link
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <a
                              href={`/co-branded-proposal/${proposal.token}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="gap-2 w-full cursor-pointer"
                              data-testid={`button-preview-${proposal.id}`}
                            >
                              <ExternalLink className="w-4 h-4" /> Preview
                            </a>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => sendMutation.mutate(proposal.id)}
                            disabled={sendMutation.isPending}
                            className="gap-2"
                            data-testid={`button-send-ghl-${proposal.id}`}
                          >
                            <Send className="w-4 h-4" />
                            {sendMutation.isPending ? "Sending..." : "Send via GHL"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setSelectedProposal(proposal)}
                            className="gap-2 text-primary focus:text-primary"
                            data-testid={`button-enroll-workflow-${proposal.id}`}
                          >
                            <Zap className="w-4 h-4" /> Enroll in Workflow
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={!!selectedProposal} onOpenChange={(open) => !open && setSelectedProposal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enroll in GHL Workflow</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Select Workflow</label>
              <Select value={workflowKey} onValueChange={setWorkflowKey}>
                <SelectTrigger data-testid="select-workflow">
                  <SelectValue placeholder="Choose a workflow..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="proposal_followup">Proposal Follow-Up</SelectItem>
                  <SelectItem value="long_term_nurture">Long-Term Nurture</SelectItem>
                  <SelectItem value="statement_analyzed">Statement Analyzed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={() => setSelectedProposal(null)}>
                Cancel
              </Button>
              <Button
                disabled={!workflowKey || enrollMutation.isPending}
                onClick={() =>
                  selectedProposal &&
                  enrollMutation.mutate({ id: selectedProposal.id, workflowKey })
                }
                data-testid="button-confirm-enroll"
              >
                {enrollMutation.isPending ? "Enrolling..." : "Enroll Now"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </CrmPage>
  );
}
