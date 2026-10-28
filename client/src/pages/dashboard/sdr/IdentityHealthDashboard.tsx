import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Mail, AlertTriangle } from "lucide-react";

interface IdentityHealthData {
  id: number;
  label: string;
  domain: string;
  emailAddress: string;
  isActive: boolean;
  warmupStatus: string;
  dailyLimit: number;
  sentToday: number;
  healthScore: number;
  bounceRate: number;
  replyRate: number;
  complaintRate: number;
  openRate: number;
  weekSent: number;
  alert: string | null;
}

export function IdentityHealthDashboard() {
  const { data, isLoading } = useQuery<IdentityHealthData[]>({
    queryKey: ["/api/sdr/identity-health"],
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const identities = data || [];

  return (
    <Card data-testid="card-identity-health">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="w-5 h-5" />
          Inbox Deliverability Health
        </CardTitle>
      </CardHeader>
      <CardContent>
        {identities.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No sending identities configured yet. Set up inboxes in the inbox rotation settings.
          </div>
        ) : (
          <div className="space-y-3">
            {identities.map((identity) => (
              <div key={identity.id} className="flex items-center justify-between p-4 bg-muted/50 rounded-lg" data-testid={`identity-${identity.id}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{identity.label}</span>
                    <Badge variant={identity.isActive ? "secondary" : "outline"} className="text-xs">
                      {identity.warmupStatus}
                    </Badge>
                    {identity.alert && (
                      <Badge variant="destructive" className="text-xs">
                        <AlertTriangle className="w-3 h-3 mr-1" />
                        {identity.alert}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">{identity.emailAddress} ({identity.domain})</div>
                </div>
                <div className="flex items-center gap-6 text-sm">
                  <div className="text-center">
                    <div className={`font-medium ${identity.healthScore == null ? "text-muted-foreground" : identity.healthScore >= 80 ? "text-green-600" : identity.healthScore >= 50 ? "text-yellow-600" : "text-red-600"}`}>
                      {identity.healthScore != null ? `${identity.healthScore}%` : "unknown"}
                    </div>
                    <div className="text-xs text-muted-foreground">Health</div>
                  </div>
                  <div className="text-center">
                    <div className="font-medium">{identity.sentToday}/{identity.dailyLimit}</div>
                    <div className="text-xs text-muted-foreground">Today</div>
                  </div>
                  <div className="text-center">
                    <div className="font-medium">{identity.bounceRate}%</div>
                    <div className="text-xs text-muted-foreground">Bounce</div>
                  </div>
                  <div className="text-center">
                    <div className="font-medium">{identity.replyRate}%</div>
                    <div className="text-xs text-muted-foreground">Reply</div>
                  </div>
                  <div className="text-center">
                    <div className="font-medium">{identity.openRate}%</div>
                    <div className="text-xs text-muted-foreground">Open</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
