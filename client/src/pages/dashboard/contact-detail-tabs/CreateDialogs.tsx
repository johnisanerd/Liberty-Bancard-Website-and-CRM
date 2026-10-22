import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2 } from "lucide-react";
import type { ComponentPropsWithoutRef, Dispatch, SetStateAction } from "react";
import type { ContactCompany } from "@shared/schema";
import type { CompanySearchItem, CompanySearchState } from "@/hooks/use-company-search";
import { VERTICALS } from "@shared/schema";

type DealForm = { pipeline: string; stage: string; offerPath: string; notes: string };
type TicketForm = { subject: string; description: string; priority: string; category: string };
type TaskForm = { title: string; description: string; dueDate: string };
type NewCompanyForm = { legalName: string; dba: string; vertical: string; website: string };

interface Props {
  showDealDialog: boolean;
  setShowDealDialog: Dispatch<SetStateAction<boolean>>;
  dealForm: DealForm;
  setDealForm: Dispatch<SetStateAction<DealForm>>;
  createDeal: () => void;
  onDealCloseAutoFocus?: ComponentPropsWithoutRef<typeof DialogContent>["onCloseAutoFocus"];

  showTicketDialog: boolean;
  setShowTicketDialog: Dispatch<SetStateAction<boolean>>;
  ticketForm: TicketForm;
  setTicketForm: Dispatch<SetStateAction<TicketForm>>;
  createTicket: () => void;
  ticketSaving?:boolean;
  ticketUnconfirmed?:boolean;
  retryTicketCreation?:()=>void;
  onTicketCloseAutoFocus?: ComponentPropsWithoutRef<typeof DialogContent>["onCloseAutoFocus"];

  showTaskDialog: boolean;
  setShowTaskDialog: Dispatch<SetStateAction<boolean>>;
  taskForm: TaskForm;
  setTaskForm: Dispatch<SetStateAction<TaskForm>>;
  createTask: () => void;
  taskSaving?: boolean;
  taskSaveError?: string|null;
  onTaskCloseAutoFocus?: ComponentPropsWithoutRef<typeof DialogContent>["onCloseAutoFocus"];

  showCompanyDialog: boolean;
  setShowCompanyDialog: Dispatch<SetStateAction<boolean>>;
  companyMode: "existing" | "new";
  setCompanyMode: Dispatch<SetStateAction<"existing" | "new">>;
  companySearch: string;
  setCompanySearch: Dispatch<SetStateAction<string>>;
  selectedCompanyId: string;
  setSelectedCompanyId: Dispatch<SetStateAction<string>>;
  newCompanyForm: NewCompanyForm;
  setNewCompanyForm: Dispatch<SetStateAction<NewCompanyForm>>;
  companyRole: string;
  setCompanyRole: Dispatch<SetStateAction<string>>;
  companyIsPrimary: boolean;
  setCompanyIsPrimary: Dispatch<SetStateAction<boolean>>;
  companySearchState: CompanySearchState;
  selectedCompany: CompanySearchItem | null;
  selectCompany: (company: CompanySearchItem | null) => void;
  contactCompanies: ContactCompany[];
  addCompanyAssociation: { mutate: (v: { companyId: number; role?: string; isPrimary: boolean }) => void; isPending: boolean };
  createAndLinkCompany: { mutate: () => void; isPending: boolean };
}

