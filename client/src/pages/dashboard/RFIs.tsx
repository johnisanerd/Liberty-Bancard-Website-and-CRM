import { PageTitle } from "@/components/ui/page-header";
import { useState,useEffect } from "react";
import {useCrmQuery as useQuery,useCrmActorIdentity} from "@/hooks/use-crm-query";
import {c4WorkspaceSelection,rfiViews,rfiUrl} from "@/lib/crm-destination-state";
import {CrmDataState} from "@/components/crm/CrmPresentation";
import {useSearch,useLocation} from "wouter";
import {useAuthorizedSelectedRecord} from "@/hooks/use-authorized-selected-record";
import { useMutation } from "@tanstack/react-query";
import {invalidateWorkFacts} from "@/hooks/use-work-commands";
import {useRfiCommand} from "@/hooks/use-rfi-command";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, FileQuestion, MessageSquare, Clock, CheckCircle2, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Rfi, Contact } from "@shared/schema";
import { RFI_CATEGORIES, RFI_STATUSES } from "@shared/schema";

const statusColors: Record<string, string> = {
  Open: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  "In Progress": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  "Waiting on Merchant": "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  Responded: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  Closed: "bg-muted text-muted-foreground",
};

const priorityColors: Record<string, string> = {
  Low: "bg-muted text-muted-foreground",
  Normal: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  High: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  Urgent: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

export default function RFIs() {
  const { toast } = useToast();
  const commands=useRfiCommand();
  const [createOpen, setCreateOpen] = useState(false);
  const [respondRfi, setRespondRfi] = useState<Rfi | null>(null);
  const [responseText, setResponseText] = useState("");
  const viewState=c4WorkspaceSelection(useSearch(),"rfiView",rfiViews,"all");
  const filterStatus=viewState.value;
  const setFilterStatus=(value:typeof rfiViews[number])=>navigateRfi(rfiUrl(window.location.search,window.location.hash,value));

  const [newSubject, setNewSubject] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newCategory, setNewCategory] = useState("General");
  const [newPriority, setNewPriority] = useState("Normal");
  const [newAssignedTo, setNewAssignedTo] = useState("");
  const [newRequestedBy, setNewRequestedBy] = useState("");
  const [newContactId, setNewContactId] = useState("");

  const { data: allRfis, isLoading,isError,error,refetch } = useQuery<Rfi[]>({
    queryKey: ["/api/rfis"],enabled:!viewState.issues.length,
    queryFn:async({signal})=>{
      const res=await fetch("/api/rfis",{credentials:"include",signal});
      if(!res.ok)throw new Error(`${res.status}: RFI records unavailable`);
      const rows=await res.json();
      if(!Array.isArray(rows)||rows.some(row=>!Number.isInteger(row?.id)))throw new Error("RFI record shape unavailable");
      return rows;
    },
  });
  const readAvailable=!isLoading&&!isError&&!viewState.issues.length&&!!allRfis;
  const selectedContext=useAuthorizedSelectedRecord<Rfi>("/api/rfis",useSearch());
  const [,navigateRfi]=useLocation();
  const { data: contactsRes,isLoading:contactsLoading,isError:contactsError,refetch:refetchContacts } =
    useQuery<{ data: Contact[]; total: number }>({ queryKey: ["/api/contacts"],enabled:createOpen&&readAvailable });
  const contacts = contactsLoading||contactsError?undefined:contactsRes?.data;
  const actorIdentity=useCrmActorIdentity();
  useEffect(()=>{
    setCreateOpen(false);setRespondRfi(null);setResponseText("");resetForm();
  },[actorIdentity]);

  const createMutation = useMutation({
    mutationFn: async (body: any) => {
      if(!readAvailable)throw new Error("Current RFI read required before creating local work");
      return commands.execute(body);
    },
    onError:(err:Error)=>toast({title:"Local RFI creation failed or unconfirmed",description:`${err.message}. No automatic retry was performed; reconcile the record before retrying an unknown outcome.`,variant:"destructive"}),
    onSuccess: (_result,body) => {
      void invalidateWorkFacts();
      toast({ title: "Local RFI created",description:"No provider delivery was attempted." });
      setCreateOpen(false);
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, body,row }: { id: number; body: any;row:Rfi }) => {
      if(!readAvailable||!allRfis?.some(row=>row.id===id))throw new Error("Current matching RFI read required");
      return commands.execute(body,row);
    },
    onError:(err:Error)=>toast({title:"Local RFI update failed or unconfirmed",description:err.message,variant:"destructive"}),
    onSuccess: () => {
      void invalidateWorkFacts();
      toast({ title: "RFI updated" });
    },
  });

  const respondMutation = useMutation({
    mutationFn: async ({ id, response }: { id: number; response: string }) => {
      if(!readAvailable||!allRfis?.some(row=>row.id===id))throw new Error("Current matching RFI read required");
      if(!respondRfi||respondRfi.id!==id)throw new Error("Captured response context unavailable");
      return commands.execute({
        response,
        status: "Responded",
      },respondRfi);
    },
    onError:(err:Error)=>toast({title:"Local response failed or unconfirmed",description:err.message,variant:"destructive"}),
    onSuccess: () => {
      void invalidateWorkFacts();
      toast({ title: "Local RFI response recorded",description:"No email or provider delivery is established by this record update." });
      setRespondRfi(null);
      setResponseText("");
    },
  });

  function resetForm() {
    setNewSubject("");
    setNewDescription("");
    setNewCategory("General");
    setNewPriority("Normal");
    setNewAssignedTo("");
    setNewRequestedBy("");
    setNewContactId("");
  }

  function handleCreate() {
    if (!newSubject) return;
    createMutation.mutate({
      subject: newSubject,
      description: newDescription || undefined,
      category: newCategory,
      priority: newPriority,
      assignedTo: newAssignedTo || undefined,
      requestedBy: newRequestedBy || undefined,
      contactId: newContactId ? Number(newContactId) : undefined,
    });
  }

  const loadedRfis=readAvailable?allRfis || []:[];
  const filteredRfis = loadedRfis.filter((rfi) => {
    if (filterStatus === "all") return true;
    return rfi.status === filterStatus;
  });

  const openCount = loadedRfis.filter((r) => r.status === "Open").length;
  const inProgressCount = loadedRfis.filter((r) => r.status === "In Progress").length;
  const respondedCount = loadedRfis.filter((r) => r.status === "Responded").length;
  const countText=(value:number)=>isLoading?"Loading":readAvailable?value:"Unavailable";

  return (
    <div className="space-y-6" data-testid="page-rfis">
      {commands.uncertain.map(key=><div key={key} role="alert" data-testid={`rfi-uncertain-${key}`} className="rounded-lg border p-4">
        Local RFI intent {key} is unconfirmed. Its original payload/version is retained; no native delivery was attempted.
        <Button data-testid={`button-retry-rfi-${key}`} onClick={()=>void commands.retry(key).then(()=>toast({title:"Captured local RFI intent confirmed"}))
          .catch((error:Error)=>toast({title:"RFI intent remains unconfirmed",description:error.message,variant:"destructive"}))}>
          Retry frozen intent
        </Button>
      </div>)}
      {(selectedContext.isError || selectedContext.invalid) && <div role="alert">Requested record unavailable.
        {!selectedContext.invalid && <Button onClick={()=>void selectedContext.refetch()}>Retry selected record</Button>}
      </div>}
      <Dialog open={!!selectedContext.data && !selectedContext.isError && selectedContext.id!==null} onOpenChange={open=>{if(!open) navigateRfi(rfiUrl(window.location.search,window.location.hash,undefined,true));}}>
        <DialogContent><DialogHeader><DialogTitle>{selectedContext.data?.subject}</DialogTitle></DialogHeader>
          <p className="whitespace-pre-wrap">{selectedContext.data?.description}</p>
          <p>Status: {selectedContext.data?.status}</p>
          <p className="text-sm text-muted-foreground">Authorized record context. No reply or workflow was executed.</p>
        </DialogContent>
      </Dialog>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <PageTitle className="text-2xl font-bold" data-testid="text-rfis-title">Requests for Information</PageTitle>
          <p className="text-sm text-muted-foreground">Track and manage information requests across teams</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2" disabled={!readAvailable} data-testid="button-create-rfi">
              <Plus className="w-4 h-4" />
              New RFI
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create RFI</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>Subject</Label>
                <Input
                  value={newSubject}
                  onChange={(e) => setNewSubject(e.target.value)}
                  placeholder="What information is needed?"
                  data-testid="input-rfi-subject"
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Detailed description of the information request..."
                  data-testid="input-rfi-description"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select value={newCategory} onValueChange={setNewCategory}>
                    <SelectTrigger data-testid="select-rfi-category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RFI_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Priority</Label>
                  <Select value={newPriority} onValueChange={setNewPriority}>
                    <SelectTrigger data-testid="select-rfi-priority">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Low">Low</SelectItem>
                      <SelectItem value="Normal">Normal</SelectItem>
                      <SelectItem value="High">High</SelectItem>
                      <SelectItem value="Urgent">Urgent</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Assigned To</Label>
                <Input
                  value={newAssignedTo}
                  onChange={(e) => setNewAssignedTo(e.target.value)}
                  placeholder="Eligible account email or ID"
                  data-testid="input-rfi-assigned"
                />
              </div>
              <div className="space-y-2">
                <Label>Requested By</Label>
                <Input
                  value={newRequestedBy}
                  onChange={(e) => setNewRequestedBy(e.target.value)}
                  placeholder="Who is requesting this info?"
                  data-testid="input-rfi-requested-by"
                />
              </div>
              {contactsLoading&&<CrmDataState state="loading" message="Contact choices loading; no complete directory is claimed."/>}
              {contactsError&&<CrmDataState state="unavailable" message="Optional contact choices unavailable; this is not no eligible contacts." onRetry={()=>void refetchContacts()}/>}
              {contacts&&<p className="text-xs text-muted-foreground">Contact choices describe the loaded directory page only. A missing choice does not prove no eligible contact exists.</p>}
              {contacts && contacts.length > 0 && (
                <div className="space-y-2">
                  <Label>Related Contact (optional)</Label>
                  <Select value={newContactId} onValueChange={(v) => setNewContactId(v === "_none" ? "" : v)}>
                    <SelectTrigger data-testid="select-rfi-contact">
                      <SelectValue placeholder="Select contact..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">None</SelectItem>
                      {contacts.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.firstName} {c.lastName} {c.companyName ? `(${c.companyName})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <Button
                onClick={handleCreate}
                disabled={!readAvailable || !newSubject || createMutation.isPending}
                className="w-full"
                data-testid="button-submit-rfi"
              >
                {createMutation.isPending ? "Creating..." : "Create RFI"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-blue-100 dark:bg-blue-900/50 flex items-center justify-center">
              <FileQuestion className="w-5 h-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <div className={`${readAvailable?"text-2xl":"text-sm"} font-bold`} data-testid="text-rfi-open-count">{countText(openCount)}</div>
              <div className="text-xs text-muted-foreground">Open</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-yellow-100 dark:bg-yellow-900/50 flex items-center justify-center">
              <Clock className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
            </div>
            <div>
              <div className={`${readAvailable?"text-2xl":"text-sm"} font-bold`} data-testid="text-rfi-progress-count">{countText(inProgressCount)}</div>
              <div className="text-xs text-muted-foreground">In Progress</div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-green-100 dark:bg-green-900/50 flex items-center justify-center">
              <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <div className={`${readAvailable?"text-2xl":"text-sm"} font-bold`} data-testid="text-rfi-responded-count">{countText(respondedCount)}</div>
              <div className="text-xs text-muted-foreground">Responded</div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Label className="text-sm text-muted-foreground">Filter:</Label>
        <div className="flex gap-1.5 flex-wrap">
          <Button
            variant={filterStatus === "all" ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterStatus("all")}
            data-testid="button-filter-all"
          >
            All ({countText(loadedRfis.length)})
          </Button>
          {RFI_STATUSES.map((s) => {
            const count = loadedRfis.filter((r) => r.status === s).length;
            return (
              <Button
                key={s}
                variant={filterStatus === s ? "default" : "outline"}
                size="sm"
                onClick={() => setFilterStatus(s)}
                data-testid={`button-filter-${s.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {s} ({countText(count)})
              </Button>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">Counts describe returned authorized local RFI records; status filtering is local to that collection. No shared snapshot clock, period or native delivery receipt is supplied.</p>
      {viewState.issues.length?<CrmDataState state="unavailable" message="Invalid/conflicting RFI view; no default collection read was requested."/>
      :isError?<CrmDataState state={/^403:/.test(error?.message||"")?"denied":"unavailable"} message="RFI records unavailable; this is not an empty queue." onRetry={()=>void refetch()}/>
      :isLoading ? (
        <Card><CardContent className="p-8 text-center text-muted-foreground">Loading...</CardContent></Card>
      ) : !filteredRfis.length ? (
        <Card>
          <CardContent className="p-12 text-center">
            <FileQuestion className="w-12 h-12 mx-auto text-muted-foreground/50 mb-4" />
            <h3 className="font-semibold mb-2">No RFIs Found</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {filterStatus !== "all"
                ? `No RFIs with status "${filterStatus}". Try a different filter.`
                : "Create your first Request for Information to get started."}
            </p>
            {filterStatus === "all" && (
              <Button onClick={() => setCreateOpen(true)} data-testid="button-create-first-rfi">
                <Plus className="w-4 h-4 mr-2" />
                Create RFI
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <ScrollArea className="max-h-[600px]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Assigned To</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRfis.map((rfi) => (
                  <TableRow key={rfi.id} data-testid={`row-rfi-${rfi.id}`}>
                    <TableCell className="font-mono text-sm">#{rfi.id}</TableCell>
                    <TableCell>
                      <div className="max-w-[200px]">
                        <div className="font-medium truncate" data-testid={`text-rfi-subject-${rfi.id}`}>{rfi.subject}</div>
                        {rfi.description && (
                          <div className="text-xs text-muted-foreground truncate">{rfi.description}</div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{rfi.category}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={priorityColors[rfi.priority || "Normal"]}>{rfi.priority}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[rfi.status || "Open"]}>{rfi.status}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{rfi.assignedTo || "-"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {rfi.createdAt ? new Date(rfi.createdAt).toLocaleDateString() : "-"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        {rfi.status !== "Closed" && rfi.status !== "Responded" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { setRespondRfi(rfi); setResponseText(rfi.response || ""); }}
                            data-testid={`button-respond-rfi-${rfi.id}`}
                          >
                            <MessageSquare className="w-3.5 h-3.5 mr-1" />
                            Respond
                          </Button>
                        )}
                        {rfi.status === "Open" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => updateMutation.mutate({ id: rfi.id,row:rfi, body: { status: "In Progress" } })}
                            data-testid={`button-start-rfi-${rfi.id}`}
                          >
                            Start
                          </Button>
                        )}
                        {rfi.status === "Responded" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => updateMutation.mutate({ id: rfi.id,row:rfi, body: { status: "Closed" } })}
                            data-testid={`button-close-rfi-${rfi.id}`}
                          >
                            Close
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        </Card>
      )}

      <Dialog open={!!respondRfi} onOpenChange={(open) => !open && setRespondRfi(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Respond to RFI</DialogTitle>
          </DialogHeader>
          {respondRfi && (
            <div className="space-y-4">
              <div>
                <Label className="text-muted-foreground text-xs">Subject</Label>
                <p className="font-medium" data-testid="text-respond-subject">{respondRfi.subject}</p>
              </div>
              {respondRfi.description && (
                <div>
                  <Label className="text-muted-foreground text-xs">Description</Label>
                  <p className="text-sm">{respondRfi.description}</p>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Badge variant="outline">{respondRfi.category}</Badge>
                <Badge className={priorityColors[respondRfi.priority || "Normal"]}>{respondRfi.priority}</Badge>
              </div>
              <div className="space-y-2">
                <Label>Your Response</Label>
                <Textarea
                  value={responseText}
                  onChange={(e) => setResponseText(e.target.value)}
                  placeholder="Enter your response to this RFI..."
                  className="min-h-[120px]"
                  data-testid="input-rfi-response"
                />
              </div>
              <Button
                onClick={() => respondRfi && respondMutation.mutate({ id: respondRfi.id, response: responseText })}
                disabled={!responseText || respondMutation.isPending}
                className="w-full"
                data-testid="button-submit-response"
              >
                {respondMutation.isPending ? "Submitting..." : "Submit Response"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
