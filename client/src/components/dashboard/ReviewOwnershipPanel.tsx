import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type OwnerState = "ok" | "missing" | "not_reviewer" | "deactivated" | "not_configured";
interface ClassStatus {
  recordedPolicy: { ownerUserId: string; ownerEmail: string | null; dueHours: number } | null;
  ownerState: OwnerState;
  outstanding: number; withoutNotification: number; unassigned: number; ownerNoLongerValid: number; overdue: number;
}
type Classes = Record<"partner_application_request" | "privacy_request", ClassStatus>;
interface AdminUser { id: string; email: string; role: string; accountState?: string }

const CLASS_LABEL = { partner_application_request: "Partner applications", privacy_request: "Privacy requests" } as const;
const OWNER_TEXT: Record<OwnerState, string> = {
  ok: "Active reviewer",
  not_configured: "No owner recorded. Items say they have no owner or due time.",
  missing: "The recorded owner no longer exists.",
  not_reviewer: "The recorded owner is no longer an admin or manager.",
  deactivated: "The recorded owner's account is deactivated.",
};

/** Administrator-recorded owner and due hours for restricted review work. Nothing is assigned until one is saved. */
export function ReviewOwnershipPanel() {
  const { toast } = useToast();
  const { data, isError, refetch } = useQuery<{ classes: Classes }>({ queryKey: ["/api/admin/inbound-review-queue"] });
  const { data: users } = useQuery<AdminUser[]>({ queryKey: ["/api/admin/users"] });
  const [draft, setDraft] = useState<Record<string, { owner: string; hours: string }>>({});
  const reviewers = (users ?? []).filter((u) => ["admin", "manager"].includes(u.role) && (u.accountState ?? "active") === "active");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/admin/inbound-review-queue"] });
  const save = useMutation({
    mutationFn: async () => {
      const policy: Record<string, { ownerUserId: string; dueHours: number }> = {};
      for (const cls of Object.keys(CLASS_LABEL) as Array<keyof typeof CLASS_LABEL>) {
        const current = data?.classes[cls].recordedPolicy;
        const d = draft[cls];
        const owner = d?.owner ?? current?.ownerUserId ?? "";
        const hours = d?.hours ?? (current ? String(current.dueHours) : "");
        if (owner && hours) policy[cls] = { ownerUserId: owner, dueHours: Number(hours) };
      }
      await apiRequest("PUT", "/api/admin/inbound-review-policy", { policy });
    },
    onSuccess: () => { setDraft({}); refresh(); toast({ title: "Review ownership saved", description: "Applies to new items. Use Apply to outstanding items for work already waiting." }); },
    onError: (e: Error) => toast({ title: "Not saved", description: e.message, variant: "destructive" }),
  });
  const reconcile = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/admin/inbound-review-queue/reconcile", {})).json(),
    onSuccess: (r: { created: number; assigned: number; reassigned: number; preserved: number; stillUnassigned: number }) => {
      refresh();
      toast({ title: "Outstanding items updated", description: `${r.created} added, ${r.assigned} assigned, ${r.reassigned} reassigned, ${r.preserved} left as assigned, ${r.stillUnassigned} still without an owner. No request status was changed.` });
    },
    onError: (e: Error) => toast({ title: "Not updated", description: e.message, variant: "destructive" }),
  });

  if (isError) return <div role="alert" className="text-sm">Review ownership unavailable. <Button variant="outline" size="sm" onClick={() => void refetch()}>Retry</Button></div>;
  if (!data) return null;

  return (
    <Card data-testid="card-review-ownership">
      <CardHeader><CardTitle className="text-base">Review owner and due time</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          The owner and due time you record here are the only ones used. Due time is counted from when each request was received.
          No deadline is shown to applicants or requesters.
        </p>
        {(Object.keys(CLASS_LABEL) as Array<keyof typeof CLASS_LABEL>).map((cls) => {
          const s = data.classes[cls];
          const d = draft[cls];
          const owner = d?.owner ?? s.recordedPolicy?.ownerUserId ?? "";
          const hours = d?.hours ?? (s.recordedPolicy ? String(s.recordedPolicy.dueHours) : "");
          const ownerKnown = reviewers.some((r) => r.id === owner);
          return (
            <div key={cls} className="space-y-2 border-t pt-3" data-testid={`review-ownership-${cls}`}>
              <div className="font-medium text-sm">{CLASS_LABEL[cls]}</div>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs space-y-1">
                  <span className="block">Owner</span>
                  <Select value={owner} onValueChange={(v) => setDraft({ ...draft, [cls]: { owner: v, hours } })}>
                    <SelectTrigger className="w-72" aria-label={`${CLASS_LABEL[cls]} owner`}><SelectValue placeholder="Choose an owner" /></SelectTrigger>
                    <SelectContent>
                      {!ownerKnown && owner && <SelectItem value={owner}>{s.recordedPolicy?.ownerEmail ?? "Recorded owner"} (no longer valid)</SelectItem>}
                      {reviewers.map((r) => <SelectItem key={r.id} value={r.id}>{r.email} ({r.role})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <label className="text-xs space-y-1">
                  <span className="block">Due after (hours)</span>
                  <Input className="w-28" type="number" min={1} max={2160} value={hours} aria-label={`${CLASS_LABEL[cls]} due hours`}
                    onChange={(e) => setDraft({ ...draft, [cls]: { owner, hours: e.target.value } })} />
                </label>
              </div>
              <p className={s.ownerState === "ok" ? "text-xs text-muted-foreground" : "text-xs text-destructive"} data-testid={`review-owner-state-${cls}`}>{OWNER_TEXT[s.ownerState]}</p>
              <p className="text-xs text-muted-foreground">
                {s.outstanding} waiting for a decision · {s.withoutNotification} with no review notice · {s.unassigned} without an owner · {s.ownerNoLongerValid} whose owner is no longer valid · {s.overdue} past due
              </p>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending} data-testid="button-save-review-ownership">Save review ownership</Button>
          <Button size="sm" variant="outline" onClick={() => reconcile.mutate()} disabled={reconcile.isPending} data-testid="button-reconcile-review-ownership">
            Apply to outstanding items
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
