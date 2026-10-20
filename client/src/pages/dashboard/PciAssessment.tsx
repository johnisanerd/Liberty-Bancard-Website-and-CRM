import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Shield, ShieldCheck, ShieldAlert, AlertTriangle, AlertCircle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PCI_REQUIREMENTS } from "@shared/pci-requirements";

const CATEGORY_ICONS: Record<string, typeof Shield> = {
  "Network Security": Shield,
  "Data Protection": ShieldCheck,
  "Access Control": ShieldAlert,
  "Regular Testing": AlertTriangle,
};

const PCI_CATEGORIES = Array.from(new Set(PCI_REQUIREMENTS.map((r) => r.category))).map((categoryName) => ({
  name: categoryName,
  icon: CATEGORY_ICONS[categoryName] ?? Shield,
  items: PCI_REQUIREMENTS.filter((r) => r.category === categoryName).map((r) => ({ id: r.id, label: r.label })),
}));

const ALL_ITEMS = PCI_CATEGORIES.flatMap((c) => c.items);

interface PciAssessmentState {
  checkedRequirementIds: string[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export default function PciAssessment() {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery<PciAssessmentState>({
    queryKey: ["/api/admin/pci-assessment"],
  });

  useEffect(() => {
    if (data) {
      setChecked(new Set(data.checkedRequirementIds));
    }
  }, [data]);

  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const latestRequestIdRef = useRef(0);

  const mutation = useMutation({
    mutationFn: async (checkedRequirementIds: string[]) => {
      const res = await apiRequest("PATCH", "/api/admin/pci-assessment", { checkedRequirementIds });
      return res.json();
    },
  });

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
    setSaveError(null);

    const nextIds = Array.from(next);
    const requestId = ++latestRequestIdRef.current;

    // Chain saves serially so rapid consecutive toggles are sent to the
    // server in order, instead of racing and letting an older request's
    // response overwrite a newer one.
    saveQueueRef.current = saveQueueRef.current
      .catch(() => {})
      .then(() => mutation.mutateAsync(nextIds))
      .then((response: PciAssessmentState) => {
        queryClient.setQueryData(["/api/admin/pci-assessment"], response);
        if (requestId === latestRequestIdRef.current) {
          setSaveError(null);
        }
      })
      .catch((err: any) => {
        // Only surface the error / resync if no newer toggle has already
        // superseded this request.
        if (requestId === latestRequestIdRef.current) {
          setSaveError(err?.message || "Failed to save checklist. Your change was not saved.");
          queryClient.invalidateQueries({ queryKey: ["/api/admin/pci-assessment"] });
        }
      });
  };

  const total = ALL_ITEMS.length;
  const completed = checked.size;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  let statusLabel: string;
  let statusVariant: "default" | "secondary" | "destructive" | "outline";
  let statusColor: string;

  if (percentage === 100) {
    statusLabel = "Compliant";
    statusVariant = "default";
    statusColor = "bg-green-600 text-white";
  } else if (percentage >= 75) {
    statusLabel = "Needs Improvement";
    statusVariant = "secondary";
    statusColor = "bg-yellow-500 text-black";
  } else {
    statusLabel = "Action Required";
    statusVariant = "destructive";
    statusColor = "bg-red-600 text-white";
  }

  if (isLoading) {
    return (
      <div className="space-y-6 p-4 md:p-6" data-testid="page-pci-assessment">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-6 p-4 md:p-6" data-testid="page-pci-assessment">
        <h2 className="text-2xl font-bold text-foreground" data-testid="text-pci-heading">
          PCI-DSS Self-Assessment
        </h2>
        <Alert variant="destructive" data-testid="alert-pci-load-error">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load PCI assessment checklist: {(error as any)?.message || "Unknown error"}. Please refresh to try again.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="page-pci-assessment">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-bold text-foreground" data-testid="text-pci-heading">
          PCI-DSS Self-Assessment
        </h2>
        <Badge className={statusColor} data-testid="badge-pci-status">
          {statusLabel}
        </Badge>
      </div>

      {saveError && (
        <Alert variant="destructive" data-testid="alert-pci-save-error">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      <Card data-testid="card-pci-intro">
        <CardContent className="pt-6 space-y-3">
          <p className="text-muted-foreground" data-testid="text-pci-intro">
            The Payment Card Industry Data Security Standard (PCI-DSS) is a set of security requirements designed to ensure that all companies that process, store, or transmit credit card information maintain a secure environment. Compliance is mandatory for all merchants who accept card payments.
          </p>
          <p className="text-muted-foreground">
            Use this self-assessment checklist to evaluate your current compliance posture. Check each item that your business currently meets, and track your progress toward full compliance.
          </p>
        </CardContent>
      </Card>

      <Card data-testid="card-pci-progress">
        <CardContent className="pt-6 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground" data-testid="text-pci-score">
              Compliance Score: {percentage}%
            </span>
            <span className="text-sm text-muted-foreground" data-testid="text-pci-completed">
              {completed} of {total} requirements met
            </span>
          </div>
          <Progress value={percentage} className="h-3" data-testid="progress-pci-score" />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {PCI_CATEGORIES.map((category) => {
          const Icon = category.icon;
          const catCompleted = category.items.filter((i) => checked.has(i.id)).length;
          return (
            <Card key={category.name} data-testid={`card-pci-category-${category.name.toLowerCase().replace(/\s+/g, "-")}`}>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Icon className="w-4 h-4 shrink-0" />
                  {category.name}
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  {catCompleted}/{category.items.length}
                </span>
              </CardHeader>
              <CardContent className="space-y-3">
                {category.items.map((item) => (
                  <label
                    key={item.id}
                    className="flex items-start gap-3 cursor-pointer"
                    data-testid={`checkbox-pci-${item.id}`}
                  >
                    <Checkbox
                      checked={checked.has(item.id)}
                      onCheckedChange={() => toggle(item.id)}
                      data-testid={`input-pci-${item.id}`}
                    />
                    <span className="text-sm text-muted-foreground leading-tight">
                      {item.label}
                    </span>
                  </label>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card data-testid="card-pci-disclaimer">
        <CardContent className="pt-6">
          <p className="text-xs text-muted-foreground italic" data-testid="text-pci-disclaimer">
            This self-assessment is for informational purposes only and does not constitute a formal PCI-DSS audit. Contact a Qualified Security Assessor (QSA) for official certification.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
