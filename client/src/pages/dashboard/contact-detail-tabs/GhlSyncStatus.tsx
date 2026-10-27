import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
import type { Contact } from "@shared/schema";

type ReceiptLevel = "recorded_locally" | "waiting" | "processing" | "provider_accepted" | "provider_accepted_partial" | "held" | "ambiguous" | "failed" | "not_applicable";

export interface ContactProjectionStatus {
  present: boolean;
  receiptLevel: ReceiptLevel;
  state: string | null;
  exportDisposition: string | null;
  exportReason: string | null;
  desiredGeneration: number | null;
  settledGeneration: number | null;
  attemptCount: number | null;
  deferralCount: number | null;
  dispatchState: string | null;
  lastDispatchAt: string | null;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  terminalReason: string | null;
  componentReceipts: Record<string, { attempted?: number; ok?: number; failed?: number; ambiguous?: number; lastHttpStatus?: number | null }>;
}

export const PROJECTION_LEVEL_LABELS: Record<ReceiptLevel, { label: string; detail: string }> = {
  recorded_locally: { label: "Recorded locally", detail: "Saved in Liberty and queued; no GHL request has been made yet." },
  waiting: { label: "Waiting", detail: "Queued for a later attempt (deferred or scheduled retry); nothing has been confirmed by GHL." },
  processing: { label: "Processing", detail: "A worker currently holds this contact." },
  provider_accepted: { label: "Provider accepted", detail: "GHL accepted the request. This is not a read-back verification." },
  provider_accepted_partial: { label: "Provider accepted (partial)", detail: "GHL accepted the contact identity and owned tags. Some permission or profile fields were held and not sent. This is not a read-back verification." },
  held: { label: "Held", detail: "Not exported: outside the current export scope, local-only, or test data." },
  ambiguous: { label: "Needs reconciliation", detail: "A create request may have reached GHL without a recorded response; it will not be repeated blindly." },
  failed: { label: "Failed (terminal)", detail: "Retries are exhausted or the contact cannot be exported." },
  not_applicable: { label: "No projection recorded", detail: "No GHL export is queued for this contact." },
};

interface Props {
  contact: Contact;
  ghlSyncStatus?: {
    isSynced?: boolean; isRecent?: boolean; ghlContactId?: string | null; lastSyncedAt?: string | null;
    projection?: ContactProjectionStatus | null;
  };
  resyncToGhlMutation: { mutate: () => void; isPending: boolean };
}

export function GhlSyncStatus({ contact, ghlSyncStatus, resyncToGhlMutation }: Props) {
  const isSynced = ghlSyncStatus?.isSynced && ghlSyncStatus?.isRecent;
  const ghlId = ghlSyncStatus?.ghlContactId || contact.ghlContactId;
  const lastSyncedAt = ghlSyncStatus?.lastSyncedAt;
  return (
    <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border bg-card" data-testid="section-ghl-sync-status">
      {isSynced ? (
        <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
      ) : (
        <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <Badge
          variant={isSynced ? "default" : "secondary"}
          className={isSynced ? "whitespace-normal bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" : "whitespace-normal bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"}
          data-testid="badge-ghl-sync-status"
        >
          {isSynced ? "Recent GHL sync receipt" : ghlSyncStatus ? "No recent GHL sync receipt" : "GHL sync status unavailable"}
        </Badge>
        {ghlId && (
          <span className="ml-2 text-xs text-muted-foreground font-mono" data-testid="text-ghl-contact-id">
            GHL contact ID (provider identity, not a business assignment): {ghlId}
          </span>
        )}
        {lastSyncedAt && (
          <span className="ml-2 text-xs text-muted-foreground" data-testid="text-ghl-last-synced">
            Last synced: {new Date(lastSyncedAt).toLocaleString()}
          </span>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled
        aria-describedby="ghl-write-hold-reason"
        className="shrink-0"
        data-testid="button-resync-ghl"
      >
        <RefreshCw className={`h-3.5 w-3.5 mr-1 ${resyncToGhlMutation.isPending ? "animate-spin" : ""}`} />
        Re-sync to GHL
      </Button>
      <ProjectionReceipts projection={ghlSyncStatus?.projection} loaded={!!ghlSyncStatus} />
      <p id="ghl-write-hold-reason" className="basis-full text-xs">
        Manual re-sync is unavailable. Outgoing contact projection to GHL runs automatically through the guarded sync worker; it does not send messages or enroll workflows.
      </p>
    </div>
  );
}

function ProjectionReceipts({ projection, loaded }: { projection?: ContactProjectionStatus | null; loaded: boolean }) {
  if (!loaded || projection === undefined || projection === null) {
    return (
      <p className="basis-full text-xs text-muted-foreground" data-testid="text-projection-unavailable">
        Outgoing export state is unavailable (unknown). It is not shown as healthy or empty.
      </p>
    );
  }
  const level = PROJECTION_LEVEL_LABELS[projection.receiptLevel] ?? { label: "Unrecognized state", detail: `Export receipt level "${String(projection.receiptLevel)}" is not recognized by this page; it is not shown as healthy.` };
  const { components: componentOutcomes, ...requestReceipts } = (projection.componentReceipts ?? {}) as Record<string, any>;
  const receipts = Object.entries(requestReceipts) as Array<[string, { ok?: number; failed?: number; ambiguous?: number }]>;
  const outcomes = Object.entries((componentOutcomes ?? {}) as Record<string, { state?: string; heldKeys?: string[]; code?: string }>);
  return (
    <div className="basis-full space-y-1 text-xs" data-testid="section-projection-receipts">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Outgoing export:</span>
        <Badge variant="secondary" className="whitespace-normal" data-testid="badge-projection-level">{level.label}</Badge>
        {projection.exportDisposition && <span className="text-muted-foreground">scope: {projection.exportDisposition.replace(/_/g, " ")}</span>}
      </div>
      <p className="text-muted-foreground">{level.detail}</p>
      {projection.present && (
        <p className="text-muted-foreground" data-testid="text-projection-counters">
          Generation {projection.settledGeneration ?? "?"} of {projection.desiredGeneration ?? "?"} applied; provider attempts {projection.attemptCount ?? "?"};
          local deferrals {projection.deferralCount ?? "?"}
          {projection.nextAttemptAt && ["waiting", "recorded_locally"].includes(projection.receiptLevel) ? `; next attempt ${new Date(projection.nextAttemptAt).toLocaleString()}` : ""}
          {projection.lastErrorCode ? `; last reason ${projection.lastErrorCode}` : ""}
          {projection.terminalReason ? `; terminal reason ${projection.terminalReason}` : ""}.
        </p>
      )}
      {outcomes.length > 0 && (
        <ul className="text-muted-foreground" data-testid="list-projection-component-outcomes">
          {outcomes.map(([name, o]) => (
            <li key={name}>
              {name.replace(/_/g, " ")}: {String(o?.state ?? "unknown").replace(/_/g, " ")}
              {o?.heldKeys && o.heldKeys.length > 0 ? ` (held, not installed in GHL: ${o.heldKeys.join(", ")})` : ""}
              {o?.code ? ` (${o.code})` : ""}
            </li>
          ))}
        </ul>
      )}
      {receipts.length > 0 && (
        <ul className="text-muted-foreground" data-testid="list-projection-component-receipts">
          {receipts.map(([name, r]) => (
            <li key={name}>{name.replace(/_/g, " ")}: {r.ok ?? 0} accepted, {r.failed ?? 0} rejected, {r.ambiguous ?? 0} unconfirmed</li>
          ))}
        </ul>
      )}
    </div>
  );
}
