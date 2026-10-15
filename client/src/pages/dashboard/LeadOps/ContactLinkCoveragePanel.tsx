import React, { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const PATH = "/api/admin/contact-link-coverage";
const CENSUS_CATEGORIES = [
  "STRICT_AUTO_ELIGIBLE",
  "ALREADY_VERIFIED",
  "RECOVERABLE_IDENTITY",
  "NEEDS_BUSINESS_DISCOVERY",
  "REVIEW",
  "OUT_OF_SCOPE",
  "SUPPRESSED",
  "UNUSABLE",
] as const;
type CensusCategory = (typeof CENSUS_CATEGORIES)[number];
type CoverageStatus = {
  runId: string | null;
  status: string;
  watermark: string | number | null;
  cursor: string | number | null;
  total: number;
  processed: number;
  counts: Record<CensusCategory, number>;
  reasonCounts: Record<string, number>;
  complete: boolean;
  serverProcessing: boolean;
};
type AutomaticLinkProgram = {
  enabled: boolean;
  rule: string;
  runId: string | null;
  cursor: string | number | null;
  scanned: number;
  committed: number;
  replayed: number;
  held: number;
  reasons: Record<string, number>;
  complete: boolean;
  updatedAt: string | null;
  lastError: string | null;
};
type AutomaticLinkStatus = { program: AutomaticLinkProgram | null };
type ContactLinkCandidate = {
  candidateId: string;
  contactId: number;
  businessId: number;
  name?: string | null;
  evidenceSourceEventIds: Array<string | number>;
  evidence: unknown;
  conflicts: unknown;
  reasons: string[];
  expectedRevision: number;
  snapshotHash: string;
  category?: string;
  classification?: string;
  isVerified?: boolean;
};
type RawSunbizCandidate = {
  sourceEntityId: number;
  filingNumber: string;
  entityName: string;
  dba?: string | null;
  canonicalSourceLinkMaterialized?: boolean;
};
type SourceRecoveryIdentity = {
  candidateId: string;
  contactId: number;
  businessId: number;
  sourceEntityId: number;
  filingNumber: string;
};
type SourceRecoveryPreview = {
  identity: SourceRecoveryIdentity;
  status: "READY" | "ALREADY_MATERIALIZED" | "HOLD";
  reasonCodes: string[];
  snapshotHash: string | null;
  source: { entityName: string; dba: string | null } | null;
  canonicalBusiness: { businessId: number; canonicalName: string } | null;
};
type SourceRecoveryOutcome = {
  identity: SourceRecoveryIdentity;
  status: string;
  reasonCodes: string[];
  sourceLinkId: string | null;
  snapshotHash: string | null;
};
type CandidateCursor = { createdAt: string; id: string };
type CandidatePage = {
  candidates: ContactLinkCandidate[];
  nextCursor: CandidateCursor | null;
  limit?: number;
};
type ReviewDraft = {
  decision: "" | "verified" | "rejected";
  evidenceEventId: string;
};
type ReviewOutcome = {
  candidateId?: string;
  contactId: number;
  businessId: number | null;
  status: string;
  code?: string;
  decisionId?: string;
  revision?: number;
};
type ReviewBatchResult = {
  outcomes: ReviewOutcome[];
  applied?: number;
  replayed?: number;
  rejected?: number;
};

const REFERENCE_KEYS = new Set([
  "type", "label", "name", "source", "sourcetype", "sourceversion", "sourceeventid",
  "evidencesourceeventid", "eventid", "eventtype", "sourcerecordid", "recordid",
  "sourceeventids", "evidencesourceeventids", "sourceeventname", "entityid", "event",
  "sourceevents", "sourcecategory", "sourcesystem", "sourcelinkid", "sourceentityid",
  "sourcelinks", "stablekey", "filings", "addresses", "phones", "sites", "filing", "filingid",
  "sourcefilingid", "sunbizfilingid", "filingnumber", "filenumber",
  "documentnumber", "documentno", "registrationid", "dba", "dbaname", "dbanames",
  "doingbusinessas", "doingbusinessasname", "aliases", "legalname", "entityname", "county",
  "filingstatus", "filedat", "fileddate", "filingdate", "observedat", "status", "address",
  "registeredaddress", "principaladdress", "businessaddress", "registeredagentaddress",
  "city", "state",
  "street", "street1", "street2", "addressline1", "addressline2", "unit", "suite",
  "zip", "zipcode", "postalcode", "phone", "phonenumber", "telephone", "phonetype",
  "businessphone", "officialphone", "website", "websiteurl", "officialsite",
  "officialwebsite", "officialwebsiteurl", "domain", "domainname", "url",
  "reference", "referenceid", "confidence", "field", "value", "detail", "summary",
  "contactcompanyname", "contactwebsitedomain", "contactphonelast4", "contactaddressmatched",
  "rawsunbizcandidates",
  "business", "canonicalname", "websitedomain", "recordclass", "sunbizname", "sunbizdba",
  "sunbizfilingnumber", "sunbizwebsitedomain", "sunbizaddress", "sunbizcity", "sunbizstate",
  "sunbizentitysource", "sourcecategory", "eventid", "matchedsignals", "kind", "matched",
  "code", "projectedbusinessid", "retainednamecount", "filingnumbers", "retainedaddresscount",
]);

function formatReferenceLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function redactText(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (email) => {
      const [local = "", domain = ""] = email.split("@");
      return `${local.slice(0, 1)}***@${domain}`;
    })
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, (phone) => {
      const digits = phone.replace(/\D/g, "");
      return `•••-•••-${digits.slice(-4)}`;
    });
}