export function CreateDialogs(p: Props) {
  const cs = p.companySearchState;
  return (
    <>
      {/* Create Deal Dialog */}
      <Dialog open={p.showDealDialog} onOpenChange={p.setShowDealDialog}>
        <DialogContent onCloseAutoFocus={p.onDealCloseAutoFocus} data-testid="dialog-create-deal">
          <DialogHeader>
            <DialogTitle>Create Deal</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Pipeline</label>
              <Select value={p.dealForm.pipeline} onValueChange={v => p.setDealForm(prev => ({ ...prev, pipeline: v }))}>
                <SelectTrigger data-testid="select-deal-pipeline">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sales">Sales</SelectItem>
                  <SelectItem value="onboarding">Onboarding</SelectItem>
                  <SelectItem value="retention">Retention</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Stage</label>
              <Input
                value={p.dealForm.stage}
                onChange={e => p.setDealForm(prev => ({ ...prev, stage: e.target.value }))}
                data-testid="input-deal-stage"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Offer Path</label>
              <Input
                value={p.dealForm.offerPath}
                onChange={e => p.setDealForm(prev => ({ ...prev, offerPath: e.target.value }))}
                placeholder="e.g., Cash Discount, Flat Rate"
                data-testid="input-deal-offerpath"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Notes</label>
              <Textarea
                value={p.dealForm.notes}
                onChange={e => p.setDealForm(prev => ({ ...prev, notes: e.target.value }))}
                rows={3}
                data-testid="textarea-deal-notes"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => p.setShowDealDialog(false)} data-testid="button-cancel-deal">
                Cancel
              </Button>
              <Button onClick={p.createDeal} data-testid="button-submit-deal">
                Create Deal
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Ticket Dialog */}
      <Dialog open={p.showTicketDialog} onOpenChange={p.setShowTicketDialog}>
        <DialogContent onCloseAutoFocus={p.onTicketCloseAutoFocus} data-testid="dialog-create-ticket">
          <DialogHeader>
            <DialogTitle>Create Ticket</DialogTitle>
          </DialogHeader>
          {p.ticketUnconfirmed&&<div role="alert" className="rounded-lg border p-3 text-sm">
            Local ticket intent is unconfirmed. Its original payload/version is retained; this is not a delivery receipt.
            <Button variant="outline" disabled={p.ticketSaving} onClick={p.retryTicketCreation}
              data-testid="button-retry-contact-ticket">Retry frozen intent</Button>
          </div>}
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Subject</label>
              <Input
                value={p.ticketForm.subject}
                onChange={e => p.setTicketForm(prev => ({ ...prev, subject: e.target.value }))}
                data-testid="input-ticket-subject"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <Textarea
                value={p.ticketForm.description}
                onChange={e => p.setTicketForm(prev => ({ ...prev, description: e.target.value }))}
                rows={3}
                data-testid="textarea-ticket-description"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Priority</label>
              <Select value={p.ticketForm.priority} onValueChange={v => p.setTicketForm(prev => ({ ...prev, priority: v }))}>
                <SelectTrigger data-testid="select-ticket-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Low">Low</SelectItem>
                  <SelectItem value="Normal">Normal</SelectItem>
                  <SelectItem value="High">High</SelectItem>
                  <SelectItem value="Urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => p.setShowTicketDialog(false)} data-testid="button-cancel-ticket">
                Cancel
              </Button>
              <Button onClick={p.createTicket} disabled={p.ticketSaving||p.ticketUnconfirmed||!p.ticketForm.subject || !p.ticketForm.description} data-testid="button-submit-ticket">
                {p.ticketSaving?"Saving local ticket…":"Create Ticket"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create Task Dialog */}
      <Dialog open={p.showTaskDialog} onOpenChange={p.setShowTaskDialog}>
        <DialogContent onCloseAutoFocus={p.onTaskCloseAutoFocus} data-testid="dialog-create-task">
          <DialogHeader>
            <DialogTitle>Create Task</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Title</label>
              <Input
                value={p.taskForm.title}
                onChange={e => p.setTaskForm(prev => ({ ...prev, title: e.target.value }))}
                data-testid="input-task-title"
                aria-label="Task title"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Description</label>
              <Textarea
                value={p.taskForm.description}
                onChange={e => p.setTaskForm(prev => ({ ...prev, description: e.target.value }))}
                rows={3}
                data-testid="textarea-task-description"
                aria-label="Task description"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Due date and time (device timezone)</label>
              <Input
                type="datetime-local"
                value={p.taskForm.dueDate}
                onChange={e => p.setTaskForm(prev => ({ ...prev, dueDate: e.target.value }))}
                data-testid="input-task-duedate"
                aria-label="Task due date and time in your device timezone"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => p.setShowTaskDialog(false)} data-testid="button-cancel-task">
                Cancel
              </Button>
              <Button onClick={p.createTask} disabled={!p.taskForm.title.trim() || p.taskSaving} data-testid="button-submit-task">
                {p.taskSaving?"Saving…":"Create Task"}
              </Button>
            </div>
            {p.taskSaveError&&<p role="alert" data-testid="contact-task-save-error">{p.taskSaveError}</p>}
          </div>
        </DialogContent>
      </Dialog>

      {/* Link Company Dialog */}
      <Dialog open={p.showCompanyDialog} onOpenChange={p.setShowCompanyDialog}>
        <DialogContent data-testid="dialog-link-company">
          <DialogHeader>
            <DialogTitle>Link Company</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex gap-2">
              <Button
                variant={p.companyMode === "existing" ? "default" : "outline"}
                size="sm"
                onClick={() => p.setCompanyMode("existing")}
                data-testid="button-mode-existing"
              >
                Select Existing
              </Button>
              <Button
                variant={p.companyMode === "new" ? "default" : "outline"}
                size="sm"
                onClick={() => p.setCompanyMode("new")}
                data-testid="button-mode-new"
              >
                Create New
              </Button>
            </div>

            {p.companyMode === "existing" ? (
              <div className="space-y-2">
                <label htmlFor="input-company-search" className="text-sm font-medium">Search Company</label>
                <Input
                  id="input-company-search"
                  value={p.companySearch}
                  onChange={e => p.setCompanySearch(e.target.value)}
                  placeholder="Search by name or DBA..."
                  autoComplete="off"
                  maxLength={100}
                  onKeyDown={e => {
                    if (e.key !== "ArrowDown") return;
                    const first = document.querySelector<HTMLButtonElement>('[data-testid="company-results"] button[data-company-option]');
                    if (first) { e.preventDefault(); first.focus(); }
                  }}
                  data-testid="input-company-search"
                />
                {p.selectedCompany && (
                  <p className="flex items-center justify-between gap-2 rounded-md border bg-accent/40 px-3 py-2 text-sm" data-testid="company-selected-summary">
                    <span className="min-w-0 truncate">Selected: <strong>{p.selectedCompany.legalName}</strong>{p.selectedCompany.dba ? ` (DBA: ${p.selectedCompany.dba})` : ""} <span className="text-muted-foreground">· ID {p.selectedCompany.id}</span></span>
                    <button type="button" className="shrink-0 underline" onClick={() => p.selectCompany(null)} data-testid="button-clear-company">Clear</button>
                  </p>
                )}
                <p className="text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="company-search-status">
                  {cs.status === "loading" ? "Searching authorized companies…"
                    : cs.status === "error" ? ""
                    : cs.status === "ready" ? (cs.total === 0 ? "No match" : `Showing ${cs.items.length} of ${cs.total} authorized ${cs.total === 1 ? "company" : "companies"}${cs.settledQuery ? ` matching “${cs.settledQuery}”` : ""}`)
                    : ""}
                </p>
                <div className="max-h-48 overflow-y-auto border rounded-md" data-testid="company-results"
                  onKeyDown={e => {
                    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                    const options = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-company-option]")];
                    const at = options.indexOf(document.activeElement as HTMLButtonElement);
                    if (at < 0) return;
                    e.preventDefault();
                    if (e.key === "ArrowDown") options[Math.min(at + 1, options.length - 1)]?.focus();
                    else if (at === 0) document.getElementById("input-company-search")?.focus();
                    else options[at - 1]?.focus();
                  }}>
                  {cs.status === "error" ? <p className="p-3 text-sm text-destructive" role="alert">Company search unavailable. <button type="button" className="underline" onClick={cs.retry} data-testid="button-company-search-retry">Retry</button></p> : null}
                  {cs.status === "ready" && cs.items.length === 0 ? <p className="text-sm text-muted-foreground p-3 text-center" data-testid="company-no-match">No companies found</p> : null}
                  {cs.items.map(c => (
                    <button
                      type="button"
                      key={c.id}
                      className={`flex min-h-11 w-full items-center gap-2 p-2 text-left hover-elevate ${p.selectedCompanyId === String(c.id) ? "bg-accent" : ""}`}
                      onClick={() => p.selectCompany(c)}
                      aria-pressed={p.selectedCompanyId === String(c.id)}
                      data-company-option
                      aria-label={`${c.legalName}${c.dba ? `, DBA ${c.dba}` : ""}, company ID ${c.id}`}
                      data-testid={`company-option-${c.id}`}
                    >
                      <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{c.legalName}</p>
                        {c.dba && <p className="text-xs text-muted-foreground truncate">DBA: {c.dba}</p>}
                      </div>
                    </button>
                  ))}
                  {cs.hasMore ? (
                    <div className="p-2 text-center">
                      <Button type="button" variant="outline" size="sm" onClick={cs.loadMore} disabled={cs.loadingMore} data-testid="button-company-load-more">
                        {cs.loadingMore ? "Loading…" : "Show more"}
                      </Button>
                      {cs.moreError ? <p className="pt-1 text-sm text-destructive" role="alert">Could not load more. Try again.</p> : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Legal Name *</label>
                  <Input
                    value={p.newCompanyForm.legalName}
                    onChange={e => p.setNewCompanyForm(prev => ({ ...prev, legalName: e.target.value }))}
                    placeholder="Company legal name"
                    data-testid="input-new-company-name"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">DBA</label>
                  <Input
                    value={p.newCompanyForm.dba}
                    onChange={e => p.setNewCompanyForm(prev => ({ ...prev, dba: e.target.value }))}
                    placeholder="Doing business as"
                    data-testid="input-new-company-dba"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Vertical</label>
                  <Select value={p.newCompanyForm.vertical} onValueChange={v => p.setNewCompanyForm(prev => ({ ...prev, vertical: v }))}>
                    <SelectTrigger data-testid="select-new-company-vertical">
                      <SelectValue placeholder="Select vertical" />
                    </SelectTrigger>
                    <SelectContent>
                      {VERTICALS.map((v) => (
                        <SelectItem key={v} value={v}>{v}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Website</label>
                  <Input
                    value={p.newCompanyForm.website}
                    onChange={e => p.setNewCompanyForm(prev => ({ ...prev, website: e.target.value }))}
                    placeholder="https://..."
                    data-testid="input-new-company-website"
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium">Role</label>
              <Select value={p.companyRole} onValueChange={p.setCompanyRole}>
                <SelectTrigger data-testid="select-company-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Owner">Owner</SelectItem>
                  <SelectItem value="Manager">Manager</SelectItem>
                  <SelectItem value="Employee">Employee</SelectItem>
                  <SelectItem value="Partner">Partner</SelectItem>
                  <SelectItem value="Consultant">Consultant</SelectItem>
                  <SelectItem value="Other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="company-primary"
                checked={p.companyIsPrimary}
                onChange={e => p.setCompanyIsPrimary(e.target.checked)}
                className="rounded border-input"
                data-testid="checkbox-company-primary"
              />
              <label htmlFor="company-primary" className="text-sm font-medium cursor-pointer">
                Primary Company
              </label>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => p.setShowCompanyDialog(false)} data-testid="button-cancel-company">
                Cancel
              </Button>
              {p.companyMode === "existing" ? (
                <Button
                  onClick={() => p.addCompanyAssociation.mutate({
                    companyId: Number(p.selectedCompanyId),
                    role: p.companyRole || undefined,
                    isPrimary: p.companyIsPrimary,
                  })}
                  disabled={!p.selectedCompanyId || p.addCompanyAssociation.isPending}
                  data-testid="button-submit-link-company"
                >
                  Link Company
                </Button>
              ) : (
                <Button
                  onClick={() => p.createAndLinkCompany.mutate()}
                  disabled={!p.newCompanyForm.legalName || p.createAndLinkCompany.isPending}
                  data-testid="button-submit-create-company"
                >
                  Create & Link
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
