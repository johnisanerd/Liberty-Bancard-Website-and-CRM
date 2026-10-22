import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, CrmPage, ScopedMetricStrip } from "@/components/crm/CrmPresentation";
import {
  Users, Building2, DollarSign, Calendar, CheckCircle, Clock,
  Search, Plus, Edit, ExternalLink, Loader2, RefreshCw,
} from "lucide-react";
import type { Partner } from "@shared/schema";

const PARTNER_CATEGORIES = [
  { value: "agent", label: "Agent" },
  { value: "iso", label: "ISO" },
  { value: "cpa_accountant", label: "CPA / Accountant" },
  { value: "pos_vendor", label: "POS Vendor" },
  { value: "web_agency", label: "Web Agency" },
  { value: "local_partner", label: "Local Partner" },
  { value: "referral", label: "Referral" },
];

const COMMISSION_STATUSES = [
  { value: "pending", label: "Pending", badge: "secondary" as const },
  { value: "approved", label: "Approved", badge: "outline" as const },
  { value: "paid", label: "Paid", badge: "default" as const },
];

type EnrichedPartner = Partner & {
  referredMerchantCount: number;
  pipelineValue: number;
  nextFollowupDue: string | null;
};

function formatDate(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function categoryLabel(cat: string | null | undefined) {
  return PARTNER_CATEGORIES.find(c => c.value === cat)?.label || cat || "Referral";
}

function commissionBadge(status: string | null | undefined) {
  const cfg = COMMISSION_STATUSES.find(s => s.value === status) || COMMISSION_STATUSES[0];
  return <Badge variant={cfg.badge} className="text-xs">{cfg.label}</Badge>;
}

function TrackingEditDialog({ partner, onClose }: { partner: EnrichedPartner; onClose: () => void }) {
  const { toast } = useToast();
  const [referralOwner, setReferralOwner] = useState(partner.referralOwner || "");
  const [commissionStatus, setCommissionStatus] = useState(partner.commissionStatus || "pending");
  const [partnerCategory, setPartnerCategory] = useState(partner.partnerCategory || "referral");
  const [notes, setNotes] = useState(partner.notes || "");

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/partners/${partner.id}/tracking`, {
        referralOwner: referralOwner || null,
        commissionStatus,
        partnerCategory,
        notes,
        lastContactAt: new Date().toISOString(),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/partners/referral-pipeline"] });
      toast({ title: "Partner updated" });
      onClose();
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label className="text-sm font-medium">Partner Type</label>
          <Select value={partnerCategory} onValueChange={setPartnerCategory}>
            <SelectTrigger data-testid="select-partner-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PARTNER_CATEGORIES.map(c => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium">Commission Status</label>
          <Select value={commissionStatus} onValueChange={setCommissionStatus}>
            <SelectTrigger data-testid="select-commission-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMMISSION_STATUSES.map(s => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Referral Owner (Liberty Staff)</label>
        <Input
          value={referralOwner}
          onChange={e => setReferralOwner(e.target.value)}
          placeholder="e.g. Scott Stevenson"
          data-testid="input-referral-owner"
        />
      </div>
      <div className="space-y-1">
        <label className="text-sm font-medium">Notes</label>
        <Input
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Partner notes…"
          data-testid="input-partner-notes"
        />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} data-testid="button-save-tracking">
          {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}

export default function PartnerReferralPipeline() {
  const [search, setSearch] = useState("");
  const [editPartner, setEditPartner] = useState<EnrichedPartner | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("all");

  const { data: partners = [], isLoading, refetch } = useQuery<EnrichedPartner[]>({
    queryKey: ["/api/partners/referral-pipeline"],
  });

  const filtered = partners.filter(p => {
    const matchesSearch = !search.trim() ||
      p.companyName?.toLowerCase().includes(search.toLowerCase()) ||
      p.contactName?.toLowerCase().includes(search.toLowerCase()) ||
      p.email?.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = categoryFilter === "all" || p.partnerCategory === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  const totalReferrals = partners.reduce((s, p) => s + (p.referredMerchantCount || 0), 0);
  const totalPipelineValue = partners.reduce((s, p) => s + Number(p.pipelineValue || 0), 0);
  const activePartners = partners.filter(p => p.status === "active").length;

  return (
    <CrmPage className="space-y-6" data-testid="page-partner-referral-pipeline">
      <PageHeader
        title="Partner Referral Pipeline"
        subtitle="Track partners, referred merchants, commission status, and follow-up schedules"
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-partners">
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
        }
      />

      {/* KPIs */}
      <ScopedMetricStrip className="grid-cols-2 sm:grid-cols-4 md:grid-cols-4 xl:grid-cols-4" scopeId="PartnerReferralPipeline">
        <Card data-testid="kpi-total-partners">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Users className="w-4 h-4 text-primary" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Active Partners</p>
                <p className="text-xl font-bold">{isLoading ? "…" : activePartners}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-total-referrals">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
                <Building2 className="w-4 h-4 text-blue-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Total Referrals</p>
                <p className="text-xl font-bold">{isLoading ? "…" : totalReferrals}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-pipeline-value">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
                <DollarSign className="w-4 h-4 text-green-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Pipeline Value</p>
                <p className="text-xl font-bold">${totalPipelineValue.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card data-testid="kpi-total-all-partners">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-purple-100 dark:bg-purple-900/40 flex items-center justify-center">
                <CheckCircle className="w-4 h-4 text-purple-600" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">All Partners</p>
                <p className="text-xl font-bold">{isLoading ? "…" : partners.length}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </ScopedMetricStrip>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search partners…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9"
            data-testid="input-search-partners"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-44" data-testid="select-category-filter">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {PARTNER_CATEGORIES.map(c => (
              <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Partner Cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1,2,3].map(i => <Card key={i}><CardContent className="p-4 h-32 animate-pulse bg-muted/20" /></Card>)}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <Users className="w-12 h-12 text-muted-foreground opacity-30" />
            <p className="font-medium text-muted-foreground">No partners found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(partner => (
            <Card key={partner.id} data-testid={`card-partner-${partner.id}`}>
              <CardContent className="p-4 space-y-3">
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate" data-testid={`text-partner-name-${partner.id}`}>
                      {partner.companyName}
                    </p>
                    {partner.contactName && (
                      <p className="text-xs text-muted-foreground">{partner.contactName}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge variant={partner.status === "active" ? "default" : "secondary"} className="text-xs">
                      {partner.status}
                    </Badge>
                    {commissionBadge(partner.commissionStatus)}
                  </div>
                </div>

                {/* Type badge */}
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline" className="text-xs">
                    {categoryLabel(partner.partnerCategory)}
                  </Badge>
                  {partner.affiliateCode && (
                    <Badge variant="secondary" className="text-xs font-mono">
                      {partner.affiliateCode}
                    </Badge>
                  )}
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="space-y-0.5">
                    <p className="text-muted-foreground">Referred Merchants</p>
                    <p className="font-semibold text-base" data-testid={`text-referred-count-${partner.id}`}>
                      {partner.referredMerchantCount}
                    </p>
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-muted-foreground">Pipeline Value</p>
                    <p className="font-semibold text-base text-green-600">
                      ${Number(partner.pipelineValue || 0).toLocaleString()}
                    </p>
                  </div>
                </div>

                {/* Contact info */}
                <div className="space-y-1 text-xs text-muted-foreground">
                  {partner.referralOwner && (
                    <div className="flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      <span>Owner: <span className="text-foreground font-medium">{partner.referralOwner}</span></span>
                    </div>
                  )}
                  {partner.lastContactAt && (
                    <div className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      <span>Last contact: {formatDate(partner.lastContactAt)}</span>
                    </div>
                  )}
                  {partner.nextFollowupDue && (
                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span>Next follow-up: {formatDate(partner.nextFollowupDue)}</span>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 h-7 text-xs"
                    onClick={() => setEditPartner(partner)}
                    data-testid={`button-edit-partner-${partner.id}`}
                  >
                    <Edit className="w-3 h-3 mr-1" />
                    Track
                  </Button>
                  {partner.email && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      asChild
                      data-testid={`button-email-partner-${partner.id}`}
                    >
                      <a href={`mailto:${partner.email}`} aria-label={`Email ${partner.email}`}>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={!!editPartner} onOpenChange={open => { if (!open) setEditPartner(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Update Partner Tracking — {editPartner?.companyName}</DialogTitle>
          </DialogHeader>
          {editPartner && (
            <TrackingEditDialog partner={editPartner} onClose={() => setEditPartner(null)} />
          )}
        </DialogContent>
      </Dialog>
    </CrmPage>
  );
}