function safeReferenceEntries(value: unknown, parentKey = "", depth = 0): Array<[string, string]> {
  if (depth > 3 || value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => safeReferenceEntries(item, parentKey || `Reference ${index + 1}`, depth + 1));
  }
  if (typeof value !== "object") {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return [];
    const text = redactText(String(value));
    if (!text.trim()) return [];
    if (/phone/i.test(parentKey)) {
      const digits = text.replace(/\D/g, "");
      return [[parentKey || "Phone", digits.length >= 4 ? `•••-•••-${digits.slice(-4)}` : "•••"]];
    }
    return [[parentKey || "Reference", text]];
  }

  const entries: Array<[string, string]> = [];
  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (!REFERENCE_KEYS.has(normalizedKey)) continue;
    if (nestedValue && typeof nestedValue === "object") {
      entries.push(...safeReferenceEntries(nestedValue, key, depth + 1));
    } else {
      entries.push(...safeReferenceEntries(nestedValue, key, depth + 1));
    }
  }
  return entries;
}

function EvidenceReferences({ label, value }: { label: string; value: unknown }) {
  const entries = safeReferenceEntries(value);
  return (
    <div className="rounded-md border bg-background/70 p-2">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      {entries.length ? (
        <dl className="grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-2">
          {entries.map(([key, text], index) => (
            <div key={`${key}-${index}`} className="min-w-0">
              <dt className="inline text-muted-foreground">{formatReferenceLabel(key)}: </dt>
              <dd className="inline break-words">{text}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">No privacy-safe reference fields returned.</p>
      )}
    </div>
  );
}

function getReviewBlockReason(candidate: ContactLinkCandidate): string | null {
  const category = candidate.category ?? candidate.classification;
  if (candidate.isVerified || category === "ALREADY_VERIFIED") return "This contact is already verified.";
  if (category === "STRICT_AUTO_ELIGIBLE") {
    return `This record is classified as ${category.replace(/_/g, " ").toLowerCase()} and is not in the human-review queue.`;
  }
  if (["OUT_OF_SCOPE", "SUPPRESSED", "UNUSABLE"].includes(String(category))) {
    return `This record is classified as ${String(category).replace(/_/g, " ").toLowerCase()} and cannot be reviewed through this queue.`;
  }
  return null;
}

function getEligibleEvidenceId(candidate: ContactLinkCandidate): string {
  return candidate.evidenceSourceEventIds?.map(String)
    .find((value) => /^\d+$/.test(value) && Number(value) > 0) ?? "";
}

function getRawSunbizCandidates(candidate: ContactLinkCandidate): RawSunbizCandidate[] {
  const evidence = candidate.evidence as { rawSunbizCandidates?: unknown } | null;
  if (!Array.isArray(evidence?.rawSunbizCandidates)) return [];
  return evidence.rawSunbizCandidates.filter((source): source is RawSunbizCandidate =>
    Boolean(source)
      && Number.isInteger((source as RawSunbizCandidate).sourceEntityId)
      && (source as RawSunbizCandidate).sourceEntityId > 0
      && typeof (source as RawSunbizCandidate).filingNumber === "string"
      && (source as RawSunbizCandidate).filingNumber.trim().length > 0,
  );
}

function sourceRecoveryKey(identity: SourceRecoveryIdentity): string {
  return `${identity.candidateId}:${identity.sourceEntityId}:${identity.filingNumber}`;
}

/** One card per recovery identity. Repeated raw candidates must not render
 * twice or share a React key. */
export function dedupeSourceRecoveryOptions<T extends { key: string }>(options: T[]): T[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.key)) return false;
    seen.add(option.key);
    return true;
  });
}

export function ContactLinkCoveragePanel() {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return <Card><CardContent className="p-4 text-sm text-muted-foreground">Checking contact-link coverage access…</CardContent></Card>;
  }
  if (user?.role !== "admin") {
    return <Card><CardContent className="p-4 text-sm text-muted-foreground" role="note">Contact-link coverage census and review are available to admins only.</CardContent></Card>;
  }
  return <ContactLinkCoveragePanelAdmin />;
}

