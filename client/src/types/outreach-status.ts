export interface OutreachStatus {
  entities: {
    total: number; enriched: number; pending: number; withEmail: number; withPhone: number;
    hot: number; warm: number; cold: number; unqualified: number; classified: number; pendingPromotion: number;
  };
  prospects: {
    total: number;
    withEmail: number;
    converted: number;
    qualified: number;
    hot: number;
    warm: number;
    cold: number;
    unclassified: number;
  };
  contacts: {
    total: number;
    fromSunbiz: number;
    newLeads: number;
    syncedToGhl: number;
    hot: number;
    warm: number;
    cold: number;
    unqualified: number;
    unclassified: number;
    withContactInfo: number;
  };
  deals: { total: number; openSalesProduction?: number; fromSunbiz: number; newLead: number; contacted: number; qualified: number; won: number };
  activeCampaigns: number;
  verticalBreakdown: Record<string, number>;
  sourceBreakdown: Array<{ source: string; contactCount: number; dealCount: number }>;
  ghlSync: { configured: boolean; totalContacts: number; syncedToGhl: number; unsyncedToGhl: number; lastSyncTo: any; lastSyncFrom: any };
  importProgress: { status: string; totalProcessed?: number; totalImported?: number; totalDuplicates?: number; totalSkipped?: number; error?: string };
  cordataProgress: { status: string; totalProcessed?: number; totalUpdated?: number; totalNew?: number; totalSkipped?: number; error?: string };
  enrichmentProgress: {
    status: string;
    total?: number;
    processed?: number;
    classified?: number;
    emailsFound?: number;
    phonesFound?: number;
    errors?: number;
    startedAt?: string;
    lastUpdate?: string;
    completedAt?: string;
    interruptedAt?: string;
    interruptionReason?: string;
    failedAt?: string;
    error?: string;
  };
  openAiConfigured?: boolean;
  lastOutreachRun: any;
  workerRunning: boolean;
  workerStatus: any;
  /** True when the event breakdown query failed; the empty list then means unknown, not zero. */
  commEventsUnavailable?: boolean;
  asOf?: string;
  commEventSourceBreakdown?: Array<{ source: string; emailCount: number; smsCount: number; callCount: number; total: number }>;
  serper?: {
    configured: boolean;
    usage: {
      totalCalls: number;
      successfulCalls: number;
      failedCalls: number;
      websitesFound: number;
      emailsFound: number;
      phonesFound: number;
      lastCallAt: string | null;
      resetAt: string;
      monthlyQuota: number;
      remainingCalls: number;
    };
  };
}
