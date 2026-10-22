import { PageTitle } from "@/components/ui/page-header";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import type { PartnerOrganization, PartnerOrgUser } from "@shared/schema";
import {
  Plus, Building2, Users, DollarSign, ExternalLink, Copy,
  Edit, Trash2, UserPlus, CheckCircle, XCircle, Globe,
} from "lucide-react";

const orgFormSchema = z.object({
  name: z.string().min(1, "Organization name is required"),
  slug: z.string().min(1, "URL slug is required").regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, and hyphens only"),
  logoUrl: z.string().url("Must be a valid URL").optional().or(z.literal("")),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a valid hex color").default("#2563eb"),
  tagline: z.string().optional(),
  commissionRate: z.coerce.number().min(0).max(100).default(10),
  contactName: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  notes: z.string().optional(),
  status: z.string().default("active"),
});

const userFormSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().optional(),
  email: z.string().email("Valid email required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  role: z.string().default("member"),
});

type OrgFormData = z.infer<typeof orgFormSchema>;
type UserFormData = z.infer<typeof userFormSchema>;

interface OrgPerformance extends PartnerOrganization {
  dealCount: number;
  closedDealCount: number;
  leadCount: number;
  totalCommissionEarned: number;
}

function KpiCard({ icon: Icon, label, value, color = "text-primary" }: {
  icon: typeof Users; label: string; value: string | number; color?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className={`w-4 h-4 ${color}`} />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-xl font-bold">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OrgUserManager({ org }: { org: PartnerOrganization }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);

  const { data: users = [], isLoading } = useQuery<PartnerOrgUser[]>({
    queryKey: ["/api/partner-orgs", org.id, "users"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/partner-orgs/${org.id}/users`);
      return res.json();
    },
    enabled: open,
  });

  const form = useForm<UserFormData>({
    resolver: zodResolver(userFormSchema),
    defaultValues: { firstName: "", lastName: "", email: "", password: "", role: "member" },
  });

  const inviteUser = useMutation({
    mutationFn: async (data: UserFormData) => {
      const res = await apiRequest("POST", `/api/partner-orgs/${org.id}/users`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/partner-orgs", org.id, "users"] });
      toast({ title: "User invited successfully" });
      form.reset();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleUser = useMutation({
    mutationFn: async ({ userId, status }: { userId: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/partner-orgs/${org.id}/users/${userId}`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/partner-orgs", org.id, "users"] });
      toast({ title: "User updated" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1" data-testid={`button-manage-users-${org.id}`}>
          <Users className="w-3.5 h-3.5" /> Users
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage Users — {org.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div>
            <h4 className="text-sm font-semibold mb-3">Invite New User</h4>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(d => inviteUser.mutate(d))} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <FormField control={form.control} name="firstName" render={({ field }) => (
                    <FormItem>
                      <FormLabel>First Name</FormLabel>
                      <FormControl><Input {...field} data-testid="input-user-first-name" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="lastName" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last Name</FormLabel>
                      <FormControl><Input {...field} data-testid="input-user-last-name" /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                </div>
                <FormField control={form.control} name="email" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl><Input {...field} type="email" data-testid="input-user-email" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="password" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl><Input {...field} type="password" placeholder="Min 6 characters" data-testid="input-user-password" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <Button type="submit" disabled={inviteUser.isPending} className="w-full gap-2" data-testid="button-invite-user">
                  <UserPlus className="w-4 h-4" />
                  {inviteUser.isPending ? "Inviting..." : "Invite User"}
                </Button>
              </form>
            </Form>
          </div>

          <div>
            <h4 className="text-sm font-semibold mb-3">Existing Users ({users.length})</h4>
            {isLoading ? (
              <Skeleton className="h-16 w-full" />
            ) : users.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No users yet.</p>
            ) : (
              <div className="space-y-2">
                {users.map((u) => (
                  <div key={u.id} className="flex items-center justify-between rounded-lg border p-3" data-testid={`row-user-${u.id}`}>
                    <div>
                      <p className="text-sm font-medium">{u.firstName} {u.lastName}</p>
                      <p className="text-xs text-muted-foreground">{u.email} · {u.role}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={u.status === "active" ? "default" : "secondary"} className="text-xs">
                        {u.status}
                      </Badge>
                      {u.status === "active" ? (
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 px-2 text-red-600"
                          onClick={() => toggleUser.mutate({ userId: u.id, status: "inactive" })}
                          data-testid={`button-deactivate-user-${u.id}`}
                        >
                          <XCircle className="w-4 h-4" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 px-2 text-green-600"
                          onClick={() => toggleUser.mutate({ userId: u.id, status: "active" })}
                          data-testid={`button-activate-user-${u.id}`}
                        >
                          <CheckCircle className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PartnerOrgs() {
  const { toast } = useToast();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editOrg, setEditOrg] = useState<PartnerOrganization | null>(null);

  const { data: orgs = [], isLoading } = useQuery<OrgPerformance[]>({
    queryKey: ["/api/partner-orgs-performance"],
  });

  const createForm = useForm<OrgFormData>({
    resolver: zodResolver(orgFormSchema),
    defaultValues: {
      name: "", slug: "", logoUrl: "", primaryColor: "#2563eb",
      commissionRate: 10, contactName: "", email: "", phone: "", notes: "", status: "active",
    },
  });

  const editForm = useForm<OrgFormData>({
    resolver: zodResolver(orgFormSchema),
  });

  const createOrg = useMutation({
    mutationFn: async (data: OrgFormData) => {
      const res = await apiRequest("POST", "/api/partner-orgs", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/partner-orgs-performance"] });
      toast({ title: "Partner organization created" });
      setIsCreateOpen(false);
      createForm.reset();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateOrg = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<OrgFormData> }) => {
      const res = await apiRequest("PATCH", `/api/partner-orgs/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/partner-orgs-performance"] });
      toast({ title: "Organization updated" });
      setEditOrg(null);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteOrg = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/partner-orgs/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/partner-orgs-performance"] });
      toast({ title: "Organization deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleEdit = (org: PartnerOrganization) => {
    setEditOrg(org);
    editForm.reset({
      name: org.name,
      slug: org.slug,
      logoUrl: org.logoUrl || "",
      primaryColor: org.primaryColor || "#2563eb",
      commissionRate: org.commissionRate || 10,
      contactName: org.contactName || "",
      email: org.email || "",
      phone: org.phone || "",
      notes: org.notes || "",
      status: org.status || "active",
    });
  };

  const totalDeals = orgs.reduce((s, o) => s + (o.dealCount || 0), 0);
  const totalClosed = orgs.reduce((s, o) => s + (o.closedDealCount || 0), 0);
  const totalCommission = orgs.reduce((s, o) => s + (o.totalCommissionEarned || 0), 0);

  const OrgForm = ({ form, onSubmit, submitting }: { form: any; onSubmit: (d: OrgFormData) => void; submitting: boolean }) => (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="name" render={({ field }) => (
            <FormItem>
              <FormLabel>Organization Name *</FormLabel>
              <FormControl><Input {...field} placeholder="Acme Payments" data-testid="input-org-name" /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="slug" render={({ field }) => (
            <FormItem>
              <FormLabel>URL Slug *</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder="acme-payments"
                  onChange={e => field.onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                  data-testid="input-org-slug"
                />
              </FormControl>
              <FormMessage />
              <p className="text-xs text-muted-foreground">/partner/{field.value || "slug"}</p>
            </FormItem>
          )} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="primaryColor" render={({ field }) => (
            <FormItem>
              <FormLabel>Brand Color</FormLabel>
              <FormControl>
                <div className="flex gap-2 items-center">
                  <input type="color" value={field.value} onChange={e => field.onChange(e.target.value)} className="h-9 w-14 rounded cursor-pointer border border-input" data-testid="input-org-color" />
                  <Input {...field} placeholder="#2563eb" className="flex-1" />
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="commissionRate" render={({ field }) => (
            <FormItem>
              <FormLabel>Commission Rate (%)</FormLabel>
              <FormControl><Input {...field} type="number" min={0} max={100} step={0.5} data-testid="input-org-commission" /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>
        <FormField control={form.control} name="logoUrl" render={({ field }) => (
          <FormItem>
            <FormLabel>Logo URL (optional)</FormLabel>
            <FormControl><Input {...field} placeholder="https://yoursite.com/logo.png" data-testid="input-org-logo" /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="tagline" render={({ field }) => (
          <FormItem>
            <FormLabel>Tagline (optional)</FormLabel>
            <FormControl><Input {...field} placeholder="e.g. Helping businesses save on processing" data-testid="input-org-tagline" /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="contactName" render={({ field }) => (
            <FormItem>
              <FormLabel>Contact Name</FormLabel>
              <FormControl><Input {...field} data-testid="input-org-contact" /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="email" render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl><Input {...field} type="email" data-testid="input-org-email" /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>
        <FormField control={form.control} name="notes" render={({ field }) => (
          <FormItem>
            <FormLabel>Notes</FormLabel>
            <FormControl><Textarea {...field} className="resize-none" rows={2} data-testid="input-org-notes" /></FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={submitting} data-testid="button-submit-org">
            {submitting ? "Saving..." : "Save Organization"}
          </Button>
        </div>
      </form>
    </Form>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between gap-4">
        <div>
          <PageTitle className="text-2xl font-bold" data-testid="text-page-title">Partner Organizations</PageTitle>
          <p className="text-muted-foreground text-sm mt-1">Manage white-label Sub-ISO partner portals</p>
        </div>
        <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2" data-testid="button-create-org">
              <Plus className="w-4 h-4" /> New Partner Org
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Create Partner Organization</DialogTitle>
            </DialogHeader>
            <OrgForm
              form={createForm}
              onSubmit={(d) => createOrg.mutate(d)}
              submitting={createOrg.isPending}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard icon={Building2} label="Total Orgs" value={isLoading ? "..." : orgs.length} />
        <KpiCard icon={Users} label="Total Deals" value={isLoading ? "..." : totalDeals} />
        <KpiCard icon={CheckCircle} label="Closed Won" value={isLoading ? "..." : totalClosed} color="text-green-600" />
        <KpiCard icon={DollarSign} label="Total Commission" value={isLoading ? "..." : `$${totalCommission.toLocaleString()}`} color="text-emerald-600" />
      </div>

      {/* Orgs table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Organization</TableHead>
                <TableHead>Portal URL</TableHead>
                <TableHead>Commission</TableHead>
                <TableHead className="text-center">Deals</TableHead>
                <TableHead className="text-center">Closed</TableHead>
                <TableHead className="text-right">Commission Earned</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center h-24">
                    <Skeleton className="h-4 w-48 mx-auto" />
                  </TableCell>
                </TableRow>
              ) : orgs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center h-24 text-muted-foreground" data-testid="text-no-orgs">
                    No partner organizations yet. Create one to get started.
                  </TableCell>
                </TableRow>
              ) : (
                orgs.map(org => (
                  <TableRow key={org.id} data-testid={`row-org-${org.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0"
                          style={{ backgroundColor: org.primaryColor || "#2563eb" }}
                        >
                          {org.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-sm">{org.name}</p>
                          <p className="text-xs text-muted-foreground">{org.contactName || org.email || ""}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <code className="text-xs bg-muted px-2 py-0.5 rounded">/partner/{org.slug}</code>
                        <button
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            navigator.clipboard.writeText(`${window.location.origin}/partner/${org.slug}`);
                            toast({ title: "Portal URL copied!" });
                          }}
                          data-testid={`button-copy-url-${org.id}`}
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <a href={`/partner/${org.slug}`} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground" data-testid={`link-portal-${org.id}`}>
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm font-medium">{org.commissionRate}%</span>
                    </TableCell>
                    <TableCell className="text-center" data-testid={`text-deal-count-${org.id}`}>
                      {org.dealCount || 0}
                    </TableCell>
                    <TableCell className="text-center" data-testid={`text-closed-count-${org.id}`}>
                      {org.closedDealCount || 0}
                    </TableCell>
                    <TableCell className="text-right font-medium text-green-700" data-testid={`text-commission-${org.id}`}>
                      ${(org.totalCommissionEarned || 0).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant={org.status === "active" ? "default" : "secondary"} data-testid={`badge-status-${org.id}`}>
                        {org.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <OrgUserManager org={org} />
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 px-2"
                          onClick={() => handleEdit(org)}
                          data-testid={`button-edit-${org.id}`}
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost" size="sm"
                          className="h-7 px-2 text-red-600 hover:text-red-700"
                          onClick={() => {
                            if (confirm(`Delete "${org.name}"? This cannot be undone.`)) {
                              deleteOrg.mutate(org.id);
                            }
                          }}
                          data-testid={`button-delete-${org.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Edit dialog */}
      <Dialog open={!!editOrg} onOpenChange={open => { if (!open) setEditOrg(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit — {editOrg?.name}</DialogTitle>
          </DialogHeader>
          {editOrg && (
            <OrgForm
              form={editForm}
              onSubmit={(d) => updateOrg.mutate({ id: editOrg.id, data: d })}
              submitting={updateOrg.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