function ContactLinkCoveragePanelAdmin() {
  const { toast } = useToast();
  const [cursor, setCursor] = useState<CandidateCursor | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<CandidateCursor | null>>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>({});
  const [reviewOutcomes, setReviewOutcomes] = useState<Record<string, ReviewOutcome>>({});
  const [sourceRecoverySelectedKeys, setSourceRecoverySelectedKeys] = useState<string[]>([]);
  const [sourceRecoveryPreviews, setSourceRecoveryPreviews] = useState<Record<string, SourceRecoveryPreview>>({});
  const [sourceRecoveryOutcomes, setSourceRecoveryOutcomes] = useState<Record<string, SourceRecoveryOutcome>>({});
  const [operatorMessage, setOperatorMessage] = useState<string | null>(null);

  const statusQueryKey = [PATH, "status"] as const;
  const statusQuery = useQuery<CoverageStatus>({
    queryKey: statusQueryKey,
    queryFn: async () => (await apiRequest("GET", `${PATH}/status`)).json(),
    refetchInterval: 10_000,
    retry: false,
  });
  const automationQueryKey = [PATH, "automation"] as const;
  const automationQuery = useQuery<AutomaticLinkStatus>({
    queryKey: automationQueryKey,
    queryFn: async () => (await apiRequest("GET", `${PATH}/automation`)).json(),
    refetchInterval: 10_000,
    retry: false,
  });
  const automationMutation = useMutation({
    mutationFn: async (enabled: boolean) => (await apiRequest("POST", `${PATH}/automation`, enabled
      ? { enabled: true, automaticCommitsAuthorized: true }
      : { enabled: false })).json(),
    onSuccess: async (_result, enabled) => {
      await queryClient.invalidateQueries({ queryKey: automationQueryKey });
      toast({ title: enabled ? "Automatic link commits authorized" : "Automatic link commits paused" });
    },
    onError: (error: Error) => toast({
      title: "Automatic-link program control failed",
      description: error.message,
      variant: "destructive",
    }),
  });
  const runId = statusQuery.data?.runId ?? null;
  useEffect(() => {
    setCursor(null);
    setCursorHistory([]);
    setSelectedCandidateIds([]);
    setSourceRecoverySelectedKeys([]);
  }, [runId]);
  const candidatesQueryKey = [PATH, "candidates", runId, cursor] as const;
  const candidatesQuery = useQuery<CandidatePage>({
    queryKey: candidatesQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "25" });
      if (cursor) {
        params.set("afterCreatedAt", cursor.createdAt);
        params.set("afterId", cursor.id);
      }
      return (await apiRequest("GET", `${PATH}/candidates?${params.toString()}`)).json();
    },
    enabled: Boolean(runId),
    retry: false,
  });

  const refreshStatus = async () => {
    const fresh = await (await apiRequest("GET", `${PATH}/status`)).json() as CoverageStatus;
    queryClient.setQueryData(statusQueryKey, fresh);
    return fresh;
  };
  const invalidateCoverage = () => {
    queryClient.invalidateQueries({ queryKey: [PATH] });
  };

  const controlMutation = useMutation({
    mutationFn: async (action: "start" | "pause" | "resume") => {
      const result = await (await apiRequest("POST", `${PATH}/${action}`, {})).json();
      await refreshStatus();
      return result;
    },
    onSuccess: (_result, action) => {
      setOperatorMessage(null);
      toast({ title: action === "start" ? "Full-pool census started" : `Census ${action} requested` });
      invalidateCoverage();
    },
    onError: (error: Error) => {
      setOperatorMessage(`Census control failed: ${error.message}`);
      toast({ title: "Census control failed", description: error.message, variant: "destructive" });
    },
  });

  const setDraft = (candidateId: string, patch: Partial<ReviewDraft>) => {
    setReviewDrafts((current) => {
      const previous = current[candidateId] ?? {
        decision: "",
        evidenceEventId: "",
      };
      return {
        ...current,
        [candidateId]: {
          ...previous,
          ...patch,
        },
      };
    });
    setReviewOutcomes((current) => {
      if (!current[candidateId]) return current;
      const next = { ...current };
      delete next[candidateId];
      return next;
    });
  };

  const visibleCandidates = candidatesQuery.data?.candidates ?? [];
  const nextCandidatesCursor = candidatesQuery.data?.nextCursor ?? null;
  const selectedRows = visibleCandidates.filter((candidate) =>
    selectedCandidateIds.includes(candidate.candidateId) && !getReviewBlockReason(candidate));
  const sourceRecoveryOptions = dedupeSourceRecoveryOptions(visibleCandidates.flatMap((candidate) =>
    getRawSunbizCandidates(candidate).map((source) => {
      const identity: SourceRecoveryIdentity = {
        candidateId: candidate.candidateId,
        contactId: candidate.contactId,
        businessId: candidate.businessId,
        sourceEntityId: source.sourceEntityId,
        filingNumber: source.filingNumber,
      };
      return { key: sourceRecoveryKey(identity), identity, source };
    })));
  const selectedSourceRecoveryOptions = sourceRecoveryOptions.filter((option) =>
    sourceRecoverySelectedKeys.includes(option.key));
  const readySourceRecoveryOptions = selectedSourceRecoveryOptions.filter((option) =>
    sourceRecoveryPreviews[option.key]?.status === "READY"
      && Boolean(sourceRecoveryPreviews[option.key]?.snapshotHash));
  const sourceRecoveryPreviewMutation = useMutation({
    mutationFn: async () => {
      if (selectedSourceRecoveryOptions.length < 1 || selectedSourceRecoveryOptions.length > 25) {
        throw new Error("Select between 1 and 25 raw Sunbiz identities from this page.");
      }
      return await (await apiRequest("POST", `${PATH}/source-recovery/preview`, {
        items: selectedSourceRecoveryOptions.map((option) => option.identity),
      })).json() as { denominator: number; results: SourceRecoveryPreview[] };
    },
    onSuccess: (result) => {
      setSourceRecoveryPreviews((current) => ({
        ...current,
        ...Object.fromEntries(result.results.map((preview) => [sourceRecoveryKey(preview.identity), preview])),
      }));
      setSourceRecoveryOutcomes((current) => {
        const next = { ...current };
        for (const option of selectedSourceRecoveryOptions) delete next[option.key];
        return next;
      });
      toast({
        title: "Source-recovery preview received",
        description: `${result.results.filter((item) => item.status === "READY").length} of ${result.denominator} selected identities are ready for exact-snapshot apply.`,
      });
    },
    onError: (error: Error) => toast({ title: "Source-recovery preview failed", description: error.message, variant: "destructive" }),
  });
  const sourceRecoveryApplyMutation = useMutation({
    mutationFn: async () => {
      if (readySourceRecoveryOptions.length < 1 || readySourceRecoveryOptions.length > 25) {
        throw new Error("Apply only ready source-recovery previews from this page (maximum 25).");
      }
      return await (await apiRequest("POST", `${PATH}/source-recovery/apply`, {
        items: readySourceRecoveryOptions.map((option) => ({
          ...option.identity,
          expectedSnapshotHash: sourceRecoveryPreviews[option.key]!.snapshotHash!,
        })),
      })).json() as { denominator: number; results: SourceRecoveryOutcome[] };
    },
    onSuccess: (result) => {
      const materialized = result.results.filter((item) => item.status === "MATERIALIZED").length;
      setSourceRecoveryOutcomes((current) => ({
        ...current,
        ...Object.fromEntries(result.results.map((outcome) => [sourceRecoveryKey(outcome.identity), outcome])),
      }));
      toast({
        title: "Source-recovery results received",
        description: `${result.results.filter((item) => item.status === "MATERIALIZED" || item.status === "ALREADY_MATERIALIZED").length} materialized/already present · ${result.results.filter((item) => item.status === "HOLD" || item.status === "STALE_PREVIEW").length} held or stale.${materialized ? " The ordinary contact-link worker evaluates the new source link automatically; this did not approve the contact relationship." : ""}`,
      });
      invalidateCoverage();
      queryClient.invalidateQueries({ queryKey: candidatesQueryKey });
    },
    onError: (error: Error) => toast({ title: "Source-recovery apply failed", description: error.message, variant: "destructive" }),
  });
  const reviewBatchMutation = useMutation({
    mutationFn: async () => {
      if (selectedRows.length === 0) throw new Error("Select at least one reviewable record on this page.");
      if (selectedRows.length > 25) throw new Error("Review at most 25 records from the current candidate page.");
      const decisions = selectedRows.map((candidate) => {
        const draft = reviewDrafts[candidate.candidateId];
        if (!draft?.decision) throw new Error(`Choose verify or reject for contact #${candidate.contactId}.`);
        if (draft.decision === "verified") {
          const permittedEvidenceIds = candidate.evidenceSourceEventIds.map(String);
          const parsedEvidenceId = Number(draft.evidenceEventId);
          if (!draft.evidenceEventId || !permittedEvidenceIds.includes(draft.evidenceEventId)
            || !Number.isInteger(parsedEvidenceId) || parsedEvidenceId < 1) {
            throw new Error(`Eligible retained source evidence is unavailable for contact #${candidate.contactId}. Recover source evidence before verification.`);
          }
        }
        return {
          candidateId: candidate.candidateId,
          contactId: candidate.contactId,
          businessId: candidate.businessId,
          decision: draft.decision,
          ...(draft.decision === "verified" && draft.evidenceEventId
            ? { evidenceSourceEventId: Number(draft.evidenceEventId) }
            : {}),
          expectedRevision: candidate.expectedRevision,
          snapshotHash: candidate.snapshotHash,
        };
      });
      return await (await apiRequest("POST", `${PATH}/review-batch`, { items: decisions })).json() as ReviewBatchResult;
    },
    onSuccess: (result) => {
      const outcomes = (result.outcomes ?? []).map((outcome, index) => ({
        ...outcome,
        candidateId: outcome.candidateId ?? selectedRows[index]?.candidateId,
      })).filter((outcome): outcome is ReviewOutcome & { candidateId: string } => Boolean(outcome.candidateId));
      setReviewOutcomes((current) => ({
        ...current,
        ...Object.fromEntries(outcomes.map((outcome) => [outcome.candidateId, outcome])),
      }));
      const applied = outcomes.filter((outcome) => outcome.status === "applied" || outcome.status === "replayed").length;
      toast({
        title: "Review results received",
        description: `${applied} applied/replayed · ${outcomes.filter((outcome) => outcome.status === "rejected").length} rejected. Each record's server result is shown below.`,
      });
      invalidateCoverage();
      queryClient.invalidateQueries({ queryKey: candidatesQueryKey });
    },
    onError: (error: Error) => toast({ title: "Batch review failed", description: error.message, variant: "destructive" }),
  });

  const canStart = !statusQuery.data?.runId || statusQuery.data.complete;
  const canPause = Boolean(statusQuery.data?.runId && !statusQuery.data.complete && statusQuery.data.serverProcessing);
  const canResume = Boolean(statusQuery.data?.runId && !statusQuery.data.complete
    && !statusQuery.data.serverProcessing
    && (statusQuery.data.status === "paused" || statusQuery.data.status === "ready" || statusQuery.data.status === "running"));
  const status = statusQuery.data;
  const exclusiveTotal = status
    ? CENSUS_CATEGORIES.reduce((sum, category) => sum + (Number(status.counts?.[category]) || 0), 0)
    : null;
  const progressPercent = status && status.total > 0
    ? Math.min(100, Math.round((status.processed / status.total) * 100))
    : status?.complete ? 100 : 0;
  const anyDraftMissing = selectedRows.some((candidate) => !reviewDrafts[candidate.candidateId]?.decision);
  const selectedNeedsEvidence = selectedRows.some((candidate) => {
    const draft = reviewDrafts[candidate.candidateId];
    const evidenceId = Number(draft?.evidenceEventId);
    return draft?.decision === "verified" && (!draft.evidenceEventId
      || !candidate.evidenceSourceEventIds.map(String).includes(draft.evidenceEventId)
        || !Number.isInteger(evidenceId) || evidenceId < 1);
  });

  return (
    <Card data-testid="contact-link-coverage">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          Contact link coverage census &amp; review
          <Badge variant="outline" className="text-[10px]">Full-pool · admin</Badge>
        </CardTitle>
        <CardDescription>
          A resumable census of every contact-link classification, plus explicit operator review through the existing reviewed writer.
          Census classification is read-only: starting a census does not authorize automatic link verification or outreach.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pt-0">
        {statusQuery.isLoading ? (
          <p className="text-sm text-muted-foreground" role="status">Loading census status…</p>
        ) : statusQuery.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Census status unavailable — counts are not zero: {(statusQuery.error as Error).message}
          </p>
        ) : status ? (
          <section aria-label="Full-pool census progress" className="space-y-3 rounded-lg border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={status.status === "error" ? "destructive" : status.complete ? "default" : "secondary"}>
                {status.status}
              </Badge>
              <Badge variant={status.serverProcessing ? "default" : "outline"}>
                {status.serverProcessing ? "Server processing enabled" : "Server processing paused"}
              </Badge>
              <span className="break-all text-xs text-muted-foreground">
                {status.runId ? `Run ${status.runId}` : "No census run recorded"}
                {status.watermark != null ? ` · watermark ${status.watermark}` : ""}
                {status.cursor != null ? ` · cursor ${status.cursor}` : ""}
              </span>
            </div>
            <p className="text-xs text-muted-foreground" data-testid="census-frozen-history-note">
              <strong>Frozen history:</strong> this census classified the contacts that existed at its watermark
              {status.watermark != null ? ` (${status.watermark.toLocaleString()})` : ""} and does not change as contacts are
              imported or linked afterwards. Current linked and unresolved counts are reported separately by the automatic
              contact-link worker on the Canonical Enrichment page.
            </p>
            <div className="space-y-1" aria-label={`${progressPercent}% census progress`}>
              <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar"
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent}
                aria-label="Full-pool census progress">
                <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progressPercent}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">
                {status.processed.toLocaleString()} of {status.total.toLocaleString()} records processed · {progressPercent}%
                {status.complete ? " · server marked the full pool complete" : status.serverProcessing
                  ? " · durable server work continues independently of this page"
                  : " · paused; resume to continue server-side processing"}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {CENSUS_CATEGORIES.map((category) => (
                <div key={category} className="min-w-0 rounded-md border bg-background px-2.5 py-2" data-testid={`coverage-bucket-${category}`}>
                  <div className="text-lg font-semibold tabular-nums">{Number(status.counts?.[category] ?? 0).toLocaleString()}</div>
                  <div className="text-[11px] leading-tight text-muted-foreground">{category.replace(/_/g, " ")}</div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Bucket denominator: {status.processed.toLocaleString()} processed contacts of {status.total.toLocaleString()} contacts in the census pool.
              {" "}Exclusive bucket sum: {exclusiveTotal?.toLocaleString() ?? "unavailable"}
              {exclusiveTotal !== status.processed ? ` · bucket sum differs from processed count ${status.processed.toLocaleString()}` : ""}
            </p>
            <div className="rounded-md border border-amber-300/70 bg-amber-50/70 p-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              The eight categories above are exclusive per processed contact; the total pool is a separate denominator.
              A contact with no canonical business candidate is classified as needing business discovery or unusable based on identity evidence,
              never as invalid solely for lacking a candidate. Reason counts are separate and may overlap. A Gmail address
              is not an identity rejection; identity matching, email syntax/deliverability validation, and outbound authorization
              are independent decisions.
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {Object.entries(status.reasonCounts ?? {}).map(([reason, count]) => (
                <div key={reason} className="rounded border bg-background px-2 py-1.5 text-xs">
                  <span className="font-semibold tabular-nums">{Number(count).toLocaleString()}</span>
                  <span className="ml-1.5 text-muted-foreground">{reason.replace(/_/g, " ")}</span>
                </div>
              ))}
              {Object.keys(status.reasonCounts ?? {}).length === 0 && (
                <p className="col-span-full text-xs text-muted-foreground">No reason counts returned.</p>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">Reason totals can exceed the processed count because one contact can have multiple reasons.</p>
            {operatorMessage && <p className="text-xs" role="status">{operatorMessage}</p>}
            {controlMutation.isError && (
              <p className="text-xs text-destructive" role="alert">Control request failed: {(controlMutation.error as Error).message}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {canStart && (
                <Button size="sm" onClick={() => controlMutation.mutate("start")}
                  disabled={controlMutation.isPending || statusQuery.isError}>
                  Start full-pool census
                </Button>
              )}
              {canResume && (
                <Button size="sm" variant="outline" onClick={() => controlMutation.mutate("resume")}
                  disabled={controlMutation.isPending}>
                  Resume server processing
                </Button>
              )}
              {canPause && (
                <Button size="sm" variant="destructive" onClick={() => controlMutation.mutate("pause")}
                  disabled={controlMutation.isPending}>
                  Pause server processing
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => statusQuery.refetch()} disabled={statusQuery.isFetching}>
                Refresh status
              </Button>
            </div>
            {status.status === "error" && (
              <p className="text-xs text-destructive" role="alert">
                The census stopped in an error state. This run cannot be resumed through the current server contract; inspect the server state before starting a new census.
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              Starting or resuming authorizes durable server-side processing; the run continues if this page closes. Pause disables
              server processing. Census classification does not approve contact relationships.
            </p>
          </section>
        ) : null}

        <section aria-label="Automatic contact link program" className="space-y-3 rounded-lg border border-amber-300/70 bg-amber-50/40 p-3 dark:border-amber-900 dark:bg-amber-950/15">
          <div>
            <h3 className="text-sm font-semibold">Automatic-link program · separate authorization</h3>
            <p className="text-xs text-muted-foreground">
              This control is independent from the read-only census. When enabled, only independently corroborated matches are
              sent through the canonical link writer with exact database guards. Name-only and ambiguous matches remain held.
              After the initial pass, new and changed records remain watched while enabled. No paid calls or outbound changes are made.
              Scanned records are not links; review committed and held counts separately.
            </p>
          </div>
          {automationQuery.isLoading ? (
            <p className="text-xs text-muted-foreground" role="status">Loading automatic-link program status…</p>
          ) : automationQuery.isError ? (
            <p className="text-xs text-destructive" role="alert">
              Automatic-link status unavailable — no counts are assumed: {(automationQuery.error as Error).message}
            </p>
          ) : automationQuery.data?.program ? (
            <div className="space-y-3 rounded-md border bg-background/80 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={automationQuery.data.program.lastError ? "destructive" : automationQuery.data.program.enabled ? "default" : "secondary"}>
                  {automationQuery.data.program.lastError ? "error" : automationQuery.data.program.enabled ? "server processing enabled" : "paused"}
                </Badge>
                <Badge variant={automationQuery.data.program.complete ? "outline" : "secondary"} className="whitespace-normal">
                  {automationQuery.data.program.complete
                    ? automationQuery.data.program.enabled
                      ? "Pass complete; new/changed records remain watched while enabled"
                      : "Pass complete; monitoring paused"
                    : "Pass in progress"}
                </Badge>
                <span className="break-all text-xs text-muted-foreground">
                  {automationQuery.data.program.runId ? `Run ${automationQuery.data.program.runId}` : "No run ID returned"}
                  {automationQuery.data.program.cursor != null ? ` · cursor ${automationQuery.data.program.cursor}` : ""}
                  {automationQuery.data.program.updatedAt
                    ? ` · updated ${new Date(automationQuery.data.program.updatedAt).toLocaleString()}`
                    : ""}
                </span>
              </div>
            <p className="break-words text-xs text-muted-foreground">
              Rule: <span className="font-medium text-foreground">{automationQuery.data.program.rule}</span>
            </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Scanned", automationQuery.data.program.scanned],
                  ["Links committed", automationQuery.data.program.committed],
                  ["Replayed", automationQuery.data.program.replayed],
                  ["Held", automationQuery.data.program.held],
                ].map(([label, count]) => (
                  <div key={String(label)} className="min-w-0 rounded border bg-background px-2.5 py-2">
                    <div className="text-lg font-semibold tabular-nums">{Number(count ?? 0).toLocaleString()}</div>
                    <div className="text-[11px] text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Scanned is server progress, not link volume. Committed is the actual count of links written; replayed and held outcomes are reported separately.
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(automationQuery.data.program.reasons ?? {}).map(([reason, count]) => (
                  <div key={reason} className="rounded border bg-background px-2 py-1.5 text-xs">
                    <span className="font-semibold tabular-nums">{Number(count).toLocaleString()}</span>
                    <span className="ml-1.5 text-muted-foreground">{reason.replace(/_/g, " ")}</span>
                  </div>
                ))}
                {Object.keys(automationQuery.data.program.reasons ?? {}).length === 0 && (
                  <p className="col-span-full text-xs text-muted-foreground">No hold reasons returned.</p>
                )}
              </div>
              {automationQuery.data.program.lastError && (
                <p className="text-xs text-destructive" role="alert">Last error: {automationQuery.data.program.lastError}</p>
              )}
              {automationMutation.isError && (
                <p className="text-xs text-destructive" role="alert">Program control failed: {(automationMutation.error as Error).message}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {automationQuery.data.program.enabled ? (
                  <Button size="sm" variant="destructive" onClick={() => automationMutation.mutate(false)} disabled={automationMutation.isPending}>
                    Pause automatic link commits
                  </Button>
                ) : (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" disabled={automationMutation.isPending || automationQuery.isError}>
                        Authorize automatic link commits
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Enable the automatic-link program?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This is a separate authorization from the contact census. The server will commit only independently corroborated,
                          unambiguous links through the canonical writer and exact database guards. Name-only and ambiguous matches stay held.
                          Scanned contacts are not counted as links. No paid calls or outbound actions occur.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => automationMutation.mutate(true)}>
                          Authorize automatic links
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
                <Button size="sm" variant="ghost" onClick={() => automationQuery.refetch()} disabled={automationQuery.isFetching}>
                  Refresh program
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed bg-background/70 p-3">
              <p className="text-xs text-muted-foreground" role="status">No automatic-link program has been authorized. Census activity does not create verified links.</p>
              {automationMutation.isError && (
                <p className="mt-2 text-xs text-destructive" role="alert">Program control failed: {(automationMutation.error as Error).message}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" disabled={automationMutation.isPending || automationQuery.isError}>
                      Authorize automatic link commits
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Enable the automatic-link program?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This authorization is separate from the read-only census. Only independently corroborated, unambiguous matches
                        are committed through the canonical writer and exact database guards. Name-only and ambiguous matches stay held.
                        No paid calls or outbound actions occur.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => automationMutation.mutate(true)}>
                        Authorize automatic links
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Button size="sm" variant="ghost" onClick={() => automationQuery.refetch()} disabled={automationQuery.isFetching}>
                  Refresh program
                </Button>
              </div>
            </div>
          )}
        </section>

        <section aria-label="Bounded Sunbiz source recovery" className="space-y-3 rounded-lg border p-3">
          <div>
            <h3 className="text-sm font-semibold">Bounded raw-to-canonical source recovery</h3>
            <p className="text-xs text-muted-foreground">
              Preview and, only for exact unique source-to-canonical identity matches, materialize a Sunbiz source link from retained raw evidence.
              This does not create or reassign a business, change a contact link, record a verified decision, validate email, or authorize outreach.
              The server rechecks the full snapshot before each apply; every result is independently audited to the authenticated admin.
            </p>
            <p className="mt-1 text-xs font-medium text-amber-900 dark:text-amber-100">
              After a materialization, the ordinary contact-link worker evaluates the new source link and applies the system link policy automatically; no manual preview/apply loop is needed. Census counts refresh the next time a census runs.
              Only the normal independent Human Review queue can approve or reject the contact↔business relationship.
            </p>
          </div>
          {sourceRecoveryOptions.length ? (
            <>
              <div className="space-y-2">
                {sourceRecoveryOptions.map(({ key, identity, source }) => {
                  const preview = sourceRecoveryPreviews[key];
                  const outcome = sourceRecoveryOutcomes[key];
                  const selected = sourceRecoverySelectedKeys.includes(key);
                  return (
                    <article key={key} className="space-y-1 rounded border bg-background p-2 text-xs">
                      <div className="flex flex-wrap items-start gap-2">
                        <Checkbox
                          checked={selected}
                          disabled={sourceRecoveryPreviewMutation.isPending || sourceRecoveryApplyMutation.isPending}
                          aria-label={`Select raw Sunbiz filing ${source.filingNumber} for source recovery`}
                          onCheckedChange={(checked) => {
                            setSourceRecoverySelectedKeys((current) => checked === true
                              ? current.includes(key) ? current : [...current, key]
                              : current.filter((entry) => entry !== key));
                            setSourceRecoveryPreviews((current) => {
                              if (!current[key]) return current;
                              const next = { ...current };
                              delete next[key];
                              return next;
                            });
                            setSourceRecoveryOutcomes((current) => {
                              if (!current[key]) return current;
                              const next = { ...current };
                              delete next[key];
                              return next;
                            });
                          }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium">{source.entityName || "Unnamed raw Sunbiz entity"}</div>
                          <div className="break-all font-mono text-[10px] text-muted-foreground">
                            Filing {source.filingNumber} · source entity #{source.sourceEntityId} · contact #{identity.contactId} · candidate {identity.candidateId}
                          </div>
                          {source.dba && <div>DBA: {source.dba}</div>}
                        </div>
                        {preview && (
                          <Badge variant={preview.status === "READY" ? "outline" : "secondary"}>{preview.status.replace(/_/g, " ")}</Badge>
                        )}
                      </div>
                      {preview && (
                        <div className="ml-8 space-y-1 rounded bg-muted/40 p-2 text-[11px]" data-testid={`source-recovery-preview-${key}`}>
                          <p>
                            Target: {preview.canonicalBusiness
                              ? `${preview.canonicalBusiness.canonicalName} · business #${preview.canonicalBusiness.businessId}`
                              : "no uniquely bound canonical business"}
                          </p>
                          <p>Reasons: {preview.reasonCodes.join(", ") || "none returned"}</p>
                          {preview.snapshotHash && <p className="break-all font-mono">Snapshot {preview.snapshotHash}</p>}
                        </div>
                      )}
                      {outcome && (
                        <p className="ml-8 text-[11px]" role="status">
                          Apply result: <strong>{outcome.status}</strong>
                          {outcome.reasonCodes.length ? ` · ${outcome.reasonCodes.join(", ")}` : ""}
                          {outcome.sourceLinkId ? ` · source link ${outcome.sourceLinkId}` : ""}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline"
                  onClick={() => sourceRecoveryPreviewMutation.mutate()}
                  disabled={selectedSourceRecoveryOptions.length === 0 || selectedSourceRecoveryOptions.length > 25
                    || sourceRecoveryPreviewMutation.isPending || sourceRecoveryApplyMutation.isPending}>
                  {sourceRecoveryPreviewMutation.isPending ? "Previewing…" : `Preview ${selectedSourceRecoveryOptions.length} selected raw identities`}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button size="sm" variant="secondary"
                      disabled={readySourceRecoveryOptions.length === 0 || sourceRecoveryApplyMutation.isPending}>
                      Apply {readySourceRecoveryOptions.length} exact-snapshot preview{readySourceRecoveryOptions.length === 1 ? "" : "s"}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Apply exact Sunbiz source recovery?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The server will re-read each selected source and canonical identity inside a serializable transaction.
                        Only a unique exact-name binding can add the canonical Sunbiz source tuple; stale, ambiguous, or changed records are held.
                        No business/contact identity assignment, verification decision, email validation, enrollment, or outreach is performed.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => sourceRecoveryApplyMutation.mutate()}>
                        Apply {readySourceRecoveryOptions.length} audited source link{readySourceRecoveryOptions.length === 1 ? "" : "s"}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </>
          ) : (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              No retained raw Sunbiz candidates are present on this candidate page. Missing raw candidates are not an invalid identity conclusion.
            </p>
          )}
        </section>

        <section aria-label="Contact link candidate review" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Human review queue</h3>
              <p className="text-xs text-muted-foreground">
                Select records and submit explicit decisions through the reviewed writer. Verification requires independently attributable,
                business-bound retained evidence. No automatic approval, email validation, or message sending occurs here.
              </p>
            </div>
            {runId && (
              <Button size="sm" variant="outline" onClick={() => candidatesQuery.refetch()} disabled={candidatesQuery.isFetching}>
                Refresh candidates
              </Button>
            )}
          </div>
          {!runId ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              Start a census to load the associated review queue. No candidate count is inferred from the absence of a run.
            </p>
          ) : candidatesQuery.isLoading ? (
            <p role="status" className="text-xs text-muted-foreground">Loading bounded candidate page…</p>
          ) : candidatesQuery.isError ? (
            <p role="alert" className="text-xs text-destructive">
              Candidate page unavailable — no empty-queue conclusion can be made: {(candidatesQuery.error as Error).message}
            </p>
          ) : candidatesQuery.data ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {visibleCandidates.length} record(s) on this page · {selectedRows.length} selected for review
                  {candidatesQuery.data.limit ? ` · server page size ${candidatesQuery.data.limit}` : ""}
                </span>
                <Button size="sm" variant="ghost" onClick={() => setSelectedCandidateIds(
                  visibleCandidates.filter((candidate) => !getReviewBlockReason(candidate)).map((candidate) => candidate.candidateId),
                )} disabled={visibleCandidates.length === 0 || reviewBatchMutation.isPending}>
                  Select reviewable page
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedCandidateIds([])}
                  disabled={selectedCandidateIds.length === 0 || reviewBatchMutation.isPending}>
                  Clear selection
                </Button>
              </div>
              <div className="space-y-3">
                {visibleCandidates.map((candidate) => {
                  const blocked = getReviewBlockReason(candidate);
                  const selected = selectedCandidateIds.includes(candidate.candidateId);
                  const draft = reviewDrafts[candidate.candidateId];
                  const outcome = reviewOutcomes[candidate.candidateId];
                  const reasonText = (candidate.reasons ?? []).map((reason) => redactText(reason.replace(/_/g, " ")));
                  return (
                    <article key={candidate.candidateId} className="space-y-3 rounded-lg border p-3">
                      <div className="flex flex-wrap items-start gap-3">
                        <Checkbox
                          checked={selected}
                          disabled={Boolean(blocked) || reviewBatchMutation.isPending}
                          aria-label={`Select contact ${candidate.contactId} for review`}
                          onCheckedChange={(checked) => setSelectedCandidateIds((current) =>
                            checked === true
                              ? current.includes(candidate.candidateId) ? current : [...current, candidate.candidateId]
                              : current.filter((id) => id !== candidate.candidateId))}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              {candidate.name
                                || safeReferenceEntries(candidate.evidence).find(([key]) => key === "contactCompanyName")?.[1]
                                || `Contact #${candidate.contactId}`}
                            </span>
                            <Badge variant="outline">Contact #{candidate.contactId}</Badge>
                            <Badge variant="outline">Business #{candidate.businessId}</Badge>
                            {(candidate.category || candidate.classification) && (
                              <Badge variant={blocked ? "secondary" : "outline"}>
                                {(candidate.category ?? candidate.classification)!.replace(/_/g, " ")}
                              </Badge>
                            )}
                          </div>
                          <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                            Candidate {candidate.candidateId} · revision {candidate.expectedRevision} · snapshot {candidate.snapshotHash}
                          </p>
                          {blocked && <p className="mt-1 text-xs text-amber-800" role="note">{blocked}</p>}
                        </div>
                        <div className="flex min-w-[180px] flex-col gap-1.5">
                          <label className="text-[11px] font-medium" htmlFor={`decision-${candidate.candidateId}`}>Independent decision</label>
                          <select
                            id={`decision-${candidate.candidateId}`}
                            className="h-9 w-full rounded-md border bg-background px-2 text-xs"
                            aria-label={`Review decision for contact ${candidate.contactId}`}
                            value={draft?.decision ?? ""}
                            disabled={!selected || Boolean(blocked) || reviewBatchMutation.isPending}
                            onChange={(event) => setDraft(candidate.candidateId, {
                              decision: event.target.value as ReviewDraft["decision"],
                              evidenceEventId: event.target.value === "verified" ? getEligibleEvidenceId(candidate) : "",
                            })}
                          >
                            <option value="">Choose…</option>
                            <option value="verified" disabled={!getEligibleEvidenceId(candidate)}>Verify link</option>
                            <option value="rejected">Reject candidate</option>
                          </select>
                          {getEligibleEvidenceId(candidate) ? (
                            <p className="text-[11px] text-muted-foreground" role="status">
                              {draft?.decision === "verified" ? "Eligible retained evidence will be attached automatically." : "Eligible retained evidence is available for verification."}
                            </p>
                          ) : (
                            <p className="rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-950" role="note">
                              Verification held: no eligible retained evidence is available. Next: recover the source record using Source recovery above, then refresh this candidate.
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                        <EvidenceReferences label="Retained evidence references" value={candidate.evidence} />
                        <EvidenceReferences label="Conflicts / competing references" value={candidate.conflicts} />
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-medium text-muted-foreground">Reasons:</span>
                        {reasonText.length ? reasonText.map((reason, index) => (
                          <Badge key={`${candidate.candidateId}-reason-${index}`} variant="secondary" className="text-[10px]">{reason}</Badge>
                        )) : <span className="text-[11px] text-muted-foreground">None returned</span>}
                      </div>
                      {outcome && (
                        <div className={`rounded-md border p-2 text-xs ${outcome.status === "applied" || outcome.status === "replayed"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100"
                          : "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"}`}
                          role="status">
                          Result: <strong>{outcome.status}</strong>
                          {outcome.code ? ` · ${redactText(outcome.code)}` : ""}
                          {/stale|revision|conflict/i.test(`${outcome.status} ${outcome.code ?? ""}`) && (
                            <span> · Refresh this candidate before retrying; the server rejected a stale or changed revision.</span>
                          )}
                          {outcome.code === "CONTACT_LINK_RETAINED_EVIDENCE_UNAVAILABLE" && (
                            <span> · Verification held because no attributable, business-bound retained event was available. Next: recover the source record above, then refresh and review again.</span>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
                {visibleCandidates.length === 0 && (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    No records in this candidate page. Use the server cursor to continue; this is not evidence that the census pool is empty.
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={cursorHistory.length === 0 || candidatesQuery.isFetching || reviewBatchMutation.isPending}
                    onClick={() => {
                      const previous = cursorHistory[cursorHistory.length - 1];
                      setCursorHistory((history) => history.slice(0, -1));
                      setCursor(previous);
                      setSelectedCandidateIds([]);
                    }}>
                    Previous page
                  </Button>
                  <Button size="sm" variant="outline" disabled={nextCandidatesCursor == null || candidatesQuery.isFetching || reviewBatchMutation.isPending}
                    onClick={() => {
                      if (nextCandidatesCursor == null) return;
                      setCursorHistory((history) => [...history, cursor]);
                      setCursor(nextCandidatesCursor);
                      setSelectedCandidateIds([]);
                    }}>
                    Next page
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline"
                    disabled={selectedRows.length === 0 || selectedRows.some((candidate) => !getEligibleEvidenceId(candidate)) || reviewBatchMutation.isPending}
                    onClick={() => setReviewDrafts((current) => {
                      const next = { ...current };
                      for (const candidate of selectedRows) {
                        const previous = next[candidate.candidateId] ?? {
                          decision: "",
                          evidenceEventId: "",
                        };
                        next[candidate.candidateId] = {
                          ...previous,
                          decision: "verified",
                          evidenceEventId: getEligibleEvidenceId(candidate),
                        };
                      }
                      return next;
                    })}>
                    Set selected to verify
                  </Button>
                  <Button size="sm" variant="outline" disabled={selectedRows.length === 0 || reviewBatchMutation.isPending}
                    onClick={() => setReviewDrafts((current) => {
                      const next = { ...current };
                      for (const candidate of selectedRows) {
                        const previous = next[candidate.candidateId] ?? {
                          decision: "",
                          evidenceEventId: "",
                        };
                        next[candidate.candidateId] = {
                          ...previous,
                          decision: "rejected",
                          evidenceEventId: "",
                        };
                      }
                      return next;
                    })}>
                    Set selected to reject
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button size="sm" disabled={selectedRows.length === 0 || anyDraftMissing || selectedNeedsEvidence || reviewBatchMutation.isPending}>
                        {reviewBatchMutation.isPending ? "Submitting…" : `Submit ${selectedRows.length} review${selectedRows.length === 1 ? "" : "s"}`}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Submit these explicit contact-link decisions?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The reviewed writer will recheck the candidate revision and snapshot. Stale, conflicting, or invalid decisions
                          remain per-record results. Verification automatically attaches eligible retained evidence returned for the candidate.
                          Evidence unavailable from an independent, business-bound source is held for source recovery. Nothing is automatically approved.
                          This does not validate email or authorize outbound contact.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => reviewBatchMutation.mutate()}>
                          Submit {selectedRows.length} decisions
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
              {(anyDraftMissing || selectedNeedsEvidence) && selectedRows.length > 0 && (
                <p className="text-xs text-amber-800" role="status">
                  Choose a decision for each selected record{selectedNeedsEvidence ? " and recover eligible retained evidence before verifying" : ""} before submitting.
                </p>
              )}
              {reviewBatchMutation.isError && (
                <p className="text-xs text-destructive" role="alert">Review batch failed: {(reviewBatchMutation.error as Error).message}</p>
              )}
              {reviewBatchMutation.data?.outcomes?.some((outcome) => outcome.status === "stale" || /revision/i.test(outcome.code ?? "")) && (
                <p className="text-xs text-amber-800" role="status">One or more records were stale or had a revision conflict. Refresh the page before making a new decision.</p>
              )}
            </>
          ) : null}
        </section>
      </CardContent>
    </Card>
  );
}