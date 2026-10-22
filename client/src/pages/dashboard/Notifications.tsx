import { useState, useCallback,useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCheck, AlertTriangle, Info, AlertCircle, Settings, Trash2, Mail, Bell, Calendar, X } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DataState } from "@/components/ui/data-state";
import { PageHeader } from "@/components/crm/CrmPresentation";
import { toastError } from "@/lib/toast-helpers";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import type { NotificationPreference } from "@shared/schema";
import { NOTIFICATION_EVENT_TYPES } from "@shared/schema";

type DigestHealth = {
  emailProviderConfigured: boolean;
  ghlConfigured: boolean;
  smtpConfigured: boolean;
  schedulerActive: boolean | null;
  lastDailyDigestSentAt: string | null;
  lastWeeklyDigestSentAt: string | null;
  reason: string | null;
};

type DigestAvailability = {
  deliveryAvailable: boolean;
  status: "active" | "not_configured" | "inactive" | "unknown";
  message: string;
  // Backward-compatible aliases kept by the backend for older consumers.
  deliverable?: boolean;
  reason?: string | null;
};

type NotificationRecord = {
  target?:{state:string;url:string|null;label?:string;context?:string};
  id: number;
  title: string;
  message: string;
  type: string | null;
  read: boolean | null;
  createdAt: string | null;
  metadata: Record<string, unknown> | null;
};

type PaginatedNotifications = {
  data: NotificationRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};

const CATEGORY_TABS = [
  { value: "all", label: "All" },
  { value: "leads", label: "Leads" },
  { value: "deals", label: "Deals" },
  { value: "sla", label: "SLA" },
  { value: "system", label: "System" },
];

const PAGE_SIZE = 25;

function getTypeIcon(type: string | null) {
  switch (type) {
    case "urgent":  return <AlertTriangle className="w-4 h-4 text-destructive" />;
    case "alert":   return <AlertCircle className="w-4 h-4 text-amber-500" />;
    case "warning": return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    case "success": return <CheckCheck className="w-4 h-4 text-green-500" />;
    default:        return <Info className="w-4 h-4 text-muted-foreground" />;
  }
}

function getTypeVariant(type: string | null): "destructive" | "default" | "secondary" | "outline" {
  switch (type) {
    case "urgent":  return "destructive";
    case "alert":   return "default";
    case "warning": return "outline";
    case "success": return "secondary";
    default:        return "secondary";
  }
}

function getTypeLabel(type: string | null): string {
  switch (type) {
    case "urgent":  return "Urgent";
    case "alert":   return "Alert";
    case "warning": return "Warning";
    case "success": return "Success";
    default:        return "Info";
  }
}

type NotificationEntityType =
  | "contact" | "ticket" | "deal" | "rfi" | "chat" | "merchant" | "lead";

