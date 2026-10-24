import { PageTitle } from "@/components/ui/page-header";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Database } from "lucide-react";
import type { DataDeleteRequest } from "@shared/schema";
import {useState} from "react";
import {useAuth} from "@/hooks/use-auth";
import {Input} from "@/components/ui/input";
import { ReviewOwnershipPanel } from "@/components/dashboard/ReviewOwnershipPanel";

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-yellow-500 text-black" },
  processing: { label: "Under administrative review", className: "bg-blue-600 text-white" },
  completed: { label: "Review completed — not erased", className: "bg-green-600 text-white" },
  denied: { label: "Review denied", className: "bg-red-600 text-white" },
};

export default function DataRequests() {
  const { toast } = useToast();
  const {user}=useAuth();
  const [reviews,setReviews]=useState<Record<number,{subjectContactId:string;reviewEvidence:string;retentionReason:string}>>({});

  const { data: requests, isLoading,isError,refetch } = useQuery<DataDeleteRequest[]>({
    queryKey: ["/api/data-requests"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const request=requests?.find(row=>row.id===id);
      const review=reviews[id] ?? (request?{subjectContactId:String(request.subjectContactId ?? ""),
        reviewEvidence:request.reviewEvidence ?? "",retentionReason:request.retentionReason ?? ""}:undefined);
      if(!request || !review || !user?.id) throw new Error("Current review and account unavailable");
      await apiRequest("PUT", `/api/data-requests/${id}`, {
        status,expectedVersion:request.version,expectedActorId:user.id,expectedAccountVersion:user.accountVersion,
        subjectContactId:Number(review.subjectContactId),reviewEvidence:review.reviewEvidence,retentionReason:review.retentionReason,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/data-requests"] });
      toast({ title:"Administrative review saved",description:"No erasure was performed. Retained evidence is unchanged." });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if(isError || !requests) return <div role="alert">Privacy requests unavailable. <Button onClick={()=>void refetch()}>Retry</Button></div>;

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="page-data-requests">
      <div className="flex flex-wrap items-center gap-3">
        <Database className="w-6 h-6 text-foreground" />
        <PageTitle className="text-2xl font-bold text-foreground" data-testid="text-data-requests-heading">
          Data Requests
        </PageTitle>
        <Badge variant="secondary" data-testid="badge-data-requests-count">
          {requests?.length || 0} total
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">These controls record administrative review only. A matching record is not proof of subject ownership or executed erasure. Consent, audit, intake and send evidence remain retained.</p>

      <ReviewOwnershipPanel />

      <Card data-testid="card-data-requests-table">
        <CardContent className="pt-6">
          {!requests || requests.length === 0 ? (
            <p className="text-center text-muted-foreground py-8" data-testid="text-no-requests">
              No data requests yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table data-testid="table-data-requests">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Request Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests.map((req) => {
                    const config = STATUS_CONFIG[req.status || "pending"] || {label:"Unknown review state",className:""};
                    const review=reviews[req.id] ?? {subjectContactId:String(req.subjectContactId ?? ""),reviewEvidence:req.reviewEvidence ?? "",retentionReason:req.retentionReason ?? ""};
                    const setField=(field:keyof typeof review,value:string)=>setReviews(current=>({...current,[req.id]:{...review,[field]:value}}));
                    return (
                      <TableRow key={req.id} data-testid={`row-data-request-${req.id}`}>
                        <TableCell className="whitespace-nowrap text-sm" data-testid={`text-request-date-${req.id}`}>
                          {req.createdAt ? new Date(req.createdAt).toLocaleDateString() : "N/A"}
                        </TableCell>
                        <TableCell className="font-medium" data-testid={`text-request-name-${req.id}`}>
                          {req.fullName}
                        </TableCell>
                        <TableCell data-testid={`text-request-email-${req.id}`}>
                          {req.email}
                        </TableCell>
                        <TableCell data-testid={`text-request-type-${req.id}`}>
                          {req.requestType}
                        </TableCell>
                        <TableCell>
                          <Badge className={config.className} data-testid={`badge-request-status-${req.id}`}>
                            {config.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-2 mb-2">
                            <Input aria-label={`Subject contact ID for request ${req.id}`} placeholder="Explicit contact ID (matching email)" value={review.subjectContactId} onChange={event=>setField("subjectContactId",event.target.value)} />
                            <Input aria-label={`Review evidence for request ${req.id}`} placeholder="Administrative review evidence reference" value={review.reviewEvidence} onChange={event=>setField("reviewEvidence",event.target.value)} />
                            <Input aria-label={`Retention reason for request ${req.id}`} placeholder="Retention / blocker reason" value={review.retentionReason} onChange={event=>setField("retentionReason",event.target.value)} />
                            <p className="text-xs text-muted-foreground">Execution: {req.executionState}. Version {req.version}.</p>
                          </div>
                          <Select
                            disabled={updateMutation.isPending || !review.subjectContactId || !review.reviewEvidence.trim() || !review.retentionReason.trim()}
                            value={req.status || "pending"}
                            onValueChange={(value) => updateMutation.mutate({ id: req.id, status: value })}
                          >
                            <SelectTrigger className="w-[140px]" data-testid={`select-request-action-${req.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="pending">Pending</SelectItem>
                               <SelectItem value="processing">Administrative review</SelectItem>
                               <SelectItem value="completed">Review complete — not erased</SelectItem>
                               <SelectItem value="denied">Review denied</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
