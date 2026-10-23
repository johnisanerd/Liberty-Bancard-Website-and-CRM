import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Loader2, MailCheck } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface AckStatus {
  capability: { enabled: boolean; eligibleFrom: string | null; expiresAt: string | null; sourceClasses: string[]; activatedBy: string | null; activatedAt: string | null };
  counts: Record<string, number>;
  worker?: { state: "reporting" | "stale" | "never_reported"; lastTickAt: string | null; ageSeconds: number | null; lastOutcome: "ok" | "error" | null; lastErrorName: string | null };
  meaning: Record<string, string>;
}

const REQUEST_TYPES: Array<{ value: string; label: string }> = [
  { value: "sales_request", label: "Sales requests (estimate, get started, callback, analysis, statement upload)" },
  { value: "support_request", label: "Support requests" },
  { value: "fulfillment_request", label: "Equipment orders" },
  { value: "partner_application_request", label: "Partner applications" },
  { value: "privacy_request", label: "Privacy requests (receipt goes only to the submitted email)" },
];

const STATE_LABELS: Record<string, string> = {
  prepared: "Prepared",
  blocked: "Waiting (no email attempt authorized)",
  attempting: "Attempt in progress",
  accepted: "Accepted by mail transport (not inbox delivery)",
  uncertain: "Outcome unknown (never resent automatically)",
  failed: "Failed after bounded retries",
  suppressed: "Not sent (contact preference or suppression)",
};

const QUERY_KEY = ["/api/admin/inbound-acknowledgements/status"];

export function InboundAcknowledgementCard({ canControl }: { canControl: boolean }) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<string[]>(["sales_request"]);
  const { data, isLoading, isError } = useQuery<AckStatus>({ queryKey: QUERY_KEY });

  const change = useMutation({
    mutationFn: async (body: { enabled: boolean; sourceClasses?: string[] }) => {
      const res = await apiRequest("POST", "/api/admin/inbound-acknowledgements/capability", body);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: (e: Error) => toast({ title: "Could not change receipt delivery", description: e.message, variant: "destructive" }),
  });

  const open = data?.capability.enabled === true;
  return (
    <Card data-testid="card-inbound-acknowledgements">
      <CardHeader>
        <div className="flex items-center gap-2">
          <MailCheck className="w-4 h-4 text-muted-foreground" />
          <CardTitle className="text-base">Request receipts (transactional email)</CardTitle>
          {data && (
            <Badge variant={open ? "default" : "secondary"} className="text-xs" data-testid="badge-ack-capability">
              {open ? "Delivery enabled" : "Delivery closed"}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Each new request records its local work first. A receipt email is sent only for requests received after delivery is enabled, only to the address submitted on that request, and never replays older requests. Enabling receipts does not unpause outbound email, publish message content or activate any campaign.
        </p>
        {isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        ) : isError || !data ? (
          <p className="text-sm text-destructive" data-testid="text-ack-error">Receipt status could not be loaded.</p>
        ) : (
          <>
            {data.worker && (
              <p className="text-sm" data-testid="text-ack-worker-status">
                <span className="text-muted-foreground">Receipt worker: </span>
                {data.worker.state === "reporting"
                  ? `reporting (last sweep ${data.worker.ageSeconds}s ago${data.worker.lastOutcome === "error" ? `, failed: ${data.worker.lastErrorName ?? "error"}` : ""})`
                  : data.worker.state === "stale"
                    ? `not reporting (last sweep ${data.worker.lastTickAt})`
                    : "has not reported (not running in this environment)"}
              </p>
            )}
            <dl className="grid gap-1 text-sm" data-testid="list-ack-counts">
              {Object.keys(STATE_LABELS).map((k) => (
                <div key={k} className="flex justify-between gap-4 border-b py-1">
                  <dt className="text-muted-foreground">{STATE_LABELS[k]}</dt>
                  <dd className="font-mono tabular-nums" data-testid={`text-ack-count-${k}`}>{data.counts[k] ?? 0}</dd>
                </div>
              ))}
            </dl>
            {open && (
              <p className="text-sm" data-testid="text-ack-window">
                Enabled for {data.capability.sourceClasses.join(", ") || "no request types"} from {data.capability.eligibleFrom ? new Date(data.capability.eligibleFrom).toLocaleString() : "an unknown time"}
                {data.capability.activatedBy ? ` by ${data.capability.activatedBy}` : ""}.
              </p>
            )}
            {canControl ? (
              <div className="space-y-3">
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Request types to enable</legend>
                  {REQUEST_TYPES.map((t) => (
                    <div key={t.value} className="flex items-center gap-2 min-h-11">
                      <Checkbox
                        id={`ack-type-${t.value}`}
                        checked={selected.includes(t.value)}
                        onCheckedChange={(c) => setSelected((s) => (c ? [...new Set([...s, t.value])] : s.filter((x) => x !== t.value)))}
                      />
                      <Label htmlFor={`ack-type-${t.value}`} className="text-sm">{t.label}</Label>
                    </div>
                  ))}
                </fieldset>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="min-h-11"
                    disabled={change.isPending || selected.length === 0}
                    onClick={() => change.mutate({ enabled: true, sourceClasses: selected })}
                    data-testid="button-ack-enable"
                  >
                    {open ? "Update enabled request types" : "Enable transactional purpose"}
                  </Button>
                  {open && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      disabled={change.isPending}
                      onClick={() => change.mutate({ enabled: false })}
                      data-testid="button-ack-close"
                    >
                      Close delivery
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Only an administrator can change receipt delivery.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