interface NotificationLinkMetadata {
  link?: string;
  entityType?: NotificationEntityType;
  entityId?: number | string;
  contactId?: number;
  ticketId?: number;
  rfiId?: number;
  chatId?: number;
  dealId?: number;
  merchantId?: number;
  leadId?: number;
  importId?: number;
  digestType?: "daily" | "weekly";
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getNotificationLink(notification: NotificationRecord): string | null {
  return notification.target?.state==="available" ? notification.target.url:null;
}

function formatEventType(eventType: string): string {
  return eventType
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function getEventDescription(eventType: string): string {
  const descriptions: Record<string, string> = {
    deal_created: "When a new deal is created",
    deal_stage_changed: "When a deal moves to a new stage",
    deal_closed_won: "When a deal is closed as won",
    ticket_created: "When a support ticket is opened",
    ticket_updated: "When a ticket status changes",
    task_assigned: "When a task is assigned to someone",
    task_due_soon: "When a task deadline is approaching",
    sla_breach: "When an SLA deadline is missed",
    contact_created: "When a new contact is added",
    hot_lead: "When a high-score lead is detected",
    sequence_completed: "When a follow-up sequence finishes",
    mention: "When you are mentioned",
    comment_reply: "When someone replies to your comment",
    daily_digest: "Daily summary of activity",
    weekly_digest: "Weekly KPI report",
  };
  return descriptions[eventType] || "";
}

export default function Notifications() {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [category, setCategory] = useState("all");
  const [offset, setOffset] = useState(0);
  const [allLoaded, setAllLoaded] = useState<NotificationRecord[]>([]);
  const [prefsOpen, setPrefsOpen] = useState(false);

  const isAdminOrManager = user?.role === "admin" || user?.role === "manager";
  const { data: digestHealth } = useQuery<DigestHealth>({
    queryKey: ["/api/notifications/digest-health"],
    enabled: isAdminOrManager && prefsOpen,
  });
  // Minimal, non-privileged signal available to every user so the digest
  // toggle can distinguish "preference saved" from "will actually be
  // delivered" regardless of role.
  const { data: digestAvailability } = useQuery<DigestAvailability>({
    queryKey: ["/api/notifications/digest-availability"],
    enabled: prefsOpen,
  });

  const queryKey = ["/api/notifications",user?.id,user?.accountVersion,category,offset];
  useEffect(()=>{setOffset(0);setAllLoaded([]);},[user?.id,user?.accountVersion]);

  const { data: page, isLoading, isError, refetch } = useQuery<PaginatedNotifications>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(
        `/api/notifications?limit=${PAGE_SIZE}&offset=${offset}&category=${category}`,
        { credentials: "include" }
      );
      if (!res.ok) throw new Error("Failed to fetch notifications");
      return res.json();
    },
    placeholderData: (prev) => prev,
  });

  // Accumulate pages when "Load more" is clicked
  const notifications: NotificationRecord[] = (() => {
    if (!page) return allLoaded;
    const pageIds = new Set(page.data.map((n) => n.id));
    const combined = [...allLoaded.filter((n) => !pageIds.has(n.id)), ...page.data];
    return combined.sort((a, b) =>
      new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
    );
  })();

  const total = page?.total ?? 0;
  // Use server-provided hasMore which is based on DB total (before preference filtering),
  // so we don't stop prematurely when preferences reduce the visible count of a page.
  const hasMore = page?.hasMore === true;

  const { data: countData } = useQuery<{ unread: number }>({
    queryKey: ["/api/notifications/count"],
  });
  const unreadCount = countData?.unread ?? 0;

  const { data: preferences, isLoading: prefsLoading } = useQuery<NotificationPreference[]>({
    queryKey: ["/api/notification-preferences"],
  });

  const invalidateAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["/api/notifications"] });
    qc.invalidateQueries({ queryKey: ["/api/notifications/count"] });
  }, [qc]);

  const markReadMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("PUT", `/api/notifications/${id}/read`);
    },
    onSuccess: (_data, id) => {
      // Update accumulated pages state
      setAllLoaded((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n));
      // Update the current page in the query cache so UI reflects change immediately
      qc.setQueryData(queryKey, (old: PaginatedNotifications | undefined) => {
        if (!old) return old;
        return { ...old, data: old.data.map((n) => n.id === id ? { ...n, read: true } : n) };
      });
      // Refresh the unread badge count
      qc.invalidateQueries({ queryKey: ["/api/notifications/count"] });
    },
    onError: (err: Error) => {
      toastError(err, { title: "Failed to mark as read" });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/notifications/${id}`);
    },
    onSuccess: (_, id) => {
      setAllLoaded((prev) => prev.filter((n) => n.id !== id));
      invalidateAll();
    },
    onError: (err: Error) => {
      toastError(err, { title: "Failed to dismiss notification" });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/notifications/mark-all-read");
    },
    onSuccess: () => {
      setAllLoaded((prev) => prev.map((n) => ({ ...n, read: true })));
      invalidateAll();
      toast({ title: "All notifications marked as read" });
    },
    onError: (err: Error) => {
      toastError(err, { title: "Failed to mark all as read" });
    },
  });

  const clearOldReadMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", "/api/notifications/read");
    },
    onSuccess: (data: any) => {
      const deleted = data?.deleted ?? 0;
      setAllLoaded([]);
      setOffset(0);
      invalidateAll();
      toast({ title: deleted > 0 ? `Removed ${deleted} old read notification${deleted !== 1 ? "s" : ""}` : "No old read notifications to clear" });
    },
    onError: (err: Error) => {
      toastError(err, { title: "Failed to clear old notifications" });
    },
  });

  const handleNotificationClick = useCallback(async(notification: NotificationRecord) => {
    if (!notification.read) {
      markReadMutation.mutate(notification.id);
    }
    try {
      const response=await apiRequest("GET",`/api/notifications/${notification.id}/target`);
      const target=await response.json();
      if(target.state==="available" && target.url) navigate(target.url);
      else toast({title:"Record unavailable",description:"The destination is missing, archived, unsupported or no longer authorized."});
    } catch(error) {toastError(error as Error,{title:"Destination unavailable — retry"});}
  }, [navigate,markReadMutation,toast,toastError]);

  const updatePrefMutation = useMutation({
    mutationFn: async (params: { eventType: string; enabled?: boolean; emailEnabled?: boolean; digestDaily?: boolean; digestWeekly?: boolean }) => {
      await apiRequest("PUT", "/api/notification-preferences", params);
      return params;
    },
    onSuccess: (params) => {
      qc.invalidateQueries({ queryKey: ["/api/notification-preferences"] });
      // Only surface the digest-delivery caveat for the digest toggles themselves
      // (digestDaily/digestWeekly), not for unrelated per-event email toggles.
      const enablingDigest = (params.digestDaily === true || params.digestWeekly === true);
      if (enablingDigest && digestAvailability && !digestAvailability.deliveryAvailable) {
        toast({
          title: "Preference saved",
          description: digestAvailability.message || "Note: digest emails are not currently deliverable, so this preference will have no effect until delivery is available.",
        });
      }
    },
    onError: (err: Error) => {
      toastError(err, { title: "Failed to update preference" });
    },
  });

  function handleCategoryChange(val: string) {
    setCategory(val);
    setOffset(0);
    setAllLoaded([]);
  }

  function handleLoadMore() {
    setAllLoaded(notifications);
    setOffset((prev) => prev + PAGE_SIZE);
  }

  function getPref(eventType: string) {
    const pref = preferences?.find((p) => p.eventType === eventType);
    return {
      enabled: pref ? !!pref.enabled : true,
      emailEnabled: pref ? !!pref.emailEnabled : false,
      digestDaily: pref ? !!pref.digestDaily : true,
      digestWeekly: pref ? !!pref.digestWeekly : true,
    };
  }

  const eventNotificationTypes = NOTIFICATION_EVENT_TYPES.filter(
    (t) => t !== "daily_digest" && t !== "weekly_digest"
  );
  const digestTypes = NOTIFICATION_EVENT_TYPES.filter(
    (t) => t === "daily_digest" || t === "weekly_digest"
  );

  if ((isLoading && notifications.length === 0) || isError) {
    return (
      <DataState
        query={{ isLoading: isLoading && notifications.length === 0, isError, refetch }}
        loadingFallback={
          <div className="space-y-3" data-testid="notifications-loading">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="border rounded-md p-4 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            ))}
          </div>
        }
        errorTitle="Failed to load notifications"
        testId="notifications"
      >
        {null}
      </DataState>
    );
  }

  return (
    <div className="space-y-6" data-testid="notifications-page">
      <PageHeader
        title="Notifications"
        subtitle={unreadCount > 0 ? `${unreadCount} unread` : undefined}
        testId="text-notifications-title"
        actions={
          <>
            {unreadCount > 0 && (
              <Button
                variant="outline"
                onClick={() => markAllReadMutation.mutate()}
                disabled={markAllReadMutation.isPending}
                className="gap-2"
                data-testid="button-mark-all-read"
              >
                <CheckCheck className="w-4 h-4" />
                Mark All Read
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => clearOldReadMutation.mutate()}
              disabled={clearOldReadMutation.isPending}
              className="gap-2"
              data-testid="button-clear-old-read"
            >
              <Trash2 className="w-4 h-4" />
              Clear Old Read
            </Button>
            <Dialog open={prefsOpen} onOpenChange={setPrefsOpen}>
              <DialogTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Notification settings"
                  data-testid="button-notification-settings"
                >
                  <Settings className="w-4 h-4" />
                </Button>
              </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" data-testid="dialog-notification-preferences">
              <DialogHeader>
                <DialogTitle data-testid="text-preferences-title">Notification Preferences</DialogTitle>
              </DialogHeader>
              <Tabs defaultValue="events" className="w-full">
                <TabsList className="w-full" data-testid="tabs-preferences">
                  <TabsTrigger value="events" className="flex-1 gap-1" data-testid="tab-events">
                    <Bell className="w-3 h-3" />
                    Events
                  </TabsTrigger>
                  <TabsTrigger value="digests" className="flex-1 gap-1" data-testid="tab-digests">
                    <Calendar className="w-3 h-3" />
                    Digests
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="events" className="space-y-1 mt-4" data-testid="tab-content-events">
                  <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 items-center mb-2">
                    <span className="text-xs font-medium text-muted-foreground">Event</span>
                    <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <Bell className="w-3 h-3" /> In-App
                    </span>
                    <span className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                      <Mail className="w-3 h-3" /> Email
                    </span>
                  </div>
                  {prefsLoading ? (
                    <div className="text-muted-foreground text-sm py-4">Loading preferences...</div>
                  ) : (
                    eventNotificationTypes.map((eventType) => {
                      const pref = getPref(eventType);
                      return (
                        <div
                          key={eventType}
                          className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 items-center py-2 border-b border-border/50"
                          data-testid={`pref-row-${eventType}`}
                        >
                          <div>
                            <span className="text-sm font-medium" data-testid={`text-pref-label-${eventType}`}>
                              {formatEventType(eventType)}
                            </span>
                            <p className="text-xs text-muted-foreground">
                              {getEventDescription(eventType)}
                            </p>
                          </div>
                          <Switch
                            checked={pref.enabled}
                            onCheckedChange={(checked) =>
                              updatePrefMutation.mutate({ eventType, enabled: checked })
                            }
                            disabled={updatePrefMutation.isPending}
                            data-testid={`switch-pref-${eventType}`}
                          />
                          <Switch
                            checked={pref.emailEnabled}
                            onCheckedChange={(checked) =>
                              updatePrefMutation.mutate({ eventType, emailEnabled: checked })
                            }
                            disabled={updatePrefMutation.isPending}
                            data-testid={`switch-email-${eventType}`}
                          />
                        </div>
                      );
                    })
                  )}
                </TabsContent>

                <TabsContent value="digests" className="space-y-4 mt-4" data-testid="tab-content-digests">
                  <p className="text-sm text-muted-foreground">
                    Control which automated digest emails you receive.
                  </p>
                  {isAdminOrManager && (
                    <Card data-testid="card-digest-health">
                      <CardContent className="p-4 space-y-2">
                        <div className="flex items-center gap-2">
                          {digestHealth ? (
                            digestHealth.emailProviderConfigured ? (
                              <CheckCheck className="w-4 h-4 text-green-500" />
                            ) : (
                              <AlertTriangle className="w-4 h-4 text-amber-500" />
                            )
                          ) : (
                            <Info className="w-4 h-4 text-muted-foreground" />
                          )}
                          <span className="text-sm font-medium" data-testid="text-digest-health-title">
                            Digest Delivery Status
                          </span>
                        </div>
                        {!digestHealth ? (
                          <p className="text-xs text-muted-foreground">Loading delivery status...</p>
                        ) : (
                          <div className="space-y-1 text-xs text-muted-foreground" data-testid="text-digest-health-detail">
                            <p>
                              Email provider:{" "}
                              <span className={digestHealth.emailProviderConfigured ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}>
                                {digestHealth.emailProviderConfigured
                                  ? `Active (${digestHealth.ghlConfigured ? "GHL" : "SMTP"})`
                                  : "Not configured"}
                              </span>
                            </p>
                            <p>
                              Scheduler:{" "}
                              <span className={digestHealth.schedulerActive === true ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}>
                                {digestHealth.schedulerActive === true ? "Running" : digestHealth.schedulerActive === false ? "Paused" : "Unknown"}
                              </span>
                            </p>
                            <p>Last daily digest sent: {digestHealth.lastDailyDigestSentAt || "Never"}</p>
                            <p>Last weekly digest sent: {digestHealth.lastWeeklyDigestSentAt || "Never"}</p>
                            {digestHealth.reason && (
                              <p className="text-amber-600 dark:text-amber-400 pt-1" data-testid="text-digest-health-reason">
                                {digestHealth.reason}
                              </p>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}
                  {digestAvailability && !digestAvailability.deliveryAvailable && (
                    <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="text-digest-toggle-caveat">
                      {digestAvailability.message || "Note: toggling these preferences saves your choice, but digest emails are not currently deliverable."}
                    </p>
                  )}
                  {digestTypes.map((eventType) => {
                    const pref = getPref(eventType);
                    const isDaily = eventType === "daily_digest";
                    return (
                      <Card key={eventType} data-testid={`pref-row-${eventType}`}>
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <div className="flex items-center gap-2">
                                <Calendar className="w-4 h-4 text-muted-foreground" />
                                <span className="font-medium text-sm" data-testid={`text-pref-label-${eventType}`}>
                                  {isDaily ? "Daily Activity Digest" : "Weekly KPI Digest"}
                                </span>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1">
                                {isDaily
                                  ? "New leads, deals progressed, tasks overdue, tickets. Sent at 8 AM EST."
                                  : "Pipeline value, win rate, revenue, rep leaderboard. Sent Monday 9 AM EST."}
                              </p>
                            </div>
                            <Switch
                              checked={isDaily ? pref.digestDaily : pref.digestWeekly}
                              onCheckedChange={(checked) =>
                                updatePrefMutation.mutate(
                                  isDaily
                                    ? { eventType, digestDaily: checked }
                                    : { eventType, digestWeekly: checked }
                                )
                              }
                              disabled={updatePrefMutation.isPending}
                              data-testid={`switch-digest-${eventType}`}
                            />
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </TabsContent>
              </Tabs>
            </DialogContent>
          </Dialog>
          </>
        }
      />

      {/* Category filter tabs */}
      <Tabs value={category} onValueChange={handleCategoryChange} data-testid="tabs-category-filter">
        <TabsList data-testid="tabs-list-category">
          {CATEGORY_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} data-testid={`tab-category-${tab.value}`}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {CATEGORY_TABS.map((tab) => (
          <TabsContent key={tab.value} value={tab.value} className="mt-4">
            <div className="space-y-3" data-testid="notifications-list">
              {notifications.length === 0 && !isLoading && (
                <DataState
                  query={{ data: [] }}
                  emptyTitle="No notifications"
                  emptyMessage="You're all caught up. New activity will appear here."
                  testId="notifications-empty"
                >
                  {null}
                </DataState>
              )}
              {notifications.map((notification) => {
                const link = getNotificationLink(notification);
                return (
                <Card
                  key={notification.id}
                  className={`hover-elevate ${!notification.read ? "" : "opacity-60"} ${link ? "cursor-pointer" : ""}`}
                  data-testid={`card-notification-${notification.id}`}
                  data-notification-link={link ?? ""}
                  onClick={() => handleNotificationClick(notification)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex-shrink-0">
                        {getTypeIcon(notification.type)}
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm" data-testid={`text-notification-title-${notification.id}`}>
                            {notification.title}
                          </span>
                          <Badge
                            variant={getTypeVariant(notification.type)}
                            className="text-xs no-default-hover-elevate no-default-active-elevate"
                            data-testid={`badge-notification-type-${notification.id}`}
                          >
                            {getTypeLabel(notification.type)}
                          </Badge>
                          {!notification.read && (
                            <Badge variant="outline" className="text-xs no-default-hover-elevate no-default-active-elevate" data-testid={`badge-notification-unread-${notification.id}`}>
                              Unread
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground" data-testid={`text-notification-message-${notification.id}`}>
                          {notification.message}
                        </p>
                        <div className="text-xs text-muted-foreground" data-testid={`text-notification-time-${notification.id}`}>
                          {notification.createdAt ? new Date(notification.createdAt).toLocaleString() : ""}
                        </div>
                      </div>
                      {notification.target?.context==="authorized_list_fallback" && <span className="text-xs text-muted-foreground">
                        {notification.target.label}
                      </span>}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="flex-shrink-0 h-6 w-6 text-muted-foreground hover:text-foreground"
                        aria-label="Dismiss notification"
                        onClick={(e) => {
                          e.stopPropagation();
                          dismissMutation.mutate(notification.id);
                        }}
                        disabled={dismissMutation.isPending}
                        data-testid={`button-dismiss-${notification.id}`}
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
                );
              })}
              {isLoading && (
                <div className="text-center text-muted-foreground py-4" data-testid="notifications-loading-more">
                  Loading...
                </div>
              )}
              {hasMore && !isLoading && (
                <div className="flex justify-center pt-2">
                  <Button
                    variant="outline"
                    onClick={handleLoadMore}
                    data-testid="button-load-more"
                  >
                    Load more ({notifications.length} of {total})
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
