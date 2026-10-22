import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/crm/CrmPresentation";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { useState, useMemo } from "react";
import { CrmDataState } from "@/components/crm/CrmPresentation";

type RouteAccess = "public" | "authenticated" | "role" | "unknown";

interface GuardProvenance {
  source: "mount" | "route";
  mountPath: string;
  roles: string[];
}

interface RoutePermission {
  method: string;
  path: string;
  access?: RouteAccess;
  requiredRoles: string[];
  guards?: GuardProvenance[];
  unresolved?: string;
}

interface RoutePermissionsResponse {
  status?: "ok";
  routes: RoutePermission[];
  summary?: { total: number; public: number; authenticated: number; role: number; unknown: number; unresolvedMounts: number };
  unsupported?: string[];
  generatedAt?: string;
}

const methodColor = (m: string): "default" | "secondary" | "destructive" | "outline" => {
  switch (m) {
    case "GET": return "secondary";
    case "POST": return "default";
    case "PUT":
    case "PATCH": return "outline";
    case "DELETE": return "destructive";
    default: return "outline";
  }
};

const roleBadge = (role: string): "default" | "secondary" | "destructive" | "outline" => {
  if (role === "admin") return "destructive";
  if (role === "manager") return "default";
  if (role === "any-authenticated") return "secondary";
  if (role === "public") return "outline";
  return "secondary";
};

const ACCESS_LABEL: Record<RouteAccess, string> = {
  public: "Explicitly public",
  authenticated: "Signed in",
  role: "Role restricted",
  unknown: "Unknown (not proven)",
};

export default function Permissions() {
  const { user } = useAuth();
  // Role denial comes first so a non-admin never mounts the census reader or requests it.
  if (user?.role !== "admin") {
    return (
      <Card data-testid="card-access-denied">
        <CardContent className="p-6">
          <p className="text-muted-foreground" data-testid="text-access-denied">
            You do not have permission to view this page.
          </p>
        </CardContent>
      </Card>
    );
  }
  return <PermissionsInventory />;
}

function PermissionsInventory() {
  const [filter, setFilter] = useState("");

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<RoutePermissionsResponse>({
    queryKey: ["/api/admin/route-permissions"],
    retry: false,
  });

  const filtered = useMemo(() => {
    const routes = data?.routes ?? [];
    if (!filter.trim()) return routes;
    const q = filter.toLowerCase();
    return routes.filter(
      (r) =>
        r.path.toLowerCase().includes(q) ||
        r.method.toLowerCase().includes(q) ||
        (r.access ?? "").toLowerCase().includes(q) ||
        r.requiredRoles.some((role) => role.toLowerCase().includes(q))
    );
  }, [data, filter]);

  return (
    <div className="space-y-6" data-testid="page-permissions">
      <PageHeader
        headingLevel={2}
        title="Permissions Audit"
        subtitle="Inventory of registered API routes: full mount path, methods and the ordered guards each route inherits. This describes registered enforcement; it does not grant or change access."
        data-testid="text-permissions-title"
      />

      <Input
        placeholder="Filter by path, method, access or role..."
        aria-label="Filter routes by path, method, access or role"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="max-w-md"
        data-testid="input-filter-permissions"
      />

      {isLoading ? (
        <CrmDataState state="loading" message="Loading the registered route inventory…" />
      ) : isError || !data ? (
        <div data-testid="permissions-error">
          <CrmDataState
            state="unavailable"
            message={`${error instanceof Error ? error.message : "The route inventory could not be read."} This is not an empty route list.`}
            onRetry={() => void refetch()}
          />
        </div>
      ) : (
        <>
          {data.summary && (
            <p className="text-xs text-muted-foreground" data-testid="text-permissions-summary">
              {data.summary.role} role-restricted · {data.summary.authenticated} signed-in · {data.summary.public} explicitly public ·{" "}
              {data.summary.unknown} unknown (guard not proven; never treated as public)
              {data.summary.unresolvedMounts > 0 ? ` · ${data.summary.unresolvedMounts} mount(s) not recorded` : ""}
              {isFetching ? " · refreshing…" : ""}
            </p>
          )}
          {(data.unsupported?.length ?? 0) > 0 && (
            <p className="text-xs text-amber-700" role="note" data-testid="text-permissions-unsupported">
              Unsupported registrations: {data.unsupported!.join("; ")}
            </p>
          )}
          <div className="border rounded-md overflow-x-auto">
            <Table data-testid="table-permissions">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20" data-testid="th-method">Method</TableHead>
                  <TableHead data-testid="th-path">Path</TableHead>
                  <TableHead data-testid="th-roles">Access</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r, i) => (
                  <TableRow key={`${r.method}-${r.path}-${i}`} data-testid={`row-route-${i}`}>
                    <TableCell data-testid={`text-method-${i}`}>
                      <Badge variant={methodColor(r.method)} className="text-xs font-mono">
                        {r.method}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs break-all" data-testid={`text-path-${i}`}>
                      {r.path}
                    </TableCell>
                    <TableCell data-testid={`cell-roles-${i}`}>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-xs text-muted-foreground">{ACCESS_LABEL[r.access ?? "unknown"]}</span>
                        {r.requiredRoles.map((role) => (
                          <Badge key={role} variant={roleBadge(role)} className="text-xs">
                            {role}
                          </Badge>
                        ))}
                      </div>
                      {(r.guards?.length ?? 0) > 0 && (
                        <p className="mt-1 text-xs text-muted-foreground font-mono break-all">
                          {r.guards!.map((g) => `${g.source === "mount" ? g.mountPath : "route"}: ${g.roles.join("|")}`).join(" → ")}
                        </p>
                      )}
                      {r.unresolved && <p className="mt-1 text-xs text-amber-700">{r.unresolved}</p>}
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground" data-testid="text-no-routes">
                      No routes match the filter.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground" data-testid="text-route-count">
            Showing {filtered.length} of {data.routes.length} registered API routes.
          </p>
        </>
      )}
    </div>
  );
}
