import type { ReactNode, HTMLAttributes } from "react";
import { Link } from "wouter";
import DashboardErrorState from "@/components/DashboardErrorState";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useEmployeeCrm } from "@/components/crm/employee-crm-context";
import { cn } from "@/lib/utils";
import {useIsMobile} from "@/hooks/use-mobile";

export interface CrmPageHeaderProps {
  title: string;
  headingLevel?: 1 | 2;
  description?: ReactNode;
  context?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
}

export function CrmPageHeader({ title, headingLevel = 1, description, context, primaryAction, secondaryActions }: CrmPageHeaderProps) {
  const Heading = headingLevel === 2 ? "h2" : "h1";
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {context && <div className="mb-2 text-xs text-muted-foreground">{context}</div>}
        <Heading>{title}</Heading>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {(primaryAction || secondaryActions) && (
        <div className="flex flex-wrap items-center gap-2">{secondaryActions}{primaryAction}</div>
      )}
    </header>
  );
}

export interface RecordHeaderProps {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

export function RecordHeader({ children, className, ...props }: RecordHeaderProps) {
  return <header className={cn("min-w-0", className)} {...props}>{children}</header>;
}

export function CrmFilterPanel({open,onOpenChange,children,title="People filters",description="Filters update this authorized worklist and reset its page."}:{
  open:boolean;onOpenChange:(open:boolean)=>void;children:ReactNode;title?:string;description?:string;
}){
  const mobile=useIsMobile();
  if(mobile)return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent className="overflow-y-auto">
      <SheetHeader><SheetTitle>{title}</SheetTitle>
        <SheetDescription>{description}</SheetDescription></SheetHeader>
      <div className="mt-4">{children}</div>
    </SheetContent>
  </Sheet>;
  return open?<>{children}</>:null;
}

export function CrmDataState({
  state,
  message,
  onRetry,
  children,
}: {
  state: "loading" | "empty" | "no-match" | "denied" | "unavailable" | "degraded" | "stale" | "pending" | "conflict" | "success";
  message?: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  if (state === "unavailable" || state === "conflict") {
    return <DashboardErrorState title={state === "conflict" ? "This record changed" : "Information unavailable"} message={message} onRetry={onRetry} />;
  }
  if (state === "denied") return <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground" data-crm-state={state} role="status">{message ?? "You do not have access to this information."}</div>;
  if (state === "empty" || state === "no-match") return <div className="crm-state-panel" data-crm-state={state} role="status"><span className="crm-state-kicker">{state === "empty" ? "Nothing recorded" : "No match"}</span><p>{message ?? (state === "empty" ? "There is no information in this section yet." : "Try a different search or clear a filter.")}</p></div>;
  if (children) return (
    <div data-crm-state={state}>
      {["loading", "degraded", "stale", "pending"].includes(state) && (
        <p className="mb-3 text-sm text-muted-foreground" role="status">
          {message ?? (state === "stale" ? "Showing last available information." : state === "degraded" ? "Some information could not be refreshed." : state === "pending" ? "Working…" : "Loading…")}
        </p>
      )}
      {children}
    </div>
  );
  const fallback: Record<string, string> = {
    loading: "Loading…", empty: "Nothing here yet.", "no-match": "No results match this view.",
    denied: "You do not have access to this information.", unavailable: "Information unavailable.",
    degraded: "Some information could not be refreshed.", stale: "Showing the last available information.",
    pending: "Working…", conflict: "This record changed.", success: "Up to date.",
  };
  return <div className="crm-state-panel" data-crm-state={state} role="status"><span className="crm-state-kicker">{state === "success" ? "Current" : state === "pending" ? "In progress" : "Workspace status"}</span><p>{message ?? fallback[state]}</p></div>;
}

export function CrmPage({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const employeeCrm = useEmployeeCrm();
  return <div {...props} className={cn(employeeCrm && "crm-theme crm-page", className)}>{children}</div>;
}

export function ScopedMetricStrip({ children, className, scopeId, asOf, sourceLabel, availability = "available" }: {
  children: ReactNode;
  className?: string;
  scopeId?: string;
  asOf?: string;
  sourceLabel?: string;
  availability?: "available" | "unknown" | "partial" | "stale";
}) {
  return (
    <section className={cn("crm-metric-rail grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5", className)}
      data-scope-id={scopeId} data-availability={availability} aria-label="Summary metrics">
      {children}
      {(sourceLabel || asOf || availability !== "available") && (
        <p className="col-span-full text-xs text-muted-foreground" role="note">
          {sourceLabel}{sourceLabel && asOf ? " · " : ""}{asOf ? `As of ${asOf}` : ""}
          {availability !== "available" ? ` · ${availability === "unknown" ? "Unavailable" : availability === "stale" ? "Showing last available values" : "Partial data"}` : ""}
        </p>
      )}
    </section>
  );
}

export function CrmAreaNav({ entries, current, className }: {
  entries: Array<{ label: string; href: string; allowed: boolean; reason?: string }>;
  current: string;
  className?: string;
}) {
  return (
    <nav aria-label="CRM areas" className={cn("flex flex-wrap gap-2", className)}>
      {entries.map((entry) => entry.allowed ? (
        <Link key={entry.href} href={entry.href} aria-current={current === entry.href ? "page" : undefined}
          className={cn("inline-flex min-h-11 items-center rounded-md px-4 text-sm", current === entry.href ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted")}>
          {entry.label}
        </Link>
      ) : (
        <span key={entry.href} aria-disabled="true" title={entry.reason} className="inline-flex min-h-11 items-center rounded-md px-4 text-sm text-muted-foreground">
          {entry.label}
        </span>
      ))}
    </nav>
  );
}

export function WorklistToolbar({ query, onQueryChange, onReset, filters, primaryAction, className }: {
  query: string;
  onQueryChange: (value: string) => void;
  onReset: () => void;
  filters?: ReactNode;
  primaryAction?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2", className)}>
      <label className="sr-only" htmlFor="crm-worklist-search">Search records</label>
      <input id="crm-worklist-search" type="search" value={query} onChange={(event) => onQueryChange(event.currentTarget.value)}
        placeholder="Search records" className="min-h-11 w-full rounded-md border bg-background px-3 text-sm sm:min-w-[240px] sm:flex-1" />
      {filters}
      <button type="button" onClick={onReset} className="min-h-11 rounded-md border px-3 text-sm">Reset filters</button>
      {primaryAction}
    </div>
  );
}

export interface CrmDataColumn<Row> {
  id: string;
  label: string;
  render: (row: Row) => ReactNode;
  sortable?: boolean;
  headerClassName?: string;
  cellClassName?: string;
}

export function CrmDataTable<Row extends { id: string | number }>({
  rows, columns, selectedIds = [], onSelectionChange, mobileCard, className, availability = "available",
  page, pageSize, total, totalAvailability = "unknown", hasPrevious, hasNext, onPageChange,
   sortedColumn, sortDirection, onSortChange, cursor, containerResponsive=false, onRowClick, testId,
}: {
  rows: Row[];
  columns: Array<CrmDataColumn<Row>>;
  selectedIds?: Array<string | number>;
  onSelectionChange?: (ids: Array<string | number>) => void;
  mobileCard?: (row: Row) => ReactNode;
  className?: string;
  availability?: "available" | "unknown" | "partial";
  page?: number;
  pageSize?: 25 | 50 | 100;
  total?: number;
  totalAvailability?: "known" | "unknown";
  hasPrevious?: boolean;
  hasNext?: boolean;
  onPageChange?: (page: number) => void;
  sortedColumn?: string;
  sortDirection?: "asc" | "desc";
  onSortChange?: (columnId: string, direction: "asc" | "desc") => void;
  cursor?: string | null;
   containerResponsive?: boolean;
   onRowClick?: (row:Row)=>void;
   testId?: string;
}) {
  const toggle = (id: string | number) => {
    if (!onSelectionChange) return;
    onSelectionChange(selectedIds.includes(id) ? selectedIds.filter((value) => value !== id) : [...selectedIds, id]);
  };
  return (
    <div className={cn("max-h-[min(640px,70dvh)] overflow-auto rounded-lg border", className)} data-availability={availability}
      data-page={page} data-page-size={pageSize} data-total-availability={totalAvailability} data-cursor={cursor ?? undefined}>
      <div className={mobileCard ? containerResponsive ? "crm-worklist-table" : "hidden md:block" : undefined}
        data-testid={testId ? `${testId}-desktop` : undefined}>
      <table className="w-full border-collapse text-left text-sm crm-data-table">
        <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
          <tr>{onSelectionChange && <th className="h-11 w-11 px-3" scope="col"><span className="sr-only">Select row</span></th>}
          {columns.map((column) => <th key={column.id} scope="col" className={cn("h-10 px-3 font-medium", column.headerClassName)}>
            {column.sortable && onSortChange ? (
              <button type="button" onClick={() => onSortChange(column.id, sortedColumn === column.id && sortDirection === "asc" ? "desc" : "asc")}
                className="min-h-11 text-left font-medium" aria-label={`Sort by ${column.label}${sortedColumn === column.id ? `, currently ${sortDirection ?? "ascending"}` : ""}`}>
                {column.label}{sortedColumn === column.id ? (sortDirection === "desc" ? " ↓" : " ↑") : ""}
              </button>
            ) : column.label}
          </th>)}
          </tr>
        </thead>
        <tbody>{rows.map((row) => (
          <tr key={row.id} className={cn("border-t align-middle",onRowClick&&"cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2")}
            data-testid={testId ? `${testId}-row-${row.id}` : undefined}
            tabIndex={onRowClick ? 0 : undefined} onClick={onRowClick ? ()=>onRowClick(row) : undefined}
            onKeyDown={onRowClick ? event=>{if(event.target===event.currentTarget&&(event.key==="Enter"||event.key===" ")){
              event.preventDefault();onRowClick(row);
            }} : undefined}>
            {onSelectionChange && <td className="h-11 px-3" onClick={event=>event.stopPropagation()}><input type="checkbox" aria-label={`Select row ${row.id}`} checked={selectedIds.includes(row.id)} onChange={() => toggle(row.id)} /></td>}
            {columns.map((column) => <td key={column.id} className={cn("min-h-11 px-3 py-2",column.cellClassName)}>{column.render(row)}</td>)}
          </tr>
        ))}</tbody>
      </table>
      </div>
      {mobileCard && <div className={cn("space-y-3 p-3",containerResponsive ? "crm-worklist-cards" : "md:hidden")}
        data-testid={testId ? `${testId}-mobile` : undefined}>{rows.map((row) => (
        <div key={row.id} className="flex items-start gap-2"
          data-testid={testId ? `${testId}-card-${row.id}` : undefined}
          tabIndex={onRowClick ? 0 : undefined} onClick={onRowClick ? ()=>onRowClick(row) : undefined}
          onKeyDown={onRowClick ? event=>{if(event.target===event.currentTarget&&(event.key==="Enter"||event.key===" ")){
            event.preventDefault();onRowClick(row);
          }} : undefined}>
          {onSelectionChange && <input type="checkbox" aria-label={`Select row ${row.id}`} checked={selectedIds.includes(row.id)} onClick={event=>event.stopPropagation()} onChange={() => toggle(row.id)} />}
          <div className="min-w-0 flex-1">{mobileCard(row)}</div>
        </div>
      ))}</div>}
      {availability !== "available" && <p className="border-t px-3 py-2 text-xs text-muted-foreground" role="status">{availability === "unknown" ? "Some row information is unavailable." : "Some results may be incomplete."}</p>}
      {onPageChange && page !== undefined && (
        <nav className="flex min-h-11 items-center justify-between border-t px-3 py-2 text-xs" aria-label="Record pages">
          <span>{totalAvailability === "known" && total !== undefined ? `${total} records` : "Record total unavailable"}</span>
          <div className="flex gap-2">
            <button type="button" disabled={hasPrevious === false || page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}
              className="min-h-11 rounded-md border px-3 disabled:opacity-50">Previous</button>
            <span className="flex items-center px-2">Page {page}</span>
            <button type="button" disabled={hasNext === false} onClick={() => onPageChange(page + 1)}
              className="min-h-11 rounded-md border px-3 disabled:opacity-50">Next</button>
          </div>
        </nav>
      )}
    </div>
  );
}

export function CrmActionMenu({ actions, label = "Record actions" }: {
  actions: Array<{ label: string; onSelect: () => void; allowed: boolean; reason?: string; pending?: boolean; confirmation?: string }>;
  label?: string;
}) {
  return <div role="group" aria-label={label} className="flex flex-wrap gap-2">
    {actions.map((action) => <button key={action.label} type="button" disabled={!action.allowed || action.pending} title={!action.allowed ? action.reason : undefined}
      onClick={() => {
        if (action.confirmation && !window.confirm(action.confirmation)) return;
        action.onSelect();
      }} className="min-h-11 rounded-md border px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50">
      {action.pending ? "Working…" : action.label}
    </button>)}
  </div>;
}

export function IntegrationStatus({ configured, enabled, executionState, lastSuccess, freshness, reason }: {
  configured: boolean;
  enabled: boolean;
  executionState: string;
  lastSuccess?: string | null;
  freshness?: string;
  reason?: string;
}) {
  return <section className="rounded-lg border p-4" aria-label="Integration status">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-sm">Integration</strong>
      <span className="rounded-full border px-2 py-1 text-xs">{configured ? "Configured" : "Not configured"}</span>
      <span className="rounded-full border px-2 py-1 text-xs">{enabled ? "Enabled" : "Disabled"}</span>
      <span className="rounded-full border px-2 py-1 text-xs">{executionState}</span>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">
      {lastSuccess ? `Last successful run: ${lastSuccess}` : "No successful run recorded"}
      {freshness ? ` · ${freshness}` : ""}{reason ? ` · ${reason}` : ""}
    </p>
  </section>;
}

export function CrmDetailDrawer({ open, onOpenChange, title, description, children, dirty = false }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  dirty?: boolean;
}) {
  const requestOpenChange = (next: boolean) => {
    if (!next && dirty && !window.confirm("Discard unsaved changes?")) return;
    onOpenChange(next);
  };
  return (
    <Sheet open={open} onOpenChange={requestOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-y-auto p-0 sm:max-w-[480px] max-sm:inset-0 max-sm:h-[100dvh] max-sm:w-full max-sm:max-w-none max-sm:translate-x-0">
        <SheetHeader className="border-b p-4 pr-16 text-left">
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="min-h-0 flex-1 p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
