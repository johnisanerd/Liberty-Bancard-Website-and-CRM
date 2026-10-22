import { PageTitle } from "@/components/ui/page-header";
import { useState, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCrmQuery as useQuery } from "@/hooks/use-crm-query";
import { apiRequest } from "@/lib/queryClient";
import { localCalendarDateAtTime, moveCalendarEventToDate } from "@/lib/calendar-date-repair";
import { isCalendarStartInWindow } from "@/lib/calendar-window";
import { useToast } from "@/hooks/use-toast";
import type { CalendarEvent, Deal, Contact } from "@shared/schema";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronLeft, ChevronRight, Plus, Calendar as CalendarIcon,
  Phone, Video, Clock, Users,
} from "lucide-react";

const EVENT_TYPES = ["meeting", "call", "follow-up", "demo"] as const;
type EventType = typeof EVENT_TYPES[number];

const TYPE_COLORS: Record<string, string> = {
  meeting: "bg-blue-500",
  call: "bg-green-500",
  "follow-up": "bg-amber-500",
  demo: "bg-purple-500",
};

const TYPE_BADGE_VARIANTS: Record<string, string> = {
  meeting: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  call: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  "follow-up": "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  demo: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
};

const TYPE_ICONS: Record<string, typeof CalendarIcon> = {
  meeting: Users,
  call: Phone,
  "follow-up": Clock,
  demo: Video,
};

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

const INVALID_DATE_KEY = "invalid";

function formatTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "--:--";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "Unknown time";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateKey(date: Date): string {
  if (isNaN(date.getTime())) return INVALID_DATE_KEY;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface CalendarItem {
  id: string;
  title: string;
  type: string;
  startTime: string;
  endTime: string;
  description?: string | null;
  contactId?: number | null;
  dealId?: number | null;
  source: "event" | "deal" | "appointment";
  sourceLabel?: string;
  externalUrl?: string | null;
  readOnly?: boolean;
  noShow?: boolean;
  rawId: number | string;
}

interface AppointmentRead {
  appointments: Array<{
    id: string;
    title: string;
    contactName?: string;
    contactId: number | null;
    startTime: string | number | null;
    endTime: string | number | null;
    status: string;
    noShow: boolean;
    locationName: string | null;
    ghlLink?: string | null;
    source?: string;
  }>;
  configured: boolean;
  status?: string;
  source?: string;
  completeness?: string;
  exact?: boolean;
  queueLimit?: number;
  scope?: string;
  asOf?: string;
  sourceStatus?: Array<{ source: string; status: string; fetched?: number; truncated?: boolean }>;
}

export default function CalendarPage({ embedded = false }: { embedded?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const today = new Date();
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<string>(formatDateKey(today));
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [eventForm, setEventForm] = useState({
    title: "",
    description: "",
    date: "",
    startTime: "09:00",
    endTime: "10:00",
    type: "meeting" as EventType,
    contactId: "",
    notes: "",
  });

  const startOfMonth = new Date(currentYear, currentMonth, 1);
  // The reader's upper bound is exclusive. Preserve browser-local month
  // boundaries as instants rather than slicing UTC dates (which shifts zones).
  const endOfMonth = new Date(currentYear, currentMonth + 1, 1);
  const startParam = startOfMonth.toISOString();
  const endParam = endOfMonth.toISOString();

  const { data: calendarEvents, isLoading: eventsLoading, isError: eventsError, refetch: retryEvents } = useQuery<CalendarEvent[]>({
    queryKey: ["/api/calendar-events", startParam, endParam],
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ start: startParam, end: endParam });
      const res = await fetch(`/api/calendar-events?${params}`, { credentials: "include", signal });
      if (!res.ok) throw new Error("Calendar events are unavailable.");
      return res.json();
    },
  });

  const { data: appointmentRead, isLoading: appointmentsLoading, isError: appointmentsError, refetch: retryAppointments } = useQuery<AppointmentRead>({
    queryKey: ["/api/appointments"],
    queryFn: async ({ signal }) => {
      const response = await apiRequest("GET", "/api/appointments", undefined, undefined, signal);
      return response.json();
    },
    refetchInterval: 300000,
  });
  const { data: dealsRes, isLoading: dealsLoading, isError: dealsError, refetch: retryDeals } = useQuery<{ data: Deal[]; total: number }>({
    queryKey: ["/api/deals", { calendar: true }],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/deals?limit=250&offset=0", { credentials: "include", signal });
      if (!res.ok) throw new Error("Deal follow-ups are unavailable.");
      return res.json();
    },
  });
  const allDeals = dealsRes?.data;

  const { data: contactsRes, isError: contactsError, refetch: retryContacts } = useQuery<{ data: Contact[]; total: number }>({
    queryKey: ["/api/contacts", { calendar: true }],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/contacts?limit=250&offset=0", { credentials: "include", signal });
      if (!res.ok) throw new Error("Contact names are unavailable.");
      return res.json();
    },
  });
  const contacts = contactsRes?.data;

  const contactMap = useMemo(() => {
    const m = new Map<number, string>();
    contacts?.forEach(c => m.set(c.id, `${c.firstName} ${c.lastName}`));
    return m;
  }, [contacts]);

  const createEventMutation = useMutation({
    mutationFn: async (data: any) => {
      return apiRequest("POST", "/api/calendar-events", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar-events"] });
      setShowAddDialog(false);
      setEventForm({ title: "", description: "", date: "", startTime: "09:00", endTime: "10:00", type: "meeting", contactId: "", notes: "" });
      toast({ title: "Event created" });
    },
    onError: () => {
      toast({ title: "Failed to create event", variant: "destructive" });
    },
  });

  const [fixingItemId, setFixingItemId] = useState<string | null>(null);
  const [fixDate, setFixDate] = useState<string>("");
  const [fixStartTime, setFixStartTime] = useState("09:00");
  const [fixDurationMinutes, setFixDurationMinutes] = useState("60");

  const fixEventDateMutation = useMutation({
    mutationFn: async ({ item, newDate, replacement }: {
      item: CalendarItem; newDate: string; replacement?: { startTime: string; durationMinutes: number };
    }) => {
      if (item.readOnly || item.source === "appointment") throw new Error("Provider appointments are read-only.");
      if (item.source === "event") {
        return apiRequest("PUT", `/api/calendar-events/${item.rawId}`, moveCalendarEventToDate(item, newDate, replacement));
      }
      const iso = localCalendarDateAtTime(newDate, "09:00").toISOString();
      return apiRequest("PUT", `/api/deals/${item.rawId}`, { nextFollowUp: iso });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar-events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      setFixingItemId(null);
      setFixDate("");
      toast({ title: variables.item.source === "event" ? "Event date fixed" : "Follow-up date fixed" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to fix date", description: error.message, variant: "destructive" });
    },
  });

  const removeInvalidDateMutation = useMutation({
    mutationFn: async (item: CalendarItem) => {
      if (item.readOnly || item.source === "appointment") throw new Error("Provider appointments are read-only.");
      if (item.source === "event") {
        return apiRequest("DELETE", `/api/calendar-events/${item.rawId}`);
      }
      return apiRequest("PUT", `/api/deals/${item.rawId}`, { nextFollowUp: null });
    },
    onSuccess: (_data, item) => {
      queryClient.invalidateQueries({ queryKey: ["/api/calendar-events"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: item.source === "event" ? "Event removed" : "Follow-up cleared" });
    },
    onError: () => {
      toast({ title: "Failed to remove event", variant: "destructive" });
    },
  });

  const calendarItems = useMemo(() => {
    const items: CalendarItem[] = [];

    calendarEvents?.forEach(evt => {
      items.push({
        id: `event_${evt.id}`,
        title: evt.title,
        type: evt.type || "meeting",
        startTime: evt.startTime as unknown as string,
        endTime: evt.endTime as unknown as string,
        description: evt.description,
        contactId: evt.contactId,
        dealId: evt.dealId,
        source: "event",
        rawId: evt.id,
      });
    });

    (appointmentRead?.appointments ?? []).forEach(appt => {
      const dateValue = appt.startTime;
      const startDate = new Date(typeof dateValue === "number" ? dateValue : dateValue ?? "");
      if (Number.isFinite(startDate.getTime()) && !isCalendarStartInWindow(startDate, startOfMonth, endOfMonth)) return;
      items.push({
        id: `appointment_${appt.id}`,
        title: appt.title || appt.contactName || "Appointment",
        type: "meeting",
        startTime: typeof appt.startTime === "number" ? new Date(appt.startTime).toISOString() : appt.startTime ?? "",
        endTime: typeof appt.endTime === "number" ? new Date(appt.endTime).toISOString() : appt.endTime ?? "",
        contactId: appt.contactId,
        description: [
          appt.status ? `Appointment status: ${appt.status}` : "",
          appt.locationName || "",
        ].filter(Boolean).join(" · ") || undefined,
        source: "appointment",
        sourceLabel: `GHL · ${appt.source || "appointment"}`,
        externalUrl: appt.ghlLink,
        readOnly: true,
        noShow: appt.noShow,
        rawId: appt.id,
      });
    });

    allDeals?.forEach(deal => {
      if (deal.nextFollowUp) {
        const followUpDate = new Date(deal.nextFollowUp);
        const isInRange = isCalendarStartInWindow(followUpDate, startOfMonth, endOfMonth);
        // Invalid dates can't be range-checked — surface them regardless of month so they aren't silently dropped.
        if (isInRange || isNaN(followUpDate.getTime())) {
          items.push({
            id: `deal_followup_${deal.id}`,
            title: `Follow-up: Deal #${deal.id}`,
            type: "follow-up",
            startTime: deal.nextFollowUp as unknown as string,
            endTime: deal.nextFollowUp as unknown as string,
            contactId: deal.contactId,
            dealId: deal.id,
            source: "deal",
            rawId: deal.id,
          });
        }
      }
    });

    return items;
  }, [calendarEvents, appointmentRead, allDeals, startOfMonth, endOfMonth]);

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    calendarItems.forEach(item => {
      const key = formatDateKey(new Date(item.startTime));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    });
    return map;
  }, [calendarItems]);

  const invalidDateEvents = eventsByDate.get(INVALID_DATE_KEY) || [];

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth);

  const prevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(currentYear - 1);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  const nextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(currentYear + 1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  };

  const handleSubmitEvent = () => {
    if (!eventForm.title || !eventForm.date) return;
    const startDateTime = new Date(`${eventForm.date}T${eventForm.startTime}:00`);
    const endDateTime = new Date(`${eventForm.date}T${eventForm.endTime}:00`);

    createEventMutation.mutate({
      title: eventForm.title,
      description: eventForm.notes || undefined,
      startTime: startDateTime.toISOString(),
      endTime: endDateTime.toISOString(),
      type: eventForm.type,
      contactId: eventForm.contactId ? Number(eventForm.contactId) : undefined,
    });
  };

  const selectedDayEvents = eventsByDate.get(selectedDate) || [];
  const todayKey = formatDateKey(today);
  const dealsPartial = Boolean(dealsRes && dealsRes.data.length < dealsRes.total);
  const appointmentPartial = Boolean(appointmentRead && (
    (typeof appointmentRead.exact !== "boolean" && !appointmentRead.completeness) ||
    appointmentRead.exact === false ||
    Boolean(appointmentRead.completeness && !["complete", "all_sources_exhausted"].includes(appointmentRead.completeness)) ||
    Boolean(appointmentRead.status && ["failed", "error", "unavailable", "partial"].includes(appointmentRead.status.toLowerCase())) ||
    appointmentRead.sourceStatus?.some(source => source.status === "failed" || source.truncated)
  ));

  const calendarCells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) calendarCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) calendarCells.push(d);

  if (eventsLoading || appointmentsLoading || dealsLoading) {
    return (
      <div className={embedded ? "space-y-4" : "space-y-4 p-4 md:p-6"} data-testid="calendar-loading">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className={embedded ? "space-y-6" : "space-y-6 p-4 md:p-6 max-w-6xl mx-auto"} data-testid="calendar-page">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <CalendarIcon className="h-6 w-6 text-muted-foreground" />
          {embedded ? <h2 className="text-lg font-semibold" data-testid="text-calendar-title">Calendar</h2> : <PageTitle className="text-2xl font-bold" data-testid="text-calendar-title">Calendar</PageTitle>}
        </div>
        <Button onClick={() => { setEventForm(f => ({ ...f, date: selectedDate })); setShowAddDialog(true); }} data-testid="button-add-event">
          <Plus className="h-4 w-4 mr-1" /> Add Event
        </Button>
      </div>

      {(eventsError || appointmentsError || dealsError || contactsError || dealsPartial || appointmentPartial || appointmentRead?.configured === false) && (
        <Card className="border-amber-300 bg-amber-50/60 dark:bg-amber-950/20" role="status" data-testid="calendar-source-status">
          <CardContent className="space-y-2 p-4 text-sm">
            <p className="font-medium">Calendar source coverage</p>
            {eventsError && <p className="flex flex-wrap items-center gap-2">Internal events could not be read.
              <Button size="sm" variant="outline" onClick={() => void retryEvents()}>Retry</Button></p>}
            {appointmentsError && <p className="flex flex-wrap items-center gap-2">Appointment provider read failed; appointments are not assumed absent.
              <Button size="sm" variant="outline" onClick={() => void retryAppointments()}>Retry</Button></p>}
            {dealsError && <p className="flex flex-wrap items-center gap-2">Deal follow-up dates could not be read.
              <Button size="sm" variant="outline" onClick={() => void retryDeals()}>Retry</Button></p>}
            {contactsError && <p className="flex flex-wrap items-center gap-2">Contact names are unavailable; IDs are retained.
              <Button size="sm" variant="outline" onClick={() => void retryContacts()}>Retry</Button></p>}
            {dealsPartial && <p>Deal follow-ups are a partial window ({dealsRes?.data.length} of {dealsRes?.total} reported).</p>}
            {appointmentRead?.configured === false && <p>Appointment calendar is not configured.</p>}
            {appointmentPartial && <p>Appointment list is bounded or incomplete{appointmentRead?.queueLimit ? ` (queue limit ${appointmentRead.queueLimit})` : ""}; an empty result is not definitive.</p>}
            {appointmentRead && <p className="text-xs text-muted-foreground">
              {appointmentRead.source || appointmentRead.scope || "Appointment source"}
              {appointmentRead.status ? ` · ${appointmentRead.status}` : ""}
              {appointmentRead.asOf ? ` · read ${new Date(appointmentRead.asOf).toLocaleString()}` : ""}
            </p>}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card data-testid="calendar-grid-card">
            <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
              <Button variant="outline" size="icon" aria-label="Previous month" onClick={prevMonth} data-testid="button-prev-month">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <CardTitle className="text-lg" data-testid="text-current-month">
                {MONTH_NAMES[currentMonth]} {currentYear}
              </CardTitle>
              <Button variant="outline" size="icon" aria-label="Next month" onClick={nextMonth} data-testid="button-next-month">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-7 gap-px" data-testid="calendar-grid">
                {DAY_NAMES.map(day => (
                  <div key={day} className="text-center text-xs font-medium text-muted-foreground py-2" data-testid={`calendar-day-header-${day}`}>
                    {day}
                  </div>
                ))}
                {calendarCells.map((day, idx) => {
                  if (day === null) {
                    return <div key={`empty-${idx}`} className="min-h-[4.5rem] p-1" />;
                  }
                  const dateKey = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                  const dayEvents = eventsByDate.get(dateKey) || [];
                  const isToday = dateKey === todayKey;
                  const isSelected = dateKey === selectedDate;

                  return (
                    <button
                      key={dateKey}
                      onClick={() => setSelectedDate(dateKey)}
                      className={`min-h-[4.5rem] p-1 rounded-md text-left transition-colors ${
                        isSelected
                          ? "ring-2 ring-primary bg-primary/5"
                          : "hover-elevate"
                      }`}
                      data-testid={`calendar-day-${dateKey}`}
                    >
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                          isToday ? "bg-primary text-primary-foreground" : ""
                        }`}
                        data-testid={`text-day-number-${day}`}
                      >
                        {day}
                      </span>
                      <div className="flex flex-wrap gap-0.5 mt-0.5">
                        {dayEvents.slice(0, 3).map(evt => (
                          <span
                            key={evt.id}
                            className={`h-1.5 w-1.5 rounded-full ${TYPE_COLORS[evt.type] || "bg-muted-foreground"}`}
                            data-testid={`dot-event-${evt.id}`}
                          />
                        ))}
                        {dayEvents.length > 3 && (
                          <span className="text-[10px] text-muted-foreground" data-testid={`text-more-events-${dateKey}`}>
                            +{dayEvents.length - 3}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {invalidDateEvents.length > 0 && (
            <Card className="mt-4 border-amber-300" data-testid="card-invalid-date-events">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-amber-700 dark:text-amber-400" data-testid="text-invalid-date-warning">
                  {invalidDateEvents.length} event{invalidDateEvents.length === 1 ? "" : "s"} with an unrecognized date could not be placed on the calendar
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {invalidDateEvents.map(evt => (
                    <div key={evt.id} className="text-sm space-y-2 border-b last:border-b-0 pb-2 last:pb-0" data-testid={`row-invalid-date-event-${evt.id}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{evt.title}</span>
                        <span className="text-xs text-muted-foreground shrink-0">Invalid date</span>
                      </div>
                      {evt.readOnly ? (
                        <p className="text-xs text-muted-foreground">Provider appointment · read-only</p>
                      ) : fixingItemId === evt.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Input
                            type="date"
                            value={fixDate}
                            onChange={e => setFixDate(e.target.value)}
                            className="h-8 text-xs"
                            data-testid={`input-fix-date-${evt.id}`}
                          />
                          {evt.source === "event" && (
                            <>
                              <label className="text-xs">
                                Replacement start
                                <Input type="time" value={fixStartTime} onChange={e => setFixStartTime(e.target.value)}
                                  className="h-8 text-xs" data-testid={`input-fix-start-${evt.id}`} />
                              </label>
                              <label className="text-xs">
                                Duration (minutes)
                                <Input type="number" min={1} max={10080} step={1} value={fixDurationMinutes}
                                  onChange={e => setFixDurationMinutes(e.target.value)}
                                  className="h-8 text-xs" data-testid={`input-fix-duration-${evt.id}`} />
                              </label>
                              <p className="w-full text-xs text-muted-foreground">
                                Valid original times and duration are preserved. These replacements apply only to invalid times.
                              </p>
                            </>
                          )}
                          <Button
                            size="sm"
                            className="h-8 px-2 text-xs"
                            disabled={!fixDate || fixEventDateMutation.isPending}
                            onClick={() => fixEventDateMutation.mutate({ item: evt, newDate: fixDate,
                              replacement: { startTime: fixStartTime, durationMinutes: Number(fixDurationMinutes) } })}
                            data-testid={`button-save-fix-${evt.id}`}
                          >
                            Save
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2 text-xs"
                            onClick={() => { setFixingItemId(null); setFixDate(""); }}
                            data-testid={`button-cancel-fix-${evt.id}`}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            onClick={() => { setFixingItemId(evt.id); setFixDate(formatDateKey(today));
                              setFixStartTime("09:00"); setFixDurationMinutes("60"); }}
                            data-testid={`button-edit-invalid-date-${evt.id}`}
                          >
                            Fix Date
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                            disabled={removeInvalidDateMutation.isPending}
                            onClick={() => removeInvalidDateMutation.mutate(evt)}
                            data-testid={`button-delete-invalid-date-${evt.id}`}
                          >
                            {evt.source === "event" ? "Delete" : "Clear Follow-Up"}
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card data-testid="selected-day-events">
            <CardHeader className="pb-2">
              <CardTitle className="text-base" data-testid="text-selected-date">
                {new Date(selectedDate + "T00:00:00").toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {selectedDayEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4" data-testid="text-no-events">
                  {eventsError || appointmentsError || dealsError
                    ? "Some calendar sources could not be read; no-empty results are not assumed."
                    : appointmentRead?.configured === false
                    ? "No internal events are scheduled. Appointment calendar is not configured."
                    : appointmentPartial || dealsPartial
                    ? "No events found in the available source windows; coverage is partial."
                    : "No events scheduled"}
                </p>
              ) : (
                <div className="space-y-3">
                  {selectedDayEvents.map(evt => {
                    const Icon = TYPE_ICONS[evt.type] || CalendarIcon;
                    return (
                      <div
                        key={evt.id}
                        className="flex items-start gap-3 p-2 rounded-md border"
                        data-testid={`event-item-${evt.id}`}
                      >
                        <div className={`mt-0.5 p-1.5 rounded-md ${TYPE_BADGE_VARIANTS[evt.type] || ""}`}>
                          <Icon className="h-3.5 w-3.5" />
                        </div>
                        <div className="flex-1 min-w-0 space-y-0.5">
                          <p className="text-sm font-medium truncate" data-testid={`text-event-title-${evt.id}`}>
                            {evt.title}
                          </p>
                          <p className="text-xs text-muted-foreground" data-testid={`text-event-time-${evt.id}`}>
                            {formatTime(evt.startTime)} - {formatTime(evt.endTime)}
                          </p>
                          {evt.contactId && contactMap.get(evt.contactId) && (
                            <p className="text-xs text-muted-foreground" data-testid={`text-event-contact-${evt.id}`}>
                              {contactMap.get(evt.contactId!)}
                            </p>
                          )}
                          {evt.description && (
                            <p className="text-xs text-muted-foreground truncate" data-testid={`text-event-desc-${evt.id}`}>
                              {evt.description}
                            </p>
                          )}
                          {evt.contactId && !contactMap.has(evt.contactId) && (
                            <p className="text-xs text-muted-foreground">
                              Contact #{evt.contactId}{contactsError ? " · name lookup failed" : ""}
                            </p>
                          )}
                          <Badge variant="secondary" className={`text-[10px] ${TYPE_BADGE_VARIANTS[evt.type] || ""}`} data-testid={`badge-event-type-${evt.id}`}>
                            {evt.type}
                          </Badge>
                          <Badge variant="outline" className="ml-1 text-[10px]">{evt.sourceLabel || evt.source}</Badge>
                          {evt.noShow && <Badge variant="destructive" className="ml-1 text-[10px]">No-show</Badge>}
                          {evt.externalUrl && <a href={evt.externalUrl} target="_blank" rel="noopener noreferrer"
                            className="ml-2 inline-flex items-center text-xs text-primary underline">Open appointment</a>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card data-testid="event-type-legend">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Legend</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {EVENT_TYPES.map(type => (
                  <div key={type} className="flex items-center gap-2 text-sm" data-testid={`legend-${type}`}>
                    <span className={`h-2.5 w-2.5 rounded-full ${TYPE_COLORS[type]}`} />
                    <span className="capitalize">{type}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent data-testid="dialog-add-event">
          <DialogHeader>
            <DialogTitle>Add Event</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Title</label>
              <Input
                value={eventForm.title}
                onChange={e => setEventForm(f => ({ ...f, title: e.target.value }))}
                placeholder="Event title"
                data-testid="input-event-title"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Date</label>
              <Input
                type="date"
                value={eventForm.date}
                onChange={e => setEventForm(f => ({ ...f, date: e.target.value }))}
                data-testid="input-event-date"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Start Time</label>
                <Input
                  type="time"
                  value={eventForm.startTime}
                  onChange={e => setEventForm(f => ({ ...f, startTime: e.target.value }))}
                  data-testid="input-event-start-time"
                />
              </div>
              <div>
                <label className="text-sm font-medium">End Time</label>
                <Input
                  type="time"
                  value={eventForm.endTime}
                  onChange={e => setEventForm(f => ({ ...f, endTime: e.target.value }))}
                  data-testid="input-event-end-time"
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">Type</label>
              <Select value={eventForm.type} onValueChange={v => setEventForm(f => ({ ...f, type: v as EventType }))}>
                <SelectTrigger data-testid="select-event-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map(t => (
                    <SelectItem key={t} value={t} data-testid={`option-event-type-${t}`}>
                      <span className="capitalize">{t}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Contact (optional)</label>
              <Select value={eventForm.contactId} onValueChange={v => setEventForm(f => ({ ...f, contactId: v }))}>
                <SelectTrigger data-testid="select-event-contact">
                  <SelectValue placeholder="Select contact..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" data-testid="option-contact-none">No contact</SelectItem>
                  {contacts?.slice(0, 50).map(c => (
                    <SelectItem key={c.id} value={String(c.id)} data-testid={`option-contact-${c.id}`}>
                      {c.firstName} {c.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Notes</label>
              <Textarea
                value={eventForm.notes}
                onChange={e => setEventForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Add notes..."
                className="resize-none"
                data-testid="input-event-notes"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowAddDialog(false)} data-testid="button-cancel-event">
                Cancel
              </Button>
              <Button
                onClick={handleSubmitEvent}
                disabled={!eventForm.title || !eventForm.date || createEventMutation.isPending}
                data-testid="button-submit-event"
              >
                {createEventMutation.isPending ? "Creating..." : "Create Event"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
