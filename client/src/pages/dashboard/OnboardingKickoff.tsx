import { useState, useRef, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation } from "@tanstack/react-query";
import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { useSearch } from "wouter";
import { parseLocalEntityId } from "@/lib/crm-destination-state";
import { CrmDataState } from "@/components/crm/CrmPresentation";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Loader2 } from "lucide-react";
import type { Contact, Deal } from "@shared/schema";
import type { OnboardingPreparationFields, OnboardingPreparationStatus } from "@shared/onboarding-preparation";
import { onboardingPreparationFields } from "@shared/onboarding-preparation";
import { useAuth } from "@/hooks/use-auth";
import { actorIdentity } from "@/lib/queryClient";

const UNDERWRITING_DOCS = [
  "Business License",
  "Bank Statement",
  "Processing Statement",
  "Voided Check",
  "Government ID",
] as const;

const formSchema = z.object({
  contactId: z.string().min(1, "Contact is required"),
  dealId: z.string().min(1, "Deal is required"),
  terminalNeeded: onboardingPreparationFields.shape.terminalNeeded,
  goLiveDate: onboardingPreparationFields.shape.goLiveDate,
  fundingNotes: z.string().max(2000).optional(),
  underwritingDocs: z.array(z.string()).default([]),
});

type FormValues = z.infer<typeof formSchema>;

