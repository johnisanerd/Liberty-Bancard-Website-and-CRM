import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldCheck, ShieldOff, MessageSquare, Mail } from "lucide-react";
import { useState, useMemo } from "react";
import type { ConsentAuditLog } from "@shared/schema";
import { consentEventLabel } from "@shared/consent-event-label";
import { Button } from "@/components/ui/button";

export default function ConsentAudit() {
  const [channelFilter, setChannelFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [contactSearch, setContactSearch] = useState("");

  const { data: logs, isLoading, isError, refetch } = useQuery<ConsentAuditLog[]>({
    queryKey: ["/api/consent-audit"],
  });

  const filtered = useMemo(() => {
    if (!logs) return [];
    return logs.filter((log) => {
      if (channelFilter !== "all" && log.channel !== channelFilter) return false;
      if (actionFilter !== "all" && log.action !== actionFilter) return false;
      if (contactSearch && log.contactId?.toString() !== contactSearch) return false;
      return true;
    });
  }, [logs, channelFilter, actionFilter, contactSearch]);

  const totalOptIns = logs?.filter((l) => l.action === "opt_in").length ?? 0;
  const totalOptOuts = logs?.filter((l) => l.action === "opt_out").length ?? 0;
  const smsConsents = logs?.filter((l) => l.channel === "sms" && l.action === "opt_in").length ?? 0;
  const emailConsents = logs?.filter((l) => l.channel === "email" && l.action === "opt_in").length ?? 0;

  if (isLoading) {
    return (
      <div className="p-6 space-y-6" data-testid="consent-audit-loading">
        <h2 className="text-2xl font-bold" data-testid="text-page-title">TCPA Consent Audit Trail</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (isError) return <div role="alert" className="p-6 space-y-3">
    <p>Consent history unavailable. No consent conclusion can be drawn.</p>
    <Button variant="outline" onClick={() => void refetch()}>Retry consent history</Button>
  </div>;

  return (
    <div className="p-6 space-y-6" data-testid="consent-audit-page">
      <h2 className="text-2xl font-bold" data-testid="text-page-title">TCPA Consent Audit Trail</h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="card-total-opt-ins">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Opt-Ins</CardTitle>
            <ShieldCheck className="h-4 w-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-opt-ins">{totalOptIns}</div>
          </CardContent>
        </Card>
        <Card data-testid="card-total-opt-outs">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Opt-Outs</CardTitle>
            <ShieldOff className="h-4 w-4 text-red-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-opt-outs">{totalOptOuts}</div>
          </CardContent>
        </Card>
        <Card data-testid="card-sms-consents">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">SMS Consents</CardTitle>
            <MessageSquare className="h-4 w-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-sms-consents">{smsConsents}</div>
          </CardContent>
        </Card>
        <Card data-testid="card-email-consents">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Email Consents</CardTitle>
            <Mail className="h-4 w-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-email-consents">{emailConsents}</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="w-48">
          <Select value={channelFilter} onValueChange={setChannelFilter} data-testid="select-channel-filter">
            <SelectTrigger data-testid="select-trigger-channel">
              <SelectValue placeholder="Channel" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" data-testid="select-item-channel-all">All Channels</SelectItem>
              <SelectItem value="sms" data-testid="select-item-channel-sms">SMS</SelectItem>
              <SelectItem value="email" data-testid="select-item-channel-email">Email</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="w-48">
          <Select value={actionFilter} onValueChange={setActionFilter} data-testid="select-action-filter">
            <SelectTrigger data-testid="select-trigger-action">
              <SelectValue placeholder="Action" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" data-testid="select-item-action-all">All Actions</SelectItem>
              <SelectItem value="opt_in" data-testid="select-item-action-opt-in">Opt In</SelectItem>
              <SelectItem value="opt_out" data-testid="select-item-action-opt-out">Opt Out</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Input
          placeholder="Search by Contact ID"
          value={contactSearch}
          onChange={(e) => setContactSearch(e.target.value)}
          className="w-48"
          data-testid="input-contact-search"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table data-testid="table-consent-audit">
            <TableHeader>
              <TableRow>
                <TableHead>Date/Time</TableHead>
                <TableHead>Contact ID</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>IP Address</TableHead>
                <TableHead>User Agent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8" data-testid="text-no-results">
                    No consent audit logs found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((log) => (
                  <TableRow key={log.id} data-testid={`row-consent-log-${log.id}`}>
                    <TableCell data-testid={`text-datetime-${log.id}`}>
                      {log.createdAt ? new Date(log.createdAt).toLocaleString() : "N/A"}
                    </TableCell>
                    <TableCell data-testid={`text-contact-id-${log.id}`}>
                      {log.contactId ?? "N/A"}
                    </TableCell>
                    <TableCell data-testid={`badge-channel-${log.id}`}>
                      <Badge variant="outline" className="text-xs">
                        {log.channel.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell data-testid={`badge-action-${log.id}`}>
                      <Badge
                        variant={log.action === "opt_in" ? "default" : log.action === "opt_out" ? "destructive" : "outline"}
                        className={`text-xs ${log.action === "opt_in" ? "bg-green-600 hover:bg-green-700" : ""}`}
                      >
                        {consentEventLabel(log.action)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground" data-testid={`text-source-${log.id}`}>
                      {log.source || "N/A"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs font-mono" data-testid={`text-ip-${log.id}`}>
                      {log.ipAddress || "N/A"}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs max-w-[200px] truncate" data-testid={`text-ua-${log.id}`}>
                      {log.userAgent || "N/A"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
