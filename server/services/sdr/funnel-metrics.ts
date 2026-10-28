import { db } from "../../db";
import { dailyFunnelMetrics, sdrLeadState, sdrLeadEvents, sdrChannelAttempts, sdrMerchants, deals, businesses, sendingIdentities, identityPerformanceDaily, leadSources, contacts } from "@shared/schema";
import type { DailyFunnelMetrics } from "@shared/schema";
import { eq, sql, and, gte, lte } from "drizzle-orm";
// CRO-02 observation runs via the CRO02_OBSERVATION BullMQ job — not called inline here.

let aggregationInterval: ReturnType<typeof setInterval> | null = null;

function getEstDateString(date?: Date): string {
  return (date || new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

import { countSdrEventKinds, type SdrEventKind } from "./event-kinds";

export async function aggregateDailyMetrics(dateStr?: string): Promise<void> {
  const targetDate = dateStr || getEstDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  console.log(`[FunnelMetrics] Aggregating metrics for ${targetDate}...`);

  try {
    const startOfDay = new Date(`${targetDate}T00:00:00-05:00`);
    const endOfDay = new Date(`${targetDate}T23:59:59-05:00`);

    await db.delete(dailyFunnelMetrics).where(eq(dailyFunnelMetrics.date, targetDate));

    const leadsCreated = await db.select({
      vertical: sdrLeadState.vertical,
      state: sdrLeadState.state,
      sourceType: sdrLeadState.sourceType,
      count: sql<number>`count(*)`,
    }).from(sdrLeadState).innerJoin(contacts, eq(contacts.id, sdrLeadState.contactId)).where(
      sql`${contacts.recordClass} = 'production'
          AND ${sdrLeadState.createdAt} >= ${startOfDay} AND ${sdrLeadState.createdAt} <= ${endOfDay}`
    ).groupBy(sdrLeadState.vertical, sdrLeadState.state, sdrLeadState.sourceType);

    const enrichedLeads = await db.select({
      vertical: sdrLeadState.vertical,
      count: sql<number>`count(*)`,
    }).from(sdrLeadState).innerJoin(contacts, eq(contacts.id, sdrLeadState.contactId)).where(
      sql`${contacts.recordClass} = 'production'
          AND ${sdrLeadState.createdAt} >= ${startOfDay} AND ${sdrLeadState.createdAt} <= ${endOfDay}
          AND (${sdrLeadState.email} IS NOT NULL OR ${sdrLeadState.phone} IS NOT NULL)`
    ).groupBy(sdrLeadState.vertical);

    const enrichedByVertical: Record<string, number> = {};
    for (const row of enrichedLeads) {
      enrichedByVertical[row.vertical || "_all"] = row.count;
    }

    const hotLeads = await db.select({
      vertical: sdrLeadState.vertical,
      count: sql<number>`count(*)`,
    }).from(sdrLeadState).innerJoin(contacts, eq(contacts.id, sdrLeadState.contactId)).where(
      sql`${contacts.recordClass} = 'production'
          AND ${sdrLeadState.createdAt} >= ${startOfDay} AND ${sdrLeadState.createdAt} <= ${endOfDay}
          AND ${sdrLeadState.priorityBucket} = 'A'`
    ).groupBy(sdrLeadState.vertical);

    const hotByVertical: Record<string, number> = {};
    for (const row of hotLeads) {
      hotByVertical[row.vertical || "_all"] = row.count;
    }

    const warmLeads = await db.select({
      vertical: sdrLeadState.vertical,
      count: sql<number>`count(*)`,
    }).from(sdrLeadState).innerJoin(contacts, eq(contacts.id, sdrLeadState.contactId)).where(
      sql`${contacts.recordClass} = 'production'
          AND ${sdrLeadState.createdAt} >= ${startOfDay} AND ${sdrLeadState.createdAt} <= ${endOfDay}
          AND ${sdrLeadState.priorityBucket} = 'B'`
    ).groupBy(sdrLeadState.vertical);

    const warmByVertical: Record<string, number> = {};
    for (const row of warmLeads) {
      warmByVertical[row.vertical || "_all"] = row.count;
    }

    const channelAttempts = await db.select({
      channel: sdrChannelAttempts.channel,
      count: sql<number>`count(*)`,
      replies: sql<number>`count(case when ${sdrChannelAttempts.repliedAt} is not null then 1 end)`,
    }).from(sdrChannelAttempts)
      .innerJoin(sdrLeadState, eq(sdrLeadState.id, sdrChannelAttempts.leadStateId))
      .innerJoin(contacts, eq(contacts.id, sdrLeadState.contactId))
      .where(
      sql`${contacts.recordClass} = 'production'
          AND ${sdrChannelAttempts.sentAt} >= ${startOfDay} AND ${sdrChannelAttempts.sentAt} <= ${endOfDay}`
    ).groupBy(sdrChannelAttempts.channel);

    let totalEmails = 0, totalSms = 0, totalCalls = 0, totalReplies = 0;
    for (const ch of channelAttempts) {
      if (ch.channel === "email") { totalEmails = ch.count; totalReplies += ch.replies; }
      if (ch.channel === "sms") { totalSms = ch.count; totalReplies += ch.replies; }
      if (ch.channel === "call") { totalCalls = ch.count; }
    }

    const meetingsBooked = await db.select({
      count: sql<number>`count(*)`,
    }).from(sdrLeadEvents)
      .innerJoin(sdrLeadState, eq(sdrLeadState.id, sdrLeadEvents.leadStateId))
      .innerJoin(contacts, eq(contacts.id, sdrLeadState.contactId))
      .where(
      sql`${contacts.recordClass} = 'production'
          AND ${sdrLeadEvents.eventType} IN ('meeting_booked', 'booking')
          AND ${sdrLeadEvents.createdAt} >= ${startOfDay} AND ${sdrLeadEvents.createdAt} <= ${endOfDay}`
    );

    const statementsReceived = await db.select({
      count: sql<number>`count(*)`,
    }).from(sdrLeadState).innerJoin(contacts, eq(contacts.id, sdrLeadState.contactId)).where(
      sql`${contacts.recordClass} = 'production'
          AND ${sdrLeadState.currentStage} = 'STATEMENT_RECEIVED' AND ${sdrLeadState.updatedAt} >= ${startOfDay} AND ${sdrLeadState.updatedAt} <= ${endOfDay}`
    );

    const proposalsSent = await db.select({
      count: sql<number>`count(*)`,
    }).from(sdrLeadState).innerJoin(contacts, eq(contacts.id, sdrLeadState.contactId)).where(
      sql`${contacts.recordClass} = 'production'
          AND ${sdrLeadState.currentStage} = 'PROPOSAL_SENT' AND ${sdrLeadState.updatedAt} >= ${startOfDay} AND ${sdrLeadState.updatedAt} <= ${endOfDay}`
    );

    const closedWon = await db.select({
      count: sql<number>`count(*)`,
    }).from(deals).where(
      sql`${deals.stage} = 'Closed Won' AND ${deals.recordClass} = 'production' AND ${deals.closedAt} >= ${startOfDay} AND ${deals.closedAt} <= ${endOfDay}`
    );

    const closedLost = await db.select({
      count: sql<number>`count(*)`,
    }).from(deals).where(
      sql`${deals.stage} = 'Closed Lost' AND ${deals.recordClass} = 'production' AND ${deals.closedAt} >= ${startOfDay} AND ${deals.closedAt} <= ${endOfDay}`
    );

    const groups = new Map<string, any>();

    for (const row of leadsCreated) {
      const key = `${row.vertical || "_all"}|${row.state || "_all"}|${row.sourceType || "_all"}`;
      if (!groups.has(key)) {
        groups.set(key, {
          date: targetDate,
          vertical: row.vertical || null,
          state: row.state || null,
          sourceType: row.sourceType || null,
          leadsFound: 0,
          leadsEnriched: 0,
          hotCreated: 0,
          warmCreated: 0,
          emailsSent: 0,
          smsSent: 0,
          callsMade: 0,
          replies: 0,
          meetingsBooked: 0,
          statementsReceived: 0,
          proposalsSent: 0,
          closedWon: 0,
          closedLost: 0,
        });
      }
      const g = groups.get(key)!;
      g.leadsFound += row.count;
      g.leadsEnriched = enrichedByVertical[row.vertical || "_all"] || 0;
      g.hotCreated = hotByVertical[row.vertical || "_all"] || 0;
      g.warmCreated = warmByVertical[row.vertical || "_all"] || 0;
    }

    await db.insert(dailyFunnelMetrics).values({
      date: targetDate,
      vertical: null,
      state: null,
      sourceType: null,
      leadsFound: leadsCreated.reduce((s, r) => s + r.count, 0),
      leadsEnriched: Object.values(enrichedByVertical).reduce((s, v) => s + v, 0),
      hotCreated: Object.values(hotByVertical).reduce((s, v) => s + v, 0),
      warmCreated: Object.values(warmByVertical).reduce((s, v) => s + v, 0),
      emailsSent: totalEmails,
      smsSent: totalSms,
      callsMade: totalCalls,
      replies: totalReplies,
      meetingsBooked: meetingsBooked[0]?.count || 0,
      statementsReceived: statementsReceived[0]?.count || 0,
      proposalsSent: proposalsSent[0]?.count || 0,
      closedWon: closedWon[0]?.count || 0,
      closedLost: closedLost[0]?.count || 0,
    });

    for (const row of groups.values()) {
      await db.insert(dailyFunnelMetrics).values(row);
    }

    // Store a read-only classification reconciliation marker with source and
    // excluded counts. Aggregate detail remains production-only by policy.
    const classCounts = await db.select({
      recordClass: contacts.recordClass,
      count: sql<number>`count(*)`,
    }).from(contacts).groupBy(contacts.recordClass);
    const sourceRowCount = classCounts.reduce((sum, row) => sum + Number(row.count), 0);
    const productionCount = classCounts
      .filter((row) => row.recordClass === "production")
      .reduce((sum, row) => sum + Number(row.count), 0);
    const unknownCount = classCounts
      .filter((row) => row.recordClass === "unknown")
      .reduce((sum, row) => sum + Number(row.count), 0);
    await db.execute(sql`
      INSERT INTO commercial_aggregate_lineage
        (aggregate_type, aggregate_key, policy_version, source_row_count,
         production_count, excluded_count, unknown_count, lineage_hwm, computed_at)
      VALUES
        ('funnel_metrics', ${targetDate}, 1, ${sourceRowCount},
         ${productionCount}, ${sourceRowCount - productionCount}, ${unknownCount}, ${endOfDay}, now())
    `);

    console.log(`[FunnelMetrics] Aggregated ${groups.size + 1} metric rows for ${targetDate}`);
  } catch (err) {
    console.error("[FunnelMetrics] Aggregation error:", err);
    throw err;
  }
}

export async function getFunnelMetrics(options: {
  startDate?: string;
  endDate?: string;
  vertical?: string;
  state?: string;
  sourceType?: string;
}): Promise<DailyFunnelMetrics[]> {
  const { startDate, endDate, vertical, state, sourceType } = options;

  const conditions = [];
  if (startDate) conditions.push(sql`${dailyFunnelMetrics.date} >= ${startDate}`);
  if (endDate) conditions.push(sql`${dailyFunnelMetrics.date} <= ${endDate}`);
  if (vertical) conditions.push(eq(dailyFunnelMetrics.vertical, vertical));
  if (state) conditions.push(eq(dailyFunnelMetrics.state, state));
  if (sourceType) conditions.push(eq(dailyFunnelMetrics.sourceType, sourceType));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  return db.select().from(dailyFunnelMetrics).where(where).orderBy(sql`${dailyFunnelMetrics.date} DESC`).limit(500);
}

export async function getSourceQualityReport(): Promise<any[]> {
  const thirtyDaysAgo = getEstDateString(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));

  const sourceLeads = await db.select({
    sourceType: dailyFunnelMetrics.sourceType,
    totalLeads: sql<number>`sum(${dailyFunnelMetrics.leadsFound})`,
    totalEnriched: sql<number>`sum(${dailyFunnelMetrics.leadsEnriched})`,
    totalHot: sql<number>`sum(${dailyFunnelMetrics.hotCreated})`,
  }).from(dailyFunnelMetrics).where(
    sql`${dailyFunnelMetrics.date} >= ${thirtyDaysAgo}
        AND ${dailyFunnelMetrics.sourceType} IS NOT NULL`
  ).groupBy(dailyFunnelMetrics.sourceType);

  const globalMetrics = await db.select({
    totalReplies: sql<number>`sum(${dailyFunnelMetrics.replies})`,
    totalMeetings: sql<number>`sum(${dailyFunnelMetrics.meetingsBooked})`,
    totalStatements: sql<number>`sum(${dailyFunnelMetrics.statementsReceived})`,
    totalClosedWon: sql<number>`sum(${dailyFunnelMetrics.closedWon})`,
    totalLeadsAll: sql<number>`sum(${dailyFunnelMetrics.leadsFound})`,
  }).from(dailyFunnelMetrics).where(
    sql`${dailyFunnelMetrics.date} >= ${thirtyDaysAgo}
        AND ${dailyFunnelMetrics.vertical} IS NULL AND ${dailyFunnelMetrics.state} IS NULL AND ${dailyFunnelMetrics.sourceType} IS NULL`
  );

  const g = globalMetrics[0] || {};
  const totalLeadsAll = g.totalLeadsAll || 1;

  return sourceLeads.map(row => {
    const leads = row.totalLeads || 1;
    const sourceProportion = (row.totalLeads || 0) / totalLeadsAll;
    return {
      sourceType: row.sourceType || "unknown",
      totalLeads: row.totalLeads || 0,
      enrichmentRate: Math.round(((row.totalEnriched || 0) / leads) * 100),
      hotRate: Math.round(((row.totalHot || 0) / leads) * 100),
      replyRate: Math.round((((g.totalReplies || 0) * sourceProportion) / leads) * 100),
      meetingRate: Math.round((((g.totalMeetings || 0) * sourceProportion) / leads) * 100),
      statementRate: Math.round((((g.totalStatements || 0) * sourceProportion) / leads) * 100),
      closeRate: Math.round((((g.totalClosedWon || 0) * sourceProportion) / leads) * 100),
    };
  });
}

export async function getIdentityHealthReport(): Promise<any[]> {
  const identities = await db.select().from(sendingIdentities);

  const today = getEstDateString();
  const sevenDaysAgo = getEstDateString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

  return Promise.all(identities.map(async (identity) => {
    const perf = await db.select({
      totalSent: sql<number>`sum(${identityPerformanceDaily.emailsSent})`,
      totalBounced: sql<number>`sum(${identityPerformanceDaily.bounced})`,
      totalReplied: sql<number>`sum(${identityPerformanceDaily.replied})`,
      totalComplaints: sql<number>`sum(${identityPerformanceDaily.complaints})`,
      totalOpened: sql<number>`sum(${identityPerformanceDaily.opened})`,
    }).from(identityPerformanceDaily).where(
      and(
        eq(identityPerformanceDaily.sendingIdentityId, identity.id),
        sql`${identityPerformanceDaily.date} >= ${sevenDaysAgo}`
      )
    );

    const stats = perf[0] || {};
    const sent = (stats.totalSent || 0) || 1;

    return {
      id: identity.id,
      label: identity.label,
      domain: identity.domain,
      emailAddress: identity.emailAddress,
      isActive: identity.isActive,
      warmupStatus: identity.warmupStatus,
      dailyLimit: identity.dailyLimit,
      sentToday: identity.sentToday || 0,
      // 0 is a real score; a missing score is null (unknown), never a defaulted 100.
      healthScore: identity.healthScore ?? null,
      bounceRate: Math.round(((stats.totalBounced || 0) / sent) * 100),
      replyRate: Math.round(((stats.totalReplied || 0) / sent) * 100),
      complaintRate: Math.round(((stats.totalComplaints || 0) / sent) * 1000) / 10,
      openRate: Math.round(((stats.totalOpened || 0) / sent) * 100),
      weekSent: stats.totalSent || 0,
      alert: identity.healthScore != null && identity.healthScore < 70 ? "degraded" :
             (stats.totalComplaints || 0) > 2 ? "complaints" :
             ((stats.totalBounced || 0) / sent) > 0.1 ? "high_bounce" : null,
    };
  }));
}

export async function getMarketExpansionData(): Promise<any> {
  const stateStats = await db.select({
    state: sdrLeadState.state,
    total: sql<number>`count(*)`,
    contacted: sql<number>`count(case when ${sdrLeadState.currentStage} NOT IN ('DISCOVERED', 'ENRICHED', 'QUALIFIED') then 1 end)`,
    engaged: sql<number>`count(case when ${sdrLeadState.lastReplyAt} is not null then 1 end)`,
    closedWon: sql<number>`count(case when ${sdrLeadState.currentStage} IN ('CLOSED_WON', 'BOARDED') then 1 end)`,
  }).from(sdrLeadState).where(
    sql`${sdrLeadState.state} IS NOT NULL`
  ).groupBy(sdrLeadState.state);

  const metroStats = await db.select({
    city: sdrLeadState.city,
    state: sdrLeadState.state,
    total: sql<number>`count(*)`,
    contacted: sql<number>`count(case when ${sdrLeadState.currentStage} NOT IN ('DISCOVERED', 'ENRICHED', 'QUALIFIED') then 1 end)`,
    engaged: sql<number>`count(case when ${sdrLeadState.lastReplyAt} is not null then 1 end)`,
  }).from(sdrLeadState).where(
    sql`${sdrLeadState.city} IS NOT NULL`
  ).groupBy(sdrLeadState.city, sdrLeadState.state).orderBy(sql`count(*) DESC`).limit(30);

  const ADDRESSABLE_ESTIMATES: Record<string, number> = {
    FL: 180000,
    TX: 250000,
    CA: 300000,
    NY: 200000,
    GA: 100000,
    NC: 85000,
    NJ: 90000,
    PA: 120000,
  };

  const EXPANSION_ORDER = ["FL", "TX", "CA", "NY", "GA", "NC", "NJ", "PA"];

  const expansionSuggestions: any[] = [];
  const currentStates = stateStats.map(s => s.state).filter(Boolean);

  for (const st of stateStats) {
    if (!st.state) continue;
    const addressable = ADDRESSABLE_ESTIMATES[st.state] || 50000;
    const utilization = Math.round((st.total / addressable) * 100);

    if (utilization >= 80) {
      const nextState = EXPANSION_ORDER.find(s => !currentStates.includes(s) || (stateStats.find(ss => ss.state === s)?.total || 0) < 100);
      if (nextState) {
        expansionSuggestions.push({
          currentState: st.state,
          utilization,
          suggestedState: nextState,
          reason: `${st.state} pipeline at ${utilization}% utilization. Consider expanding to ${nextState}.`,
          estimatedAddressable: ADDRESSABLE_ESTIMATES[nextState] || 50000,
        });
      }
    }
  }

  return {
    byState: stateStats.map(s => ({
      state: s.state,
      total: s.total,
      contacted: s.contacted,
      engaged: s.engaged,
      closedWon: s.closedWon,
      contactRate: s.total > 0 ? Math.round((s.contacted / s.total) * 100) : 0,
      engagementRate: s.total > 0 ? Math.round((s.engaged / s.total) * 100) : 0,
      addressable: ADDRESSABLE_ESTIMATES[s.state || ""] || 50000,
      penetration: Math.round((s.total / (ADDRESSABLE_ESTIMATES[s.state || ""] || 50000)) * 100),
    })),
    byMetro: metroStats.map(m => ({
      city: m.city,
      state: m.state,
      total: m.total,
      contacted: m.contacted,
      engaged: m.engaged,
    })),
    expansionSuggestions,
  };
}

export async function getWeeklyKpiDigestData(): Promise<any> {
  const today = getEstDateString();
  const sevenDaysAgo = getEstDateString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

  const weekMetrics = await db.select({
    leadsFound: sql<number>`sum(${dailyFunnelMetrics.leadsFound})`,
    leadsEnriched: sql<number>`sum(${dailyFunnelMetrics.leadsEnriched})`,
    hotCreated: sql<number>`sum(${dailyFunnelMetrics.hotCreated})`,
    warmCreated: sql<number>`sum(${dailyFunnelMetrics.warmCreated})`,
    emailsSent: sql<number>`sum(${dailyFunnelMetrics.emailsSent})`,
    smsSent: sql<number>`sum(${dailyFunnelMetrics.smsSent})`,
    callsMade: sql<number>`sum(${dailyFunnelMetrics.callsMade})`,
    replies: sql<number>`sum(${dailyFunnelMetrics.replies})`,
    meetingsBooked: sql<number>`sum(${dailyFunnelMetrics.meetingsBooked})`,
    statementsReceived: sql<number>`sum(${dailyFunnelMetrics.statementsReceived})`,
    proposalsSent: sql<number>`sum(${dailyFunnelMetrics.proposalsSent})`,
    closedWon: sql<number>`sum(${dailyFunnelMetrics.closedWon})`,
    closedLost: sql<number>`sum(${dailyFunnelMetrics.closedLost})`,
  }).from(dailyFunnelMetrics).where(
    sql`${dailyFunnelMetrics.date} >= ${sevenDaysAgo} AND ${dailyFunnelMetrics.date} <= ${today}
        AND ${dailyFunnelMetrics.vertical} IS NULL AND ${dailyFunnelMetrics.state} IS NULL AND ${dailyFunnelMetrics.sourceType} IS NULL`
  );

  const verticalPerf = await db.select({
    vertical: dailyFunnelMetrics.vertical,
    leads: sql<number>`sum(${dailyFunnelMetrics.leadsFound})`,
    replies: sql<number>`sum(${dailyFunnelMetrics.replies})`,
    meetings: sql<number>`sum(${dailyFunnelMetrics.meetingsBooked})`,
    closedWon: sql<number>`sum(${dailyFunnelMetrics.closedWon})`,
  }).from(dailyFunnelMetrics).where(
    sql`${dailyFunnelMetrics.date} >= ${sevenDaysAgo} AND ${dailyFunnelMetrics.date} <= ${today} AND ${dailyFunnelMetrics.vertical} IS NOT NULL`
  ).groupBy(dailyFunnelMetrics.vertical);

  const sourceQuality = await getSourceQualityReport();
  const identityHealth = await getIdentityHealthReport();
  const marketData = await getMarketExpansionData();

  const m = weekMetrics[0] || {};
  const totalSent = (m.emailsSent || 0) + (m.smsSent || 0) + (m.callsMade || 0);

  return {
    period: { start: sevenDaysAgo, end: today },
    topFunnel: {
      leadsFound: m.leadsFound || 0,
      leadsEnriched: m.leadsEnriched || 0,
      enrichmentRate: (m.leadsFound || 0) > 0 ? Math.round(((m.leadsEnriched || 0) / (m.leadsFound || 1)) * 100) : 0,
      hotCreated: m.hotCreated || 0,
      warmCreated: m.warmCreated || 0,
    },
    outreach: {
      emailsSent: m.emailsSent || 0,
      smsSent: m.smsSent || 0,
      callsMade: m.callsMade || 0,
      replies: m.replies || 0,
      replyRate: totalSent > 0 ? Math.round(((m.replies || 0) / totalSent) * 100) : 0,
      meetingsBooked: m.meetingsBooked || 0,
    },
    midFunnel: {
      statementsReceived: m.statementsReceived || 0,
      proposalsSent: m.proposalsSent || 0,
    },
    bottomFunnel: {
      closedWon: m.closedWon || 0,
      closedLost: m.closedLost || 0,
      winRate: ((m.closedWon || 0) + (m.closedLost || 0)) > 0
        ? Math.round(((m.closedWon || 0) / ((m.closedWon || 0) + (m.closedLost || 0))) * 100)
        : 0,
    },
    verticalPerformance: verticalPerf.map(v => ({
      vertical: v.vertical,
      leads: v.leads || 0,
      replies: v.replies || 0,
      meetings: v.meetings || 0,
      closedWon: v.closedWon || 0,
    })),
    sourceQuality,
    identityHealth: identityHealth.map(i => ({
      label: i.label,
      domain: i.domain,
      healthScore: i.healthScore,
      alert: i.alert,
    })),
    expansionSuggestions: marketData.expansionSuggestions,
  };
}

export function startNightlyAggregation(): void {
  if (aggregationInterval) {
    console.log("[FunnelMetrics] Aggregation already scheduled");
    return;
  }

  console.log("[FunnelMetrics] Nightly aggregation scheduled (runs daily at midnight EST)");

  aggregationInterval = setInterval(async () => {
    const now = new Date();
    const estHour = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getHours();

    if (estHour === 0) {
      try {
        await aggregateDailyMetrics();
      } catch (err) {
        console.error("[FunnelMetrics] Nightly aggregation error:", err);
      }
    }
  }, 60 * 60 * 1000);
}

export function stopNightlyAggregation(): void {
  if (aggregationInterval) {
    clearInterval(aggregationInterval);
    aggregationInterval = null;
    console.log("[FunnelMetrics] Nightly aggregation stopped");
  }
}

export async function getOperatorKpis(range: string = "today"): Promise<any> {
  const now = new Date();
  let startDate: string;
  let endDate: string = getEstDateString(now);

  if (range === "yesterday") {
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    startDate = getEstDateString(yesterday);
    endDate = startDate;
  } else if (range === "7day") {
    startDate = getEstDateString(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  } else {
    startDate = endDate;
  }

  const metricsRows = await db.select({
    leadsFound: sql<number>`coalesce(sum(${dailyFunnelMetrics.leadsFound}), 0)`,
    emailsSent: sql<number>`coalesce(sum(${dailyFunnelMetrics.emailsSent}), 0)`,
    smsSent: sql<number>`coalesce(sum(${dailyFunnelMetrics.smsSent}), 0)`,
    callsMade: sql<number>`coalesce(sum(${dailyFunnelMetrics.callsMade}), 0)`,
    replies: sql<number>`coalesce(sum(${dailyFunnelMetrics.replies}), 0)`,
    positiveReplies: sql<number>`coalesce(sum(${dailyFunnelMetrics.positiveReplies}), 0)`,
    meetingsBooked: sql<number>`coalesce(sum(${dailyFunnelMetrics.meetingsBooked}), 0)`,
    statementsReceived: sql<number>`coalesce(sum(${dailyFunnelMetrics.statementsReceived}), 0)`,
    proposalsSent: sql<number>`coalesce(sum(${dailyFunnelMetrics.proposalsSent}), 0)`,
    closedWon: sql<number>`coalesce(sum(${dailyFunnelMetrics.closedWon}), 0)`,
    closedLost: sql<number>`coalesce(sum(${dailyFunnelMetrics.closedLost}), 0)`,
  }).from(dailyFunnelMetrics).where(
    sql`${dailyFunnelMetrics.date} >= ${startDate} AND ${dailyFunnelMetrics.date} <= ${endDate}
        AND ${dailyFunnelMetrics.vertical} IS NULL AND ${dailyFunnelMetrics.state} IS NULL AND ${dailyFunnelMetrics.sourceType} IS NULL`
  );

  const m = metricsRows[0] || {};
  const totalSent = (m.emailsSent || 0) + (m.smsSent || 0) + (m.callsMade || 0);
  const totalContacted = totalSent;

  const bounceData = await db.select({
    totalBounced: sql<number>`coalesce(sum(${identityPerformanceDaily.bounced}), 0)`,
    totalSent: sql<number>`coalesce(sum(${identityPerformanceDaily.emailsSent}), 0)`,
  }).from(identityPerformanceDaily).where(
    sql`${identityPerformanceDaily.date} >= ${startDate} AND ${identityPerformanceDaily.date} <= ${endDate}`
  );

  const bd = bounceData[0] || {};
  const bounceRate = (bd.totalSent || 0) > 0 ? Math.round(((bd.totalBounced || 0) / (bd.totalSent || 1)) * 1000) / 10 : 0;

  const identities = await db.select().from(sendingIdentities);
  const activeIdentities = identities.filter(i => i.isActive);
  const pausedIdentities = identities.filter(i => !i.isActive || i.warmupStatus === "paused");

  const stuckLeads = await db.select({
    count: sql<number>`count(*)`,
  }).from(sdrLeadState).where(
    sql`${sdrLeadState.updatedAt} < ${new Date(Date.now() - 48 * 60 * 60 * 1000)}
        AND ${sdrLeadState.stage} NOT IN ('DEAD', 'CONVERTED', 'TERMINAL_SHIPPED', 'CLOSED_WON', 'BOARDED', 'NURTURE')`
  );

  return {
    range,
    startDate,
    endDate,
    leadsQueued: m.leadsFound || 0,
    emailsSent: m.emailsSent || 0,
    smsSent: m.smsSent || 0,
    callsMade: m.callsMade || 0,
    totalContacted: totalSent,
    replies: m.replies || 0,
    positiveReplies: m.positiveReplies || 0,
    meetingsBooked: m.meetingsBooked || 0,
    statementsRequested: m.statementsReceived || 0,
    proposalsSent: m.proposalsSent || 0,
    closedWon: m.closedWon || 0,
    closedLost: m.closedLost || 0,
    bounceRate,
    replyRate: totalContacted > 0 ? Math.round(((m.replies || 0) / totalContacted) * 1000) / 10 : 0,
    positiveIntentRate: (m.replies || 0) > 0 ? Math.round(((m.positiveReplies || 0) / (m.replies || 1)) * 100) : 0,
    bookedCallRate: totalContacted > 0 ? Math.round(((m.meetingsBooked || 0) / totalContacted) * 1000) / 10 : 0,
    sendSuccessRate: (bd.totalSent || 0) > 0 ? Math.round((((bd.totalSent || 0) - (bd.totalBounced || 0)) / (bd.totalSent || 1)) * 1000) / 10 : 100,
    activeIdentities: activeIdentities.length,
    pausedSystems: pausedIdentities.length,
    stuckLeadsCount: stuckLeads[0]?.count || 0,
  };
}

export async function getSendMonitoringData(): Promise<any> {
  const identities = await db.select().from(sendingIdentities);
  const today = getEstDateString();
  const sevenDaysAgo = getEstDateString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

  const identityStats = await Promise.all(identities.map(async (identity) => {
    const perf = await db.select({
      totalSent: sql<number>`coalesce(sum(${identityPerformanceDaily.emailsSent}), 0)`,
      totalDelivered: sql<number>`coalesce(sum(${identityPerformanceDaily.delivered}), 0)`,
      totalBounced: sql<number>`coalesce(sum(${identityPerformanceDaily.bounced}), 0)`,
      totalReplied: sql<number>`coalesce(sum(${identityPerformanceDaily.replied}), 0)`,
      totalComplaints: sql<number>`coalesce(sum(${identityPerformanceDaily.complaints}), 0)`,
      totalOpened: sql<number>`coalesce(sum(${identityPerformanceDaily.opened}), 0)`,
      totalPositiveReplies: sql<number>`coalesce(sum(${identityPerformanceDaily.positiveReplies}), 0)`,
    }).from(identityPerformanceDaily).where(
      and(
        eq(identityPerformanceDaily.sendingIdentityId, identity.id),
        sql`${identityPerformanceDaily.date} >= ${sevenDaysAgo}`
      )
    );

    const s = perf[0] || {};
    const sent = s.totalSent || 0;

    const warmupStarted = identity.warmupStartedAt ? new Date(identity.warmupStartedAt) : null;
    const warmupDays = warmupStarted ? Math.floor((Date.now() - warmupStarted.getTime()) / (24 * 60 * 60 * 1000)) : 0;
    const warmupProgress = identity.warmupStatus === "warm" ? 100 :
      identity.warmupStatus === "warming" ? Math.min(Math.round((warmupDays / 14) * 100), 99) : 0;

    return {
      id: identity.id,
      label: identity.label,
      domain: identity.domain,
      emailAddress: identity.emailAddress,
      isActive: identity.isActive,
      warmupStatus: identity.warmupStatus,
      warmupProgress,
      warmupDays,
      dailyLimit: identity.dailyLimit || 30,
      sentToday: identity.sentToday || 0,
      bouncesToday: identity.bouncesToday || 0,
      complaintsToday: identity.complaintsToday || 0,
      healthScore: identity.healthScore ?? null,
      capUtilization: (identity.dailyLimit || 30) > 0 ? Math.round(((identity.sentToday || 0) / (identity.dailyLimit || 30)) * 100) : 0,
      week: {
        sent: sent,
        delivered: s.totalDelivered || 0,
        bounced: s.totalBounced || 0,
        replied: s.totalReplied || 0,
        complaints: s.totalComplaints || 0,
        opened: s.totalOpened || 0,
        positiveReplies: s.totalPositiveReplies || 0,
        bounceRate: sent > 0 ? Math.round(((s.totalBounced || 0) / sent) * 1000) / 10 : 0,
        replyRate: sent > 0 ? Math.round(((s.totalReplied || 0) / sent) * 1000) / 10 : 0,
        complaintRate: sent > 0 ? Math.round(((s.totalComplaints || 0) / sent) * 1000) / 10 : 0,
        openRate: sent > 0 ? Math.round(((s.totalOpened || 0) / sent) * 1000) / 10 : 0,
      },
    };
  }));

  const totalSent = identityStats.reduce((s, i) => s + i.sentToday, 0);
  const totalLimit = identityStats.reduce((s, i) => s + i.dailyLimit, 0);

  let smtpFallbacksLast24h = 0;
  let ghlSendsLast24h = 0;
  let recentSends: Array<{ action: string; channel: string; entityId: number | null; sentAt: string }> = [];

  function normalizeChannelLabel(raw: string | null | undefined): string {
    if (!raw) return "Unknown";
    const r = raw.toLowerCase();
    if (r.includes("ghl_workflow") || r.includes("ghl-workflow") || r === "ghl") return "GHL-Workflow";
    if (r.includes("ghl_direct") || r.includes("direct_email") || r.includes("ghl-direct")) return "GHL-Direct";
    if (r.includes("smtp") || r.includes("smtp_fallback") || r.includes("smtp-fallback")) return "SMTP-Fallback";
    if (r.startsWith("ghl")) return "GHL-Workflow";
    return raw;
  }

  let channelCountsAvailable = true;
  try {
    const [smtpRes, ghlRes, recentRes] = await Promise.all([
      db.execute(sql`
        SELECT COUNT(*)::int AS count FROM audit_logs
        WHERE LOWER(details->>'channel') LIKE 'smtp%'
        AND created_at > NOW() - INTERVAL '24 hours'
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS count FROM audit_logs
        WHERE (LOWER(details->>'channel') LIKE 'ghl%')
        AND created_at > NOW() - INTERVAL '24 hours'
      `),
      db.execute(sql`
        SELECT action, entity_id,
          COALESCE(details->>'channel', details->>'method') AS channel,
          created_at
        FROM audit_logs
        WHERE action IN ('proposal_email_sent','merchant_welcome_sent','merchant_portal_welcome_sent','co_branded_proposal_sent')
        ORDER BY created_at DESC
        LIMIT 25
      `),
    ]);
    smtpFallbacksLast24h = Number((smtpRes.rows?.[0] as any)?.count || 0);
    ghlSendsLast24h = Number((ghlRes.rows?.[0] as any)?.count || 0);
    recentSends = (recentRes.rows || []).map((r: any) => ({
      action: r.action,
      channel: normalizeChannelLabel(r.channel),
      entityId: r.entity_id ? Number(r.entity_id) : null,
      sentAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    }));
  } catch (err) {
    // A failed read is unavailable, not zero.
    channelCountsAvailable = false;
    console.error("[SendMonitoring] channel breakdown unavailable:", err instanceof Error ? err.message : "unknown");
  }

  return {
    identities: identityStats,
    aggregated: {
      asOf: new Date().toISOString(),
      scope: "all sending identities; sentToday is the current EST day, channel counts are the trailing 24 hours, recentSends is the latest 25",
      channelCountsAvailable,
      totalIdentities: identities.length,
      activeIdentities: identities.filter(i => i.isActive).length,
      totalSentToday: totalSent,
      totalDailyLimit: totalLimit,
      overallCapUtilization: totalLimit > 0 ? Math.round((totalSent / totalLimit) * 100) : 0,
      smtpFallbacksLast24h: channelCountsAvailable ? smtpFallbacksLast24h : null,
      ghlSendsLast24h: channelCountsAvailable ? ghlSendsLast24h : null,
    },
    recentSends,
  };
}

export async function getWebhookEventLog(options: { eventType?: string; limit?: number }): Promise<any[]> {
  const { eventType, limit = 50 } = options;

  const conditions = [];
  if (eventType) {
    conditions.push(eq(sdrLeadEvents.eventType, eventType));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const events = await db.select({
    event: sdrLeadEvents,
    merchantName: sdrMerchants.businessName,
  })
    .from(sdrLeadEvents)
    .leftJoin(sdrMerchants, eq(sdrLeadEvents.merchantId, sdrMerchants.id))
    .where(where)
    .orderBy(sql`${sdrLeadEvents.createdAt} DESC`)
    .limit(limit);

  return events.map(row => ({
    id: row.event.id,
    eventType: row.event.eventType,
    merchantId: row.event.merchantId,
    businessName: row.merchantName || "Unknown",
    leadStateId: row.event.leadStateId,
    fromStage: row.event.fromStage,
    toStage: row.event.toStage,
    actionType: row.event.actionType,
    channel: row.event.channel,
    actorType: row.event.actorType,
    decisionReason: row.event.decisionReason,
    complianceResult: row.event.complianceResult,
    metadata: row.event.metadata,
    ghlRefId: row.event.ghlRefId,
    createdAt: row.event.createdAt,
    eventAt: row.event.eventAt,
  }));
}

export async function getLowConfidenceClassifications(): Promise<any[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const events = await db.select({
    event: sdrLeadEvents,
    merchantName: sdrMerchants.businessName,
  })
    .from(sdrLeadEvents)
    .leftJoin(sdrMerchants, eq(sdrLeadEvents.merchantId, sdrMerchants.id))
    .where(
      and(
        eq(sdrLeadEvents.eventType, "reply_classified"),
        sql`${sdrLeadEvents.createdAt} >= ${sevenDaysAgo}`
      )
    )
    .orderBy(sql`${sdrLeadEvents.createdAt} DESC`)
    .limit(100);

  return events
    .filter(row => {
      const meta = row.event.metadata as any;
      return meta && typeof meta.confidence === "number" && meta.confidence < 0.7;
    })
    .map(row => {
      const meta = row.event.metadata as any;
      return {
        id: row.event.id,
        merchantId: row.event.merchantId,
        businessName: row.merchantName || "Unknown",
        classifiedIntent: meta?.intent || "unknown",
        confidence: meta?.confidence || 0,
        replyText: meta?.replyText || meta?.message || "",
        channel: row.event.channel,
        createdAt: row.event.createdAt,
      };
    });
}


/**
 * Read-only whole-population event-kind census. Replies, opt-outs, bounces and delivery outcomes are reported
 * separately, with scope/as-of/availability. A failed read is `available:false` with null counts, never zeros.
 */
export async function getSdrEventKindCensus(days = 30): Promise<{
  available: boolean;
  scope: string;
  asOf: string;
  windowDays: number;
  counts: Record<SdrEventKind, number> | null;
  unavailableReason?: string;
}> {
  const asOf = new Date().toISOString();
  const windowDays = Math.max(1, Math.min(365, Math.trunc(days) || 30));
  const scope = `all sdr_lead_events in the trailing ${windowDays} days; kinds are classified separately (reply, opt_out, bounce, delivery_failure, delivery)`;
  try {
    const rows = await db.execute(sql`
      SELECT event_type AS "eventType",
             payload_json->>'status' AS status,
             payload_json->>'deliveryStatus' AS "deliveryStatus",
             payload_json->>'direction' AS direction,
             payload_json->>'body' AS body,
             COUNT(*)::int AS n
        FROM sdr_lead_events
       WHERE created_at >= NOW() - make_interval(days => ${windowDays})
       GROUP BY 1,2,3,4,5`);
    const events = ((rows as any).rows ?? []).map((r: any) => ({
      eventType: r.eventType,
      payloadJson: { status: r.status, deliveryStatus: r.deliveryStatus, direction: r.direction, body: r.body },
      n: Number(r.n),
    }));
    return { available: true, scope, asOf, windowDays, counts: countSdrEventKinds(events) };
  } catch (err) {
    return { available: false, scope, asOf, windowDays, counts: null, unavailableReason: err instanceof Error ? err.message.slice(0, 120) : "read failed" };
  }
}