export default function OnboardingKickoff() {
  const { toast } = useToast();
  const {user}=useAuth();
  const actor=actorIdentity(user),actorRef=useRef(actor);actorRef.current=actor;
  const intent=useRef<{id:string;actor:string;dealId:number;fields:OnboardingPreparationFields}|null>(null);
  const [captured,setCaptured]=useState(false);
  const [result,setResult]=useState<OnboardingPreparationStatus|null>(null);
  useEffect(()=>{intent.current=null;setCaptured(false);setResult(null);},[actor]);
  const context=new URLSearchParams(useSearch());
  const contextContact=parseLocalEntityId("contactId",context.get("contactId") ?? "")?.value;
  const contextDeal=parseLocalEntityId("dealId",context.get("dealId") ?? "")?.value;
  const [selectedContactId, setSelectedContactId] = useState<string>(contextContact ? String(contextContact) : "");
  const [contactSearch,setContactSearch]=useState("");
  const [contactOffset,setContactOffset]=useState(0);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      contactId: contextContact ? String(contextContact) : "",
      dealId: contextDeal ? String(contextDeal) : "",
      terminalNeeded: undefined,
      goLiveDate: "",
      fundingNotes: "",
      underwritingDocs: [],
    },
  });

  const { data: contactsRes, isLoading: contactsLoading, isError: contactsError, refetch: retryContacts } = useQuery<{ data: Contact[]; limit:number; offset:number }>({
    queryKey: ["/api/contacts",{search:contactSearch,limit:50,offset:contactOffset,recordClass:"production"}],
    queryFn:async({signal})=>{
      const params=new URLSearchParams({search:contactSearch,limit:"50",offset:String(contactOffset),recordClass:"production"});
      const data=await (await apiRequest("GET",`/api/contacts?${params}`,undefined,undefined,signal)).json();
      if(!Array.isArray(data.data) || data.limit!==50 || data.offset!==contactOffset)
        throw new Error("Contact page identity unavailable");
      return data;
    },
  });
  const exactContact=useQuery<Contact>({
    queryKey:["/api/contacts",selectedContactId,"kickoff-exact"],
    queryFn:async({signal})=>(await apiRequest("GET",`/api/contacts/${selectedContactId}`,undefined,undefined,signal)).json(),
    enabled:!!selectedContactId,
  });
  const contacts = [...(contactsRes?.data ?? []),
    ...(exactContact.data && !contactsRes?.data.some(contact=>contact.id===exactContact.data.id) ? [exactContact.data] : [])];

  const { data: dealsRes, isLoading: dealsLoading, isError: dealsError, refetch: retryDeals } = useQuery<{ deals: Deal[] }>({
    queryKey: ["/api/contacts",selectedContactId,"detail",{section:"deals"}],
    queryFn:async({signal})=>(await apiRequest("GET",`/api/contacts/${selectedContactId}/detail?section=deals`,undefined,undefined,signal)).json(),
    enabled:!!selectedContactId,
  });
  const deals = dealsRes?.deals;

  const contactDeals = deals?.filter(
    (d) => d.contactId === Number(selectedContactId)
  ) || [];
  const selectedDealId=Number(form.watch("dealId"));
  useEffect(()=>setResult(null),[selectedContactId,selectedDealId]);
  const preparation=useQuery<{expectedSourceVersion:string;sourceDealId:number;selectedDealId:number;
    contactId:number;onboardingDealId:number|null;latestCommand:OnboardingPreparationStatus|null}>({
    queryKey:["/api/deals",selectedDealId,"onboarding-preparation"],
    queryFn:async({signal})=>{
      const data=await (await apiRequest("GET",`/api/deals/${selectedDealId}/onboarding-preparation`,undefined,undefined,signal)).json();
      if(typeof data.expectedSourceVersion!=="string" || data.contactId!==Number(selectedContactId) ||
        data.selectedDealId!==selectedDealId)throw new Error("Exact preparation context unavailable");
      return data;
    },enabled:!!selectedDealId && !!selectedContactId,
  });
  const refresh=async()=>{
    await Promise.all([
      queryClient.invalidateQueries({queryKey:["/api/deals"]}),
      queryClient.invalidateQueries({queryKey:["/api/tasks"]}),
      queryClient.invalidateQueries({queryKey:["/api/contacts",selectedContactId,"detail"]}),
      queryClient.invalidateQueries({queryKey:["/api/onboarding"]}),
    ]);
  };

  const submitMutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const contactId = Number(values.contactId);
      const source=contactDeals.find(deal=>deal.id===Number(values.dealId));
      if(!source || source.contactId!==contactId || source.archivedAt)
        throw new Error("Selected source deal relationship unavailable. Reload exact context.");
      if(!preparation.data || preparation.isError || !user || !Number.isInteger(user.accountVersion))
        throw new Error("Reload exact actor and source preparation authority.");
      const fields=onboardingPreparationFields.parse({contactId,terminalNeeded:values.terminalNeeded,
        goLiveDate:values.goLiveDate,fundingNotes:values.fundingNotes,underwritingDocs:values.underwritingDocs,
        expectedSourceVersion:preparation.data.expectedSourceVersion,expectedActorId:user.id,
        expectedAccountVersion:user.accountVersion});
      const stored=intent.current;
      if(stored && (stored.actor!==actor || stored.dealId!==source.id || JSON.stringify(stored.fields)!==JSON.stringify(fields)))
        throw new Error("Captured intent differs. Read its accepted status rather than submitting changed input.");
      const current=stored ?? {id:crypto.randomUUID(),actor,dealId:source.id,fields};
      intent.current=current;setCaptured(true);
      const data=await (await apiRequest("POST",`/api/deals/${source.id}/onboarding-preparation`,current.fields,
        {"Idempotency-Key":current.id})).json();
      if(!data.accepted || !data.command || data.command.commandId!==current.id)
        throw new Error("Acceptance response unavailable. Read back the captured intent.");
      return {command:data.command as OnboardingPreparationStatus,actor:current.actor};
    },
    onSuccess: async(data) => {
      if(data.actor!==actorRef.current)return;
      setResult(data.command);
      toast({ title: "Local preparation recorded", description: "Linked deal and accepted local steps only. No sending, enrollment or activation requested." });
      await refresh();
    },
    onError: (err: Error) => {
      toast({ title: "Preparation not confirmed", description: err.message, variant: "destructive" });
    },
  });
  const readbackMutation=useMutation({
    mutationFn:async(resume:boolean)=>{
      const command=intent.current ? {commandId:intent.current.id,selectedDealId:intent.current.dealId} :
        result ?? preparation.data?.latestCommand;
      if(!command || !user)throw new Error("No captured or retained command is available");
      const capturedActor=actor;
      const path=`/api/deals/${command.selectedDealId}/onboarding-preparation`;
      const data=resume ? await (await apiRequest("POST",`${path}/${command.commandId}/resume`,
        {expectedActorId:user.id,expectedAccountVersion:user.accountVersion},{"Idempotency-Key":command.commandId})).json() :
        await (await apiRequest("GET",`${path}?commandId=${command.commandId}`)).json();
      if(!resume && data.accepted===false && data.commandId===command.commandId)
        return {command:null,actor:capturedActor};
      if(!data.command || data.command.commandId!==command.commandId)throw new Error("Retained command unavailable");
      return {command:data.command as OnboardingPreparationStatus,actor:capturedActor};
    },
    onSuccess:async(data)=>{
      if(data.actor!==actorRef.current)return;
      setResult(data.command);
      if(!data.command){intent.current=null;setCaptured(false);toast({title:"No accepted intent",description:"The current authorized source has no accepted command for this key. The unsent form is editable; no rollback or native outcome is implied."});}
      else toast({title:data.command.state==="prepared" ? "Local preparation recorded" : "Accepted intent read back",
        description:"Exact local identities refreshed. No native receipt, sending, enrollment or activation is implied."});
      await refresh();
    },
    onError:(error:Error)=>toast({title:"Preparation read/retry unavailable",description:error.message,variant:"destructive"}),
  });
  const visibleCommand=result ?? preparation.data?.latestCommand;

  const onSubmit = (values: FormValues) => {
    submitMutation.mutate(values);
  };

  const getContactLabel = (c: Contact) =>
    `${c.firstName} ${c.lastName}${c.companyName ? ` - ${c.companyName}` : ""}`;

  if (contactsLoading || (selectedContactId && dealsLoading)) {
    return (
      <div className="crm-page max-w-2xl mx-auto space-y-4" data-testid="onboardingkickoff-loading">
        <header>
          <h1 data-testid="text-onboardingkickoff-title">Onboarding Kickoff</h1>
          <p className="mt-1 text-sm text-muted-foreground">Prepare the selected Closed Won deal for local onboarding.</p>
        </header>
        <div className="flex items-center justify-center h-64">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="crm-page max-w-2xl mx-auto" data-testid="onboardingkickoff-page">
      <header className="mb-4">
        <h1 data-testid="text-onboardingkickoff-title">Onboarding Kickoff</h1>
        <p className="mt-1 text-sm text-muted-foreground">Prepare the selected Closed Won deal for local onboarding.</p>
      </header>
      <p className="text-sm mb-4">Closed Won Sales → linked Onboarding preparation. Sales stays unchanged. Only missing local checklist/task preparation is retried; completed work is never reset. No native, sending, enrollment or activation effects are requested.</p>
      {preparation.isLoading && selectedDealId>0 && <CrmDataState state="loading" message="Reading exact linked preparation authority"/>}
      {preparation.isError && <CrmDataState state="unavailable" message="Selected deal is unavailable or not eligible for linked local preparation" onRetry={()=>void preparation.refetch()}/>}
      {(captured || visibleCommand) && <section aria-label="Retained local preparation" className="border rounded-lg p-4 mb-4 space-y-3">
        <h2 className="font-semibold">{visibleCommand ? `Local preparation: ${visibleCommand.state}` : "Acceptance outcome unknown—read back before retrying"}</h2>
        {visibleCommand && <><p>Sales #{visibleCommand.sourceDealId} → Onboarding #{visibleCommand.onboardingDealId}</p>
          <p>Retained target date: {visibleCommand.targetGoLiveDate} (date-only planning; not a live date)</p>
          <ul>{visibleCommand.steps.map(step=><li key={step.key}>{step.key}: {step.unavailable ? "Recorded identity unavailable—review required":step.accepted ? "Local preparation recorded":"Not yet recorded"}{step.taskId ? ` · Task #${step.taskId}`:""}{step.checklistIds ? ` · Checklist IDs ${step.checklistIds.join(", ")}`:""}</li>)}</ul>
          <a className="underline" href={`/dashboard/onboarding?tab=board&contactId=${visibleCommand.contactId}&dealId=${visibleCommand.onboardingDealId}`}>Open exact linked Onboarding context</a></>}
        <Button type="button" data-testid="button-read-preparation" variant="outline" disabled={readbackMutation.isPending || submitMutation.isPending} onClick={()=>readbackMutation.mutate(false)}>Read accepted intent</Button>
        <Button type="button" data-testid="button-retry-preparation" disabled={!visibleCommand || visibleCommand.state!=="partial" || visibleCommand.steps.some(s=>s.unavailable) || readbackMutation.isPending || submitMutation.isPending}
          onClick={()=>readbackMutation.mutate(true)}>Retry unfinished local preparation</Button>
      </section>}
      {contactsError && <CrmDataState state="unavailable" message="Contact search unavailable" onRetry={()=>void retryContacts()}/>}
      {exactContact.isError && <CrmDataState state="unavailable" message="Exact selected contact unavailable" onRetry={()=>void exactContact.refetch()}/>}
      {dealsError && <CrmDataState state="unavailable" message="Exact selected-contact deals unavailable" onRetry={()=>void retryDeals()}/>}
      <label className="text-sm">Search authorized contacts<Input value={contactSearch}
        onChange={event=>{setContactSearch(event.target.value);setContactOffset(0);}}/></label>
      <nav aria-label="Contact search pages" className="flex gap-3 flex-wrap">
        <Button variant="outline" disabled={contactOffset===0} onClick={()=>setContactOffset(Math.max(0,contactOffset-50))}>Previous contacts</Button>
        <Button variant="outline" disabled={contactsLoading || contactsError || !contactsRes || contactsRes.data.length<50} onClick={()=>setContactOffset(contactOffset+50)}>Check next contacts</Button>
        <p className="text-sm">{contactsRes && !contactsError ? `${contactsRes.data.length} loaded contacts in the authorized page; total unavailable from this row reader` : "Contact page and total unavailable"}</p>
      </nav>
      <Card>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="contactId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Contact</FormLabel>
                    <Select
                      value={field.value}
                      disabled={captured || submitMutation.isPending || readbackMutation.isPending}
                      onValueChange={(v) => {
                        field.onChange(v);
                        setSelectedContactId(v);
                        form.setValue("dealId", "");
                      }}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-contact">
                          <SelectValue placeholder="Select a contact" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {contacts?.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)} data-testid={`select-contact-${c.id}`}>
                            {getContactLabel(c)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="dealId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Deal</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={!selectedContactId || captured || submitMutation.isPending || readbackMutation.isPending}>
                      <FormControl>
                        <SelectTrigger data-testid="select-deal">
                          <SelectValue placeholder={selectedContactId ? "Select a deal" : "Select a contact first"} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {contactDeals.map((d) => (
                          <SelectItem key={d.id} value={String(d.id)} data-testid={`select-deal-${d.id}`}>
                            Deal #{d.id} - {d.stage} ({d.pipeline})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="terminalNeeded"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Terminal needed?</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger data-testid="select-terminal-needed">
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="yes" data-testid="select-terminal-yes">Yes</SelectItem>
                        <SelectItem value="no" data-testid="select-terminal-no">No</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="goLiveDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Go-live target date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} data-testid="input-go-live-date" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="fundingNotes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Funding preference notes</FormLabel>
                    <FormControl>
                      <Textarea {...field} placeholder="Funding preferences..." data-testid="input-funding-notes" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="underwritingDocs"
                render={() => (
                  <FormItem>
                    <FormLabel>Underwriting docs checklist</FormLabel>
                    <div className="space-y-3 pt-1">
                      {UNDERWRITING_DOCS.map((doc) => (
                        <FormField
                          key={doc}
                          control={form.control}
                          name="underwritingDocs"
                          render={({ field }) => (
                            <FormItem className="flex flex-row items-center gap-3 space-y-0">
                              <FormControl>
                                <Checkbox
                                  checked={field.value?.includes(doc)}
                                  onCheckedChange={(checked) => {
                                    const current = field.value || [];
                                    if (checked) {
                                      field.onChange([...current, doc]);
                                    } else {
                                      field.onChange(current.filter((v) => v !== doc));
                                    }
                                  }}
                                  data-testid={`checkbox-doc-${doc.replace(/\s+/g, "-").toLowerCase()}`}
                                />
                              </FormControl>
                              <FormLabel className="font-normal">{doc}</FormLabel>
                            </FormItem>
                          )}
                        />
                      ))}
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <Button
                type="submit"
                disabled={submitMutation.isPending || readbackMutation.isPending || captured || !preparation.data || preparation.isError || !!visibleCommand}
                className="w-full"
                data-testid="button-submit-onboarding"
              >
                {submitMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Prepare linked Onboarding locally
              </Button>
              <p className="text-sm text-muted-foreground">Terminal, target date and document selections remain planning metadata, not hardware recommendations, live dates or verified uploads. Only a new linked deal receives funding notes; existing linked deals are not overwritten.</p>
              <Button type="button" data-testid="button-cancel-preparation" variant="outline" disabled={captured || submitMutation.isPending || readbackMutation.isPending}
                onClick={()=>{form.reset();setSelectedContactId("");setResult(null);}}>Cancel unsent preparation (no write)</Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
