import { db, pool } from "./db";
import type { InternalTaskInsert } from "./types/task-types";
import {
  liveChats, liveChatMessages,
  type LiveChat, type InsertLiveChat, type LiveChatMessage, type InsertLiveChatMessage,
  contacts, companies, deals, tickets, tasks, documents, documentAccessLog, auditLogs, notifications, workflowRuns, workflows, rfis, users,
  chargebacks,
  type Chargeback, type InsertChargeback, type UpdateChargebackRequest,
  messageTemplates, collateralPackets, ghlActivityLog, slaConfigs,
  prospects, prospectLists, enrichmentJobs, campaigns, campaignSteps, outboundMessages, notes,
  emailLogs, callLogs, stageAutomationRules, followUpSequences, sequenceSteps, sequenceEnrollments,
  sunbizEntities, consentAuditLogs, calendarEvents,
  merchantApplications, merchantProfiles, equipmentOrders, agents, agentQuotas, agentMerchants, residualReports, merchantResiduals,
  healthAlerts, dealCompetitors, partners, referrals, commissionTiers, knowledgeBase, reviewRequests, testimonialSubmissions, onboardingSteps, midDailyStats, onboardingChecklistItems,
  sdrMerchants, sdrMerchantContacts, sdrLeadState, sdrLeadEvents, sdrChannelAttempts, sdrComplianceState,
  sendingIdentities,
  leadDiscoveryJobs, leadDiscoveryResults,
  type SendingIdentity, type InsertSendingIdentity,
  businesses, businessAliases, businessLocations, leadSources, enrichmentRuns,
  type LeadDiscoveryJob, type InsertLeadDiscoveryJob,
  type LeadDiscoveryResult, type InsertLeadDiscoveryResult,
  type Business, type InsertBusiness, type UpdateBusinessRequest,
  type BusinessAlias, type InsertBusinessAlias,
  type BusinessLocation, type InsertBusinessLocation,
  type LeadSource, type InsertLeadSource,
  type EnrichmentRun, type InsertEnrichmentRun,
  type SdrMerchant, type InsertSdrMerchant,
  type SdrMerchantContact, type InsertSdrMerchantContact,
  type SdrLeadState, type InsertSdrLeadState, type ProcessorEvidence,
  type SdrLeadEvent, type InsertSdrLeadEvent,
  type SdrChannelAttempt, type InsertSdrChannelAttempt,
  type SdrComplianceState, type InsertSdrComplianceState,
  type InsertContact, type UpdateContactRequest,
  type InsertCompany,
  type InsertDeal, type UpdateDealRequest,
  type InsertTicket, type UpdateTicketRequest,
  type InsertTask, type UpdateTaskRequest,
  type InsertDocument, type InsertDocumentAccessLog,
  type InsertAuditLog,
  type InsertNotification,
  type InsertWorkflow, type UpdateWorkflowRequest,
  type InsertWorkflowRun,
  type InsertRfi, type UpdateRfiRequest,
  type InsertMessageTemplate, type MessageTemplate,
  type InsertCollateralPacket,
  type InsertGhlActivityLog,
  type InsertSlaConfig,
  type Prospect, type InsertProspect, type UpdateProspectRequest,
  type InsertProspectList,
  type InsertEnrichmentJob,
  type InsertCampaign, type UpdateCampaignRequest,
  type CampaignPreview, type InsertCampaignPreview,
  type InsertCampaignStep,
  type InsertOutboundMessage, type UpdateOutboundMessageRequest,
  type InsertNote,
  type InsertEmailLog, type InsertCallLog, type InsertStageAutomationRule, type InsertFollowUpSequence, type InsertSequenceStep, type InsertSequenceEnrollment, type AbTestResults,
  type InsertSunbizEntity, type UpdateSunbizEntityRequest, type SunbizEntity,
  type InsertMerchantApplication, type MerchantApplication,
  type InsertMerchantProfile, type MerchantProfile,
  type InsertEquipmentOrder, type EquipmentOrder,
  type InsertAgent, type Agent,
  type InsertAgentMerchant, type AgentMerchant,
  type InsertAgentQuota, type AgentQuota,
  type InsertResidualReport, type ResidualReport,
  type InsertMerchantResidual, type MerchantResidual,
  type InsertHealthAlert, type HealthAlert,
  type InsertDealCompetitor, type DealCompetitor,
  type InsertPartner, type Partner,
  type InsertReferral, type Referral,
  type InsertCommissionTier, type CommissionTier,
  type InsertKnowledgeBaseArticle, type KnowledgeBaseArticle,
  type InsertReviewRequest, type ReviewRequest,
  type InsertTestimonialSubmission, type TestimonialSubmission,
  type InsertOnboardingStep, type OnboardingStep,
  type InsertOnboardingChecklistItem, type OnboardingChecklistItem,
  type InsertConsentAuditLog, type ConsentAuditLog,
  type CalendarEvent, type InsertCalendarEvent,
  systemSettings,
  dataDeleteRequests,
  type DataDeleteRequest, type InsertDataDeleteRequest,
  comments, ticketComments, contactCompanies, pipelineStages, notificationPreferences, savedFilters,
  type Comment, type InsertComment,
  type TicketComment, type InsertTicketComment,
  type ContactCompany, type InsertContactCompany,
  type PipelineStage, type InsertPipelineStage,
  type NotificationPreference, type InsertNotificationPreference,
  type SavedFilter, type InsertSavedFilter,
  csvImports, type CsvImport, type InsertCsvImport,
  generatedBlogPosts,
  type GeneratedBlogPost, type InsertGeneratedBlogPost,
  type UpdateSdrLeadState,
  underwritingRules, underwritingDecisions,
  type UnderwritingRules, type InsertUnderwritingRules,
  type UnderwritingDecision, type InsertUnderwritingDecision,
  ghlWorkflowMappings, type GhlWorkflowMapping,
  npsResponses, type NpsResponse, type InsertNpsResponse,
  merchantReferrals, type MerchantReferral, type InsertMerchantReferral,
  retentionCampaignConfigs, type RetentionCampaignConfig, type InsertRetentionCampaignConfig,
  type MidDailyStat, type InsertMidDailyStat,
  roleplaySessions, type RoleplaySession, type InsertRoleplaySession,
  roleplayExchanges, type RoleplayExchange, type InsertRoleplayExchange,
  leaderboardSettings, type LeaderboardSettings,
  type ChannelAuditLog, type InsertChannelAuditLog,
} from "@shared/schema";
import { eq, desc, and, lt, isNull, ne, sql, asc, gte, lte, inArray, or, ilike, count } from "drizzle-orm";

import { ContactsStorage } from "./storage/contacts";
import { RelationshipsStorage } from "./storage/relationships";
import { DealsStorage } from "./storage/deals";
import { TicketsStorage } from "./storage/tickets";
import { TasksStorage } from "./storage/tasks";
import { DocumentsStorage } from "./storage/documents";
import { AuditStorage } from "./storage/audit";
import { NotificationsStorage } from "./storage/notifications";
import { WorkflowsStorage } from "./storage/workflows";
import { TemplatesStorage } from "./storage/templates";
import { ProspectsStorage } from "./storage/prospects";
import { CampaignsStorage } from "./storage/campaigns";
import { NotesStorage } from "./storage/notes";
import { CommLogsStorage } from "./storage/comm-logs";
import { AutomationStorage } from "./storage/automation";
import { SunbizStorage } from "./storage/sunbiz";
import { MerchantsStorage } from "./storage/merchants";
import { ResidualsStorage } from "./storage/residuals";
import { HealthStorage } from "./storage/health";
import { PartnersStorage } from "./storage/partners";
import { ReviewsStorage } from "./storage/reviews";
import { MiscStorage } from "./storage/misc";
import { RateReviewStorage } from "./storage/rate-review";
import { BusinessesStorage } from "./storage/businesses";
import { SdrStorage } from "./storage/sdr";
import { PartnerOrgsStorage } from "./storage/partner-orgs";
import { ContentStorage } from "./storage/content";
import { ChurnStorage } from "./storage/churn";
import { UnderwritingStorage } from "./storage/underwriting";
import { SystemAuditStorage } from "./storage/system-audit";

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface IStorage {
  getContacts(params?: PaginationParams & { emailStatus?: string }): Promise<PaginatedResult<typeof contacts.$inferSelect>>;
  getContact(id: number): Promise<typeof contacts.$inferSelect | undefined>;
  getContactByGhlContactId(ghlContactId: string): Promise<typeof contacts.$inferSelect | undefined>;
  getContactByEmail(email: string): Promise<typeof contacts.$inferSelect | undefined>;
  getContactByPhone(phone: string): Promise<typeof contacts.$inferSelect | null>;
  getContactByCompanyName(companyName: string): Promise<typeof contacts.$inferSelect | undefined>;
  getContactsByIds(ids: number[]): Promise<typeof contacts.$inferSelect[]>;
  getChildLocations(parentContactId: number): Promise<typeof contacts.$inferSelect[]>;
  getParentAccount(contactId: number): Promise<typeof contacts.$inferSelect | null>;
  getGroupKpis(parentContactId: number): Promise<{ locationCount: number; totalDeals: number; closedWonCount: number; totalVolume: number; activeMids: number; locationIds: number[]; managementType: string }>;
  getContactVerticalCounts(): Promise<Array<{ vertical: string; count: number }>>;
  getContactsByVertical(vertical: string, limit?: number): Promise<Array<{ id: number; firstName: string; lastName: string; email: string; phone: string; vertical: string | null }>>;
  getContactsForCampaignAudience(opts: { verticals?: string[]; minCompletenessScore?: number; limit?: number; offset?: number; afterContactId?: number; maxContactId?: number; readinessThreshold?: number; readinessModelVersion?: number }): Promise<Array<{ id: number; firstName: string; lastName: string; email: string; phone: string | null; vertical: string | null; companyName: string | null; city: string | null; state: string | null; dataCompletenessScore: number | null; emailStatus: string; optedOutEmail: boolean | null }>>;
  countContactsForCampaignAudience(opts?: { verticals?: string[]; minCompletenessScore?: number }): Promise<number>;
  getContactsForReadinessBackfill(afterId: number, limit: number, modelVersion: number): Promise<typeof contacts.$inferSelect[]>;
  getReadinessCategoryBreakdown(opts: { verticals?: string[]; readinessThreshold: number; readinessModelVersion: number }): Promise<{ nullScore: number; staleScore: number; belowThreshold: number }>;
  updateContactReadiness(id: number, score: number, grade: string, breakdown: Record<string, unknown>, modelVersion: number): Promise<void>;
  batchUpdateContactReadiness(batch: Array<{ id: number; score: number; grade: string; breakdown: Record<string, unknown> }>, modelVersion: number): Promise<void>;
  batchUpdateContactReadinessWithOwnershipCheck(runId: string, batch: Array<{ id: number; score: number; grade: string; breakdown: Record<string, unknown> }>, modelVersion: number): Promise<void>;
  createReadinessRun(run: import("@shared/schema").InsertContactReadinessRun): Promise<import("@shared/schema").ContactReadinessRun>;
  getActiveReadinessRun(): Promise<import("@shared/schema").ContactReadinessRun | null>;
  getLatestReadinessRun(): Promise<import("@shared/schema").ContactReadinessRun | null>;
  updateReadinessRun(runId: string, updates: Partial<import("@shared/schema").ContactReadinessRun>): Promise<void>;
  claimReadinessRun(runId: string): Promise<import("@shared/schema").ContactReadinessRun | null>;
  createContact(contact: InsertContact, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<typeof contacts.$inferSelect>;
  updateContact(id: number, contact: UpdateContactRequest, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<typeof contacts.$inferSelect | undefined>;
  syncUpdateContact(id: number, contact: UpdateContactRequest): Promise<typeof contacts.$inferSelect | undefined>;

  getCompanies(): Promise<typeof companies.$inferSelect[]>;
  getCompany(id: number): Promise<typeof companies.$inferSelect | undefined>;
  createCompany(company: InsertCompany): Promise<typeof companies.$inferSelect>;
  updateCompany(id: number, updates: Partial<InsertCompany>): Promise<typeof companies.$inferSelect | undefined>;

  getDeals(params?: PaginationParams): Promise<PaginatedResult<typeof deals.$inferSelect>>;
  getDeal(id: number): Promise<typeof deals.$inferSelect | undefined>;
  getDealByGhlOpportunityId(ghlOpportunityId: string): Promise<typeof deals.$inferSelect | undefined>;
  getDealsByIds(ids: number[]): Promise<typeof deals.$inferSelect[]>;
  getDealsByContactIds(contactIds: number[]): Promise<typeof deals.$inferSelect[]>;
  getDealsByPipeline(pipeline: string, params?: PaginationParams): Promise<PaginatedResult<typeof deals.$inferSelect>>;
  getDealsByContact(contactId: number): Promise<typeof deals.$inferSelect[]>;
  createDeal(deal: InsertDeal, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null },
    existingTx?: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<typeof deals.$inferSelect>;
  updateDeal(id: number, deal: UpdateDealRequest, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<typeof deals.$inferSelect | undefined>;

  getTickets(params?: PaginationParams): Promise<PaginatedResult<typeof tickets.$inferSelect>>;
  getTicket(id: number): Promise<typeof tickets.$inferSelect | undefined>;
  createTicket(ticket: InsertTicket): Promise<typeof tickets.$inferSelect>;
  getTicketsForActor(email: string, params?: PaginationParams): Promise<PaginatedResult<typeof tickets.$inferSelect>>;
  createAuthorityTicket(ticket: InsertTicket, authority?: { producer?: string; commandKey?: string; issueKey?: string; generation?: number },
    existingTx?: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<typeof tickets.$inferSelect>;
  transitionAuthorityTicket(id: number, input: { toState: import("./storage/tasks").TaskAuthorityState; expectedFence: number; producer: string; eventKey: string; commandKey?: string; terminalReason?: string | null; canonicalAssignee?: string | null }): Promise<typeof tickets.$inferSelect | null>;
  updateTicket(id: number, ticket: UpdateTicketRequest): Promise<typeof tickets.$inferSelect | undefined>;

  getTasks(opts?: { limit?: number; offset?: number }): Promise<typeof tasks.$inferSelect[]>;
  getTasksByDeal(dealId: number): Promise<typeof tasks.$inferSelect[]>;
  getTaskById(id: number): Promise<typeof tasks.$inferSelect | null>;
  getTaskByGhlTaskId(ghlTaskId: string): Promise<typeof tasks.$inferSelect | undefined>;
  createTask(task: InternalTaskInsert): Promise<typeof tasks.$inferSelect>;
  createAuthorityTask(task: InternalTaskInsert, authority?: { producer?: string; subjectType?: string; subjectId?: number; generation?: number; commandKey?: string; issueKey?: string; context?: Record<string,unknown>; actorId?:string }, existingTx?: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<typeof tasks.$inferSelect>;
  transitionAuthorityTask(id: number, input: { toState: import("./storage/tasks").TaskAuthorityState; expectedFence: number; producer: string; eventKey: string; commandKey?: string; terminalReason?: string | null; canonicalAssignee?: string | null }): Promise<typeof tasks.$inferSelect | null>;
  assertTaskLinkedObjectScope(input: Pick<InternalTaskInsert, "contactId" | "dealId" | "ticketId">): Promise<void>;
  updateTask(id: number, task: UpdateTaskRequest): Promise<typeof tasks.$inferSelect | undefined>;
  createStallingDealFollowUpTask(payload: Omit<InternalTaskInsert, 'source' | 'automationKey'>): Promise<{ task: typeof tasks.$inferSelect | null; created: boolean }>;
  softDeleteTask(id: number): Promise<void>;
  bulkSoftDeleteTasks(ids: number[]): Promise<number>;

  getDocuments(): Promise<typeof documents.$inferSelect[]>;
  getDocumentsByContact(contactId: number): Promise<typeof documents.$inferSelect[]>;
  getDocumentById(id: number): Promise<typeof documents.$inferSelect | undefined>;
  getDocumentsByIds(ids: number[]): Promise<typeof documents.$inferSelect[]>;
  createDocument(doc: InsertDocument): Promise<typeof documents.$inferSelect>;
  updateDocument(id: number, updates: Partial<InsertDocument>): Promise<typeof documents.$inferSelect | undefined>;
  deleteDocument(id: number): Promise<void>;
  createDocumentAccessLog(entry: InsertDocumentAccessLog): Promise<typeof documentAccessLog.$inferSelect>;

  getAuditLogs(filters?: { entityType?: string; entityId?: number; actorType?: string; actorId?: string; userId?: string; startDate?: Date; endDate?: Date; limit?: number; offset?: number }): Promise<typeof auditLogs.$inferSelect[]>;
  getAuditLogsByActions(actions: readonly string[], opts?: { limit?: number; offset?: number }): Promise<{ rows: typeof auditLogs.$inferSelect[]; total: number; hasMore: boolean }>;
  getAuditLogsByEntity(entityType: string, entityId: number | string, limit?: number): Promise<typeof auditLogs.$inferSelect[]>;
  getLastAuditLogByAction(action: string, entityType: string, entityId: number): Promise<typeof auditLogs.$inferSelect | undefined>;
  createAuditLog(log: InsertAuditLog): Promise<typeof auditLogs.$inferSelect>;
  createChannelAuditLog(entry: InsertChannelAuditLog): Promise<ChannelAuditLog>;
  getChannelAuditLog(channel: string, filters?: { action?: string; actor?: string; startDate?: Date; endDate?: Date; limit?: number; offset?: number }): Promise<{ entries: ChannelAuditLog[]; total: number }>;
  getAiAuditLog(id: number): Promise<import("@shared/schema").AiAuditLog | undefined>;
  getAiAuditLogs(filters?: { triggerType?: string; startDate?: Date; endDate?: Date; limit?: number; offset?: number; flaggedOnly?: boolean }): Promise<import("@shared/schema").AiAuditLog[]>;
  getAiAuditLogTotals(filters?: { startDate?: Date; endDate?: Date }): Promise<{ totalCalls: number; totalPromptTokens: number; totalCompletionTokens: number; totalCostCents: number; byTriggerType: Record<string, { calls: number; promptTokens: number; completionTokens: number; costCents: number }> }>;
  getAiCostDailyRollup(days?: number): Promise<Array<{ date: string; calls: number; costCents: number; promptTokens: number; completionTokens: number }>>;
  getAiCostSummary(startDate?: Date, endDate?: Date): Promise<{ todayCostCents: number; todayCalls: number; monthCostCents: number; monthCalls: number; rangeCostCents: number; rangeCalls: number; byTriggerType: Record<string, { calls: number; costCents: number; promptTokens: number; completionTokens: number }> }>;
  getAiHealthMetrics(startDate?: Date, endDate?: Date): Promise<{ totalCalls: number; successCalls: number; errorCalls: number; completionRate: number; avgLatencyMs: number; avgConfidenceScore: number; flaggedCount: number; flaggedRate: number; topErrors: Array<{ error: string; count: number }>; byTriggerType: Record<string, { calls: number; errors: number; avgConfidence: number; avgLatencyMs: number; flagged: number }>; confidenceDistribution: { high: number; medium: number; low: number }; totalCostCents: number; todayCostCents: number; monthCostCents: number; dailyRollup: Array<{ date: string; calls: number; costCents: number; promptTokens: number; completionTokens: number }>; confidenceThreshold: number }>;

  getNotifications(): Promise<typeof notifications.$inferSelect[]>;
  getNotificationsPaginated(params: { limit: number; offset: number; category?: string; userId?: string }): Promise<{ data: typeof notifications.$inferSelect[]; total: number }>;
  getNotificationsUnreadCount(userId?: string): Promise<number>;
  createNotification(notification: InsertNotification): Promise<typeof notifications.$inferSelect>;
  markNotificationRead(id: number,userId?:string): Promise<number>;
  deleteNotification(id: number, userId?: string): Promise<boolean>;
  clearOldReadNotifications(userId?: string): Promise<number>;

  getWorkflows(): Promise<typeof workflows.$inferSelect[]>;
  getWorkflow(id: number): Promise<typeof workflows.$inferSelect | undefined>;
  createWorkflow(workflow: InsertWorkflow): Promise<typeof workflows.$inferSelect>;
  updateWorkflow(id: number, workflow: UpdateWorkflowRequest): Promise<typeof workflows.$inferSelect | undefined>;
  deleteWorkflow(id: number): Promise<void>;
  getWorkflowsByTrigger(triggerType: string): Promise<typeof workflows.$inferSelect[]>;

  getWorkflowRuns(): Promise<typeof workflowRuns.$inferSelect[]>;
  getWorkflowRun(id: number): Promise<typeof workflowRuns.$inferSelect | undefined>;
  getWorkflowRunsByWorkflow(workflowId: number): Promise<typeof workflowRuns.$inferSelect[]>;
  createWorkflowRun(run: InsertWorkflowRun): Promise<typeof workflowRuns.$inferSelect>;
  updateWorkflowRun(id: number, updates: Partial<InsertWorkflowRun>): Promise<typeof workflowRuns.$inferSelect | undefined>;

  getRfis(): Promise<typeof rfis.$inferSelect[]>;
  getRfi(id: number): Promise<typeof rfis.$inferSelect | undefined>;
  createRfi(rfi: InsertRfi): Promise<typeof rfis.$inferSelect>;
  updateRfi(id: number, rfi: UpdateRfiRequest): Promise<typeof rfis.$inferSelect | undefined>;

  getReviewQueue(status?: string): Promise<import("@shared/schema").ReviewQueueItem[]>;
  getReviewQueuePendingCount(): Promise<number>;
  getReviewQueueAggregates(): Promise<{ pending: number; approved: number; total: number }>;
  getReviewQueueItem(id: number): Promise<import("@shared/schema").ReviewQueueItem | undefined>;
  createReviewQueueItem(data: import("@shared/schema").InsertReviewQueueItem): Promise<import("@shared/schema").ReviewQueueItem>;
  updateReviewQueueItem(id: number, updates: Partial<import("@shared/schema").InsertReviewQueueItem>): Promise<import("@shared/schema").ReviewQueueItem | undefined>;
  getDeadLetterEventHistory(opts: { snapshotId: number; afterId?: number; limit?: number }): Promise<Array<{ id: number; source_type: "dead_letter_job"; source_id: number; status: string; event: import("./services/audit-sanitizer").DeadLetterEventSnapshot; created_at: string | Date | null | undefined }>>;
  getDeadLetterEventSnapshotId(): Promise<number>;

  getMessageTemplates(): Promise<typeof messageTemplates.$inferSelect[]>;
  getMessageTemplate(id: number): Promise<typeof messageTemplates.$inferSelect | undefined>;
  getMessageTemplatesByCategory(category: string): Promise<typeof messageTemplates.$inferSelect[]>;
  createMessageTemplate(template: InsertMessageTemplate): Promise<typeof messageTemplates.$inferSelect>;
  updateMessageTemplate(id: number, updates: Partial<InsertMessageTemplate>): Promise<typeof messageTemplates.$inferSelect | undefined>;

  getCollateralPackets(): Promise<typeof collateralPackets.$inferSelect[]>;
  createCollateralPacket(packet: InsertCollateralPacket): Promise<typeof collateralPackets.$inferSelect>;

  getGhlActivityLogs(contactId?: number): Promise<typeof ghlActivityLog.$inferSelect[]>;
  createGhlActivityLog(log: InsertGhlActivityLog): Promise<typeof ghlActivityLog.$inferSelect>;

  getSlaConfigs(): Promise<typeof slaConfigs.$inferSelect[]>;
  createSlaConfig(config: InsertSlaConfig): Promise<typeof slaConfigs.$inferSelect>;
  updateSlaConfig(id: number, updates: Partial<InsertSlaConfig>): Promise<typeof slaConfigs.$inferSelect | undefined>;

  getDealsStuckInStage(stage: string, maxMinutes: number): Promise<typeof deals.$inferSelect[]>;
  getTicketsBreachingSla(): Promise<typeof tickets.$inferSelect[]>;

  getProspectLists(opts?: { includeArchived?: boolean }): Promise<typeof prospectLists.$inferSelect[]>;
  getProspectList(id: number): Promise<typeof prospectLists.$inferSelect | undefined>;
  createProspectList(list: InsertProspectList): Promise<typeof prospectLists.$inferSelect>;
  updateProspectList(id: number, updates: Partial<InsertProspectList>): Promise<typeof prospectLists.$inferSelect | undefined>;
  archiveProspectList(id: number, reason: string): Promise<typeof prospectLists.$inferSelect | undefined>;
  archiveDemoData(): Promise<{ listsArchived: number; archivedListNames: string[] }>;

  getProspects(listId?: number, params?: PaginationParams, filters?: import("./storage/prospects").ProspectListFilters): Promise<PaginatedResult<typeof prospects.$inferSelect>>;
  getProspectVerticals(listId?: number): Promise<string[]>;
  getProspect(id: number): Promise<typeof prospects.$inferSelect | undefined>;
  createProspect(prospect: InsertProspect): Promise<typeof prospects.$inferSelect>;
  createProspectsBulk(prospectData: InsertProspect[]): Promise<Prospect[]>;
  createProspectsBulkIdempotent(prospectData: InsertProspect[]): Promise<{ inserted: number }>;
  getProspectListByHash(importType: string, fileHash: string): Promise<typeof prospectLists.$inferSelect | null>;
  getExistingProspectEmailsChunked(emails: string[]): Promise<Set<string>>;
  updateProspect(id: number, updates: UpdateProspectRequest): Promise<typeof prospects.$inferSelect | undefined>;
  getProspectsByStatus(status: string): Promise<typeof prospects.$inferSelect[]>;
  getProspectsByScore(score: string): Promise<typeof prospects.$inferSelect[]>;

  getEnrichmentJobs(listId?: number): Promise<typeof enrichmentJobs.$inferSelect[]>;
  createEnrichmentJob(job: InsertEnrichmentJob): Promise<typeof enrichmentJobs.$inferSelect>;
  updateEnrichmentJob(id: number, updates: Partial<InsertEnrichmentJob>): Promise<typeof enrichmentJobs.$inferSelect | undefined>;
  getPendingEnrichmentJobs(limit?: number): Promise<typeof enrichmentJobs.$inferSelect[]>;

  getCampaigns(): Promise<typeof campaigns.$inferSelect[]>;
  getCampaign(id: number): Promise<typeof campaigns.$inferSelect | undefined>;
  createCampaign(campaign: InsertCampaign): Promise<typeof campaigns.$inferSelect>;
  updateCampaign(id: number, updates: UpdateCampaignRequest): Promise<typeof campaigns.$inferSelect | undefined>;

  createCampaignPreview(data: InsertCampaignPreview): Promise<CampaignPreview>;
  getCampaignPreview(id: number): Promise<CampaignPreview | undefined>;
  getLatestCampaignPreview(campaignId: number): Promise<CampaignPreview | undefined>;
  updateCampaignPreview(id: number, updates: Partial<CampaignPreview>): Promise<CampaignPreview>;
  markInterruptedCampaignPreviews(): Promise<void>;
  consumeCampaignPreviewAtomic(id: number): Promise<CampaignPreview | null>;

  getCampaignSteps(campaignId: number): Promise<typeof campaignSteps.$inferSelect[]>;
  getCampaignStep(id: number): Promise<typeof campaignSteps.$inferSelect | undefined>;
  createCampaignStep(step: InsertCampaignStep): Promise<typeof campaignSteps.$inferSelect>;
  updateCampaignStep(id: number, updates: Partial<InsertCampaignStep>): Promise<typeof campaignSteps.$inferSelect | undefined>;
  deleteCampaignStep(id: number): Promise<void>;

  getOutboundMessages(campaignId?: number): Promise<typeof outboundMessages.$inferSelect[]>;
  getOutboundMessage(id: number): Promise<typeof outboundMessages.$inferSelect | undefined>;
  createOutboundMessage(msg: InsertOutboundMessage): Promise<typeof outboundMessages.$inferSelect>;
  createOutboundMessagesBulk(msgs: InsertOutboundMessage[]): Promise<typeof outboundMessages.$inferSelect[]>;
  updateOutboundMessage(id: number, updates: UpdateOutboundMessageRequest): Promise<typeof outboundMessages.$inferSelect | undefined>;
  claimOutboundMessageForSending(id: number): Promise<boolean>;
  getQueuedMessages(limit: number): Promise<typeof outboundMessages.$inferSelect[]>;
  markStaleInFlightMessagesFailed(): Promise<number>;
  getOutboundStats(campaignId: number): Promise<{sent: number, opened: number, replied: number, bounced: number}>;

  getNotes(entityType: string, entityId: number): Promise<typeof notes.$inferSelect[]>;
  getNote(id: number): Promise<typeof notes.$inferSelect | undefined>;
  createNote(note: InsertNote): Promise<typeof notes.$inferSelect>;
  updateNote(id: number, content: string): Promise<void>; // #243
  deleteNote(id: number): Promise<void>;

  getEmailLogs(contactId?: number): Promise<typeof emailLogs.$inferSelect[]>;
  getEmailLogsByStepId(stepId: number): Promise<typeof emailLogs.$inferSelect[]>;
  getEmailLogsByContactId(contactId: number): Promise<typeof emailLogs.$inferSelect[]>;
  getEmailLogsByContactIds(contactIds: number[]): Promise<typeof emailLogs.$inferSelect[]>;
  createEmailLog(log: InsertEmailLog): Promise<typeof emailLogs.$inferSelect>;
  updateEmailLog(id: number, updates: Partial<InsertEmailLog>): Promise<typeof emailLogs.$inferSelect | undefined>;

  getCallLogs(contactId?: number): Promise<typeof callLogs.$inferSelect[]>;
  getCallLogsByContactIds(contactIds: number[]): Promise<typeof callLogs.$inferSelect[]>;
  createCallLog(log: InsertCallLog): Promise<typeof callLogs.$inferSelect>;

  getStageAutomationRules(pipeline?: string): Promise<typeof stageAutomationRules.$inferSelect[]>;
  getStageAutomationRule(id: number): Promise<typeof stageAutomationRules.$inferSelect | undefined>;
  createStageAutomationRule(rule: InsertStageAutomationRule): Promise<typeof stageAutomationRules.$inferSelect>;
  updateStageAutomationRule(id: number, updates: Partial<InsertStageAutomationRule>): Promise<typeof stageAutomationRules.$inferSelect | undefined>;
  deleteStageAutomationRule(id: number): Promise<void>;
  getMatchingStageRules(pipeline: string, fromStage: string | null, toStage: string): Promise<typeof stageAutomationRules.$inferSelect[]>;

  getFollowUpSequences(): Promise<typeof followUpSequences.$inferSelect[]>;
  getFollowUpSequence(id: number): Promise<typeof followUpSequences.$inferSelect | undefined>;
  createFollowUpSequence(seq: InsertFollowUpSequence): Promise<typeof followUpSequences.$inferSelect>;
  updateFollowUpSequence(id: number, updates: Partial<InsertFollowUpSequence>): Promise<typeof followUpSequences.$inferSelect | undefined>;
  deleteFollowUpSequence(id: number): Promise<void>;

  getSequenceSteps(sequenceId: number): Promise<typeof sequenceSteps.$inferSelect[]>;
  createSequenceStep(step: InsertSequenceStep): Promise<typeof sequenceSteps.$inferSelect>;
  updateSequenceStep(id: number, updates: Partial<InsertSequenceStep>): Promise<typeof sequenceSteps.$inferSelect | undefined>;
  updateSequenceStepAbTestResults(id: number, results: AbTestResults): Promise<typeof sequenceSteps.$inferSelect | undefined>;
  deleteSequenceStep(id: number): Promise<void>;

  getSequenceEnrollments(sequenceId?: number): Promise<typeof sequenceEnrollments.$inferSelect[]>;
  getContactEnrollments(contactId: number): Promise<typeof sequenceEnrollments.$inferSelect[]>;
  getContactEnrollmentsForContacts(contactIds: number[], sequenceIds?: number[]): Promise<typeof sequenceEnrollments.$inferSelect[]>;
  getFollowUpSequencesByIds(sequenceIds: number[]): Promise<typeof followUpSequences.$inferSelect[]>;
  getSequenceStepsForSequences(sequenceIds: number[]): Promise<typeof sequenceSteps.$inferSelect[]>;
  createSequenceEnrollment(enrollment: InsertSequenceEnrollment): Promise<typeof sequenceEnrollments.$inferSelect | null>;
  updateSequenceEnrollment(id: number, updates: Partial<InsertSequenceEnrollment>): Promise<typeof sequenceEnrollments.$inferSelect | undefined>;
  cancelSequenceEnrollment(sequenceId: number, contactId: number): Promise<typeof sequenceEnrollments.$inferSelect | null>;
  getActiveEnrollments(): Promise<typeof sequenceEnrollments.$inferSelect[]>;
  pauseAllActiveEnrollments(contactId: number): Promise<number>;

  getSunbizEntities(listId?: number, params?: PaginationParams): Promise<PaginatedResult<SunbizEntity>>;
  getSunbizEntity(id: number): Promise<SunbizEntity | undefined>;
  getSunbizEntityByFiling(filingNumber: string): Promise<SunbizEntity | undefined>;
  createSunbizEntity(entity: InsertSunbizEntity): Promise<SunbizEntity>;
  createSunbizEntitiesBulk(entities: InsertSunbizEntity[]): Promise<SunbizEntity[]>;
  upsertSunbizEntitiesBulk(entities: InsertSunbizEntity[]): Promise<{ inserted: number; updated: number }>;
  updateSunbizEntity(id: number, updates: UpdateSunbizEntityRequest): Promise<SunbizEntity | undefined>;
  updateSunbizEntityByFilingNumber(filingNumber: string, updates: UpdateSunbizEntityRequest): Promise<SunbizEntity | undefined>;
  bulkUpdateSunbizEntitiesByFiling(updates: Array<{ filingNumber: string; data: UpdateSunbizEntityRequest }>): Promise<number>;
  bulkUpsertSunbizEntities(records: Array<{
    filingNumber: string; entityName: string; feiEinNumber?: string; entityType?: string;
    entityStatus?: string; filingDate?: string; lastEvent?: string;
    principalAddress?: string; principalCity?: string; principalState?: string; principalZip?: string;
    mailingAddress?: string; registeredAgentName?: string; registeredAgentAddress?: string;
    officers?: any; ownerName?: string; enrichmentData?: any; listId?: number; source?: string;
  }>): Promise<{ inserted: number; updated: number }>;
  getSunbizEntitiesByStatus(status: string, limit?: number): Promise<SunbizEntity[]>;
  getSunbizEntitiesForAIClassification(limit?: number): Promise<SunbizEntity[]>;
  getSunbizEntitiesNeedingEnrichment(limit?: number): Promise<SunbizEntity[]>;
  getSunbizEnrichmentDashboard(): Promise<any>;
  getSunbizDuplicates(limit?: number): Promise<Array<{ entityName: string; count: number; ids: number[] }>>;
  mergeSunbizDuplicates(keepId: number, mergeIds: number[]): Promise<boolean>;
  resetStuckProcessingEntities(): Promise<number>;
  searchSunbizEntitiesByNameCity(name: string, city?: string): Promise<SunbizEntity[]>;
  getSunbizStats(listId?: number): Promise<{total: number, enriched: number, pending: number, withEmail: number, withPhone: number, withWebsite: number, withContactInfo: number}>;

  getMerchantApplications(): Promise<MerchantApplication[]>;
  getMerchantApplication(id: number): Promise<MerchantApplication | undefined>;
  getMerchantApplicationByUser(userId: string): Promise<MerchantApplication | undefined>;

  getMerchantProfiles(): Promise<MerchantProfile[]>;
  getMerchantProfile(id: number): Promise<MerchantProfile | undefined>;
  getMerchantProfileByUser(userId: string): Promise<MerchantProfile | undefined>;
  createMerchantProfile(profile: InsertMerchantProfile): Promise<MerchantProfile>;
  updateMerchantProfile(id: number, updates: Partial<InsertMerchantProfile>): Promise<MerchantProfile | undefined>;

  getEquipmentOrders(dealId?: number): Promise<EquipmentOrder[]>;
  getEquipmentOrder(id: number): Promise<EquipmentOrder | undefined>;
  getEquipmentOrdersByDeal(dealId: number): Promise<EquipmentOrder[]>;
  createEquipmentOrder(order: InsertEquipmentOrder): Promise<EquipmentOrder>;
  updateEquipmentOrder(id: number, updates: Partial<InsertEquipmentOrder>): Promise<EquipmentOrder | undefined>;

  getEquipmentModels(activeOnly?: boolean): Promise<import("@shared/schema").EquipmentModel[]>;
  getEquipmentModel(id: number): Promise<import("@shared/schema").EquipmentModel | undefined>;
  getEquipmentModelByName(name: string): Promise<import("@shared/schema").EquipmentModel | undefined>;
  createEquipmentModel(model: import("@shared/schema").InsertEquipmentModel): Promise<import("@shared/schema").EquipmentModel>;
  updateEquipmentModel(id: number, updates: Partial<import("@shared/schema").InsertEquipmentModel>): Promise<import("@shared/schema").EquipmentModel | undefined>;
  deleteEquipmentModel(id: number): Promise<void>;

  getAgents(): Promise<Agent[]>;
  getAgent(id: number): Promise<Agent | undefined>;
  createAgent(agent: InsertAgent): Promise<Agent>;
  updateAgent(id: number, updates: Partial<InsertAgent>): Promise<Agent | undefined>;

  getAgentMerchants(agentId?: number): Promise<AgentMerchant[]>;
  getAgentMerchant(id: number): Promise<AgentMerchant | undefined>;
  assignMerchantToAgent(data: InsertAgentMerchant): Promise<AgentMerchant>;
  updateAgentMerchant(id: number, updates: Partial<InsertAgentMerchant>): Promise<AgentMerchant | undefined>;
  unassignMerchantFromAgent(id: number): Promise<void>;
  getAgentMerchantsByDeal(dealId: number): Promise<AgentMerchant[]>;

  getResidualReports(): Promise<ResidualReport[]>;
  getResidualReport(id: number): Promise<ResidualReport | undefined>;
  getResidualReportsByMonth(month: string): Promise<ResidualReport[]>;
  createResidualReport(report: InsertResidualReport, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<ResidualReport>;

  getMerchantResiduals(reportId?: number): Promise<MerchantResidual[]>;
  getMerchantResidual(id: number): Promise<MerchantResidual | undefined>;
  getMerchantResidualsByDeal(dealId: number): Promise<MerchantResidual[]>;
  getMerchantResidualsByMonth(month: string): Promise<MerchantResidual[]>;
  createMerchantResidual(residual: InsertMerchantResidual): Promise<MerchantResidual>;

  getHealthAlerts(): Promise<HealthAlert[]>;
  getHealthAlert(id: number): Promise<HealthAlert | undefined>;
  getHealthAlertsByDeal(dealId: number): Promise<HealthAlert[]>;
  getActiveHealthAlerts(): Promise<HealthAlert[]>;
  createHealthAlert(alert: InsertHealthAlert): Promise<HealthAlert>;
  updateHealthAlert(id: number, updates: Partial<InsertHealthAlert>): Promise<HealthAlert | undefined>;

  getDealCompetitors(dealId?: number): Promise<DealCompetitor[]>;
  getDealCompetitor(id: number): Promise<DealCompetitor | undefined>;
  getDealCompetitorsByDeal(dealId: number): Promise<DealCompetitor[]>;
  createDealCompetitor(competitor: InsertDealCompetitor): Promise<DealCompetitor>;
  updateDealCompetitor(id: number, updates: Partial<InsertDealCompetitor>): Promise<DealCompetitor | undefined>;

  getPartners(): Promise<Partner[]>;
  getPartner(id: number): Promise<Partner | undefined>;
  getPartnerByCode(code: string): Promise<Partner | undefined>;
  getPartnerByEmail(email: string): Promise<Partner | undefined>;
  createPartner(partner: InsertPartner): Promise<Partner>;
  updatePartner(id: number, updates: Partial<InsertPartner>): Promise<Partner | undefined>;
  incrementPartnerClicks(code: string): Promise<void>;
  updatePartnerPassword(id: number, passwordHash: string): Promise<void>;

  getReferrals(partnerId?: number): Promise<Referral[]>;
  getReferral(id: number): Promise<Referral | undefined>;
  getReferralsByPartner(partnerId: number): Promise<Referral[]>;
  createReferral(referral: InsertReferral): Promise<Referral>;
  getMerchantOnboardingStages(dealId: number): Promise<typeof import("@shared/schema").merchantOnboardingStages.$inferSelect[]>;
  initializeMerchantOnboardingStages(dealId: number): Promise<typeof import("@shared/schema").merchantOnboardingStages.$inferSelect[]>;
  upsertMerchantOnboardingStage(dealId: number, stageKey: string, updates: Record<string, any>): Promise<typeof import("@shared/schema").merchantOnboardingStages.$inferSelect>;
  updateReferral(id: number, updates: Partial<InsertReferral>): Promise<Referral | undefined>;

  getCommissionTiers(): Promise<CommissionTier[]>;
  createCommissionTier(tier: InsertCommissionTier, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<CommissionTier>;
  updateCommissionTier(id: number, updates: Partial<InsertCommissionTier>, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<CommissionTier | undefined>;
  deleteCommissionTier(id: number, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<void>;
  getAffiliateLeaderboard(): Promise<Partner[]>;

  getKnowledgeBaseArticles(): Promise<KnowledgeBaseArticle[]>;
  getKnowledgeBaseArticle(id: number): Promise<KnowledgeBaseArticle | undefined>;
  getKnowledgeBaseByCategory(category: string): Promise<KnowledgeBaseArticle[]>;
  getPublishedArticles(): Promise<KnowledgeBaseArticle[]>;
  createKnowledgeBaseArticle(article: InsertKnowledgeBaseArticle): Promise<KnowledgeBaseArticle>;
  updateKnowledgeBaseArticle(id: number, updates: Partial<InsertKnowledgeBaseArticle>): Promise<KnowledgeBaseArticle | undefined>;

  getReviewRequests(dealId?: number): Promise<ReviewRequest[]>;
  getReviewRequest(id: number): Promise<ReviewRequest | undefined>;
  getReviewRequestsByDeal(dealId: number): Promise<ReviewRequest[]>;
  createReviewRequest(request: InsertReviewRequest): Promise<ReviewRequest>;
  updateReviewRequest(id: number, updates: Partial<InsertReviewRequest>): Promise<ReviewRequest | undefined>;

  getTestimonialSubmissions(status?: string): Promise<TestimonialSubmission[]>;
  getTestimonialSubmission(id: number): Promise<TestimonialSubmission | undefined>;
  getPublishedTestimonialSubmissions(): Promise<TestimonialSubmission[]>;
  createTestimonialSubmission(submission: InsertTestimonialSubmission): Promise<TestimonialSubmission>;
  updateTestimonialSubmission(id: number, updates: Partial<InsertTestimonialSubmission>): Promise<TestimonialSubmission | undefined>;

  getNpsResponses(): Promise<NpsResponse[]>;
  getNpsResponse(id: number): Promise<NpsResponse | undefined>;
  getNpsResponseByToken(token: string): Promise<NpsResponse | undefined>;
  getNpsResponsesByContact(contactId: number): Promise<NpsResponse[]>;
  createNpsResponse(response: InsertNpsResponse): Promise<NpsResponse>;
  updateNpsResponse(id: number, updates: Partial<InsertNpsResponse>): Promise<NpsResponse | undefined>;
  getNpsStats(): Promise<import("../shared/nps-observation").NpsStatsRead>;

  getMerchantReferrals(referrerProfileId?: number): Promise<MerchantReferral[]>;
  getMerchantReferral(id: number): Promise<MerchantReferral | undefined>;
  getMerchantReferralsByCode(code: string): Promise<MerchantReferral[]>;
  createMerchantReferral(referral: InsertMerchantReferral): Promise<MerchantReferral>;
  updateMerchantReferral(id: number, updates: Partial<InsertMerchantReferral>): Promise<MerchantReferral | undefined>;

  getRetentionCampaignConfigs(): Promise<RetentionCampaignConfig[]>;
  getRetentionCampaignConfig(id: number): Promise<RetentionCampaignConfig | undefined>;
  getRetentionCampaignConfigByAlertType(alertType: string): Promise<RetentionCampaignConfig | undefined>;
  createRetentionCampaignConfig(config: InsertRetentionCampaignConfig): Promise<RetentionCampaignConfig>;
  updateRetentionCampaignConfig(id: number, updates: Partial<InsertRetentionCampaignConfig>): Promise<RetentionCampaignConfig | undefined>;
  deleteRetentionCampaignConfig(id: number): Promise<boolean>;

  getMidDailyStats(mid?: string): Promise<MidDailyStat[]>;
  getMidDailyStatsByDeal(dealId: number, days?: number): Promise<MidDailyStat[]>;
  getMidDailyStatByMidAndDate(mid: string, date: string): Promise<MidDailyStat | undefined>;
  createMidDailyStat(stat: InsertMidDailyStat): Promise<MidDailyStat>;
  updateMidDailyStat(id: number, updates: Partial<InsertMidDailyStat>): Promise<MidDailyStat | undefined>;
  upsertMidDailyStat(stat: InsertMidDailyStat): Promise<MidDailyStat>;

  getOnboardingSteps(dealId?: number): Promise<OnboardingStep[]>;
  getOnboardingStep(id: number): Promise<OnboardingStep | undefined>;
  getOnboardingStepsByDeal(dealId: number): Promise<OnboardingStep[]>;
  getOnboardingStepsByApplication(applicationId: number): Promise<OnboardingStep[]>;
  createOnboardingStep(step: InsertOnboardingStep, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<OnboardingStep>;
  updateOnboardingStep(id: number, updates: Partial<InsertOnboardingStep>, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<OnboardingStep | undefined>;

  getOnboardingChecklistItems(dealId: number): Promise<OnboardingChecklistItem[]>;
  getOnboardingChecklistItem(dealId: number, itemKey: string): Promise<OnboardingChecklistItem | undefined>;
  upsertOnboardingChecklistItem(item: InsertOnboardingChecklistItem): Promise<OnboardingChecklistItem>;
  updateOnboardingChecklistItemStatus(dealId: number, itemKey: string, status: string, documentId?: number | null, notes?: string | null): Promise<OnboardingChecklistItem | undefined>;
  initializeOnboardingChecklist(dealId: number,
    existingTx?: Parameters<Parameters<typeof db.transaction>[0]>[0]): Promise<OnboardingChecklistItem[]>;
  getOnboardingKpis(): Promise<{ totalActive: number; pendingDocs: number; overdueItems: number; completedThisMonth: number }>;

  getConsentAuditLogs(): Promise<ConsentAuditLog[]>;
  getConsentAuditLogsByContact(contactId: number): Promise<ConsentAuditLog[]>;
  createConsentAuditLog(log: InsertConsentAuditLog): Promise<ConsentAuditLog>;

  getCalendarEvents(): Promise<CalendarEvent[]>;
  getCalendarEventsByDateRange(start: Date, end: Date): Promise<CalendarEvent[]>;
  createCalendarEvent(event: InsertCalendarEvent): Promise<CalendarEvent>;
  updateCalendarEvent(id: number, data: Partial<InsertCalendarEvent>): Promise<CalendarEvent | undefined>;
  deleteCalendarEvent(id: number): Promise<void>;

  getAgentQuotas(): Promise<AgentQuota[]>;
  getAgentQuotasByAgent(agentId: number): Promise<AgentQuota[]>;
  createAgentQuota(quota: InsertAgentQuota): Promise<AgentQuota>;
  updateAgentQuota(id: number, data: Partial<AgentQuota>): Promise<AgentQuota | undefined>;

  getDataDeleteRequests(): Promise<DataDeleteRequest[]>;
  createDataDeleteRequest(req: InsertDataDeleteRequest): Promise<DataDeleteRequest>;
  updateDataDeleteRequest(id: number, data: Partial<DataDeleteRequest>): Promise<DataDeleteRequest | undefined>;

  getComments(entityType: string, entityId: number): Promise<Comment[]>;
  createComment(comment: InsertComment): Promise<Comment>;
  deleteComment(id: number): Promise<void>;
  updateComment(id: number, updates: Partial<InsertComment>): Promise<Comment | undefined>;

  getTicketComments(ticketId: number): Promise<TicketComment[]>;
  createTicketComment(comment: InsertTicketComment): Promise<TicketComment>;

  getContactCompanies(contactId: number): Promise<ContactCompany[]>;
  getContactCompaniesByCompany(companyId: number): Promise<ContactCompany[]>;
  addContactCompany(link: InsertContactCompany): Promise<ContactCompany>;
  removeContactCompany(id: number): Promise<void>;

  getPipelineStages(pipeline?: string): Promise<PipelineStage[]>;
  createPipelineStage(stage: InsertPipelineStage): Promise<PipelineStage>;
  updatePipelineStage(id: number, updates: Partial<InsertPipelineStage>): Promise<PipelineStage | undefined>;
  deletePipelineStage(id: number): Promise<void>;

  getNotificationPreferences(userId: string): Promise<NotificationPreference[]>;
  upsertNotificationPreference(pref: InsertNotificationPreference): Promise<NotificationPreference>;
  getUsersByRole(roles: string[]): Promise<{ id: string; email: string | null; role: string | null; firstName: string | null; lastName: string | null }[]>;
  getAllNotificationPreferencesByEvent(eventType: string): Promise<NotificationPreference[]>;

  getSavedFilters(userId: string, entityType?: string): Promise<SavedFilter[]>;
  createSavedFilter(filter: InsertSavedFilter): Promise<SavedFilter>;
  deleteSavedFilter(id: number): Promise<void>;

  archiveContact(id: number, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<typeof contacts.$inferSelect | undefined>;
  restoreContact(id: number, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<typeof contacts.$inferSelect | undefined>;
  archiveDeal(id: number, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<typeof deals.$inferSelect | undefined>;
  restoreDeal(id: number, auditCtx?: { userId?: string | null; actorType?: string; actorId?: string | null }): Promise<typeof deals.$inferSelect | undefined>;

  markAllNotificationsRead(userId?: string): Promise<number>;
  clearAllNotifications(userId?: string): Promise<number>;
  bulkAssignTasks(taskIds: number[], assignedTo: string): Promise<void>;
  deleteTask(id: number): Promise<void>;

  getCsvImports(): Promise<CsvImport[]>;
  getCsvImport(id: number): Promise<CsvImport | undefined>;
  createCsvImport(importData: InsertCsvImport): Promise<CsvImport>;
  updateCsvImport(id: number, updates: Partial<InsertCsvImport>): Promise<CsvImport | undefined>;

  getBusinesses(filters?: { status?: string; vertical?: string; limit?: number }): Promise<Business[]>;
  getBusiness(id: number): Promise<Business | undefined>;
  getBusinessByDomain(domain: string): Promise<Business | undefined>;
  getBusinessByNormalizedNameCity(normalizedName: string, city: string | null, state: string | null): Promise<Business | undefined>;
  findOrCreateBusinessForMerchant(domain: string | null, canonicalName: string, city: string | null, state: string | null): Promise<Business | null>;
  createBusiness(data: InsertBusiness): Promise<Business>;
  updateBusiness(id: number, updates: UpdateBusinessRequest): Promise<Business | undefined>;

  getBusinessAliases(businessId: number): Promise<BusinessAlias[]>;
  createBusinessAlias(alias: InsertBusinessAlias): Promise<BusinessAlias>;

  getBusinessLocations(businessId: number): Promise<BusinessLocation[]>;
  createBusinessLocation(location: InsertBusinessLocation): Promise<BusinessLocation>;
  updateBusinessLocation(id: number, updates: Partial<InsertBusinessLocation>): Promise<BusinessLocation | undefined>;

  getLeadSources(businessId?: number): Promise<LeadSource[]>;
  createLeadSource(source: InsertLeadSource): Promise<LeadSource>;
  getLeadSourcesByBatch(batchId: string): Promise<LeadSource[]>;

  getEnrichmentRuns(businessId?: number): Promise<EnrichmentRun[]>;
  createEnrichmentRun(run: InsertEnrichmentRun): Promise<EnrichmentRun>;
  updateEnrichmentRun(id: number, updates: Partial<InsertEnrichmentRun>): Promise<EnrichmentRun | undefined>;

  getSdrMerchants(params?: PaginationParams): Promise<PaginatedResult<SdrMerchant>>;
  getSdrMerchant(id: number): Promise<SdrMerchant | undefined>;
  createSdrMerchant(data: InsertSdrMerchant): Promise<SdrMerchant>;
  updateSdrMerchant(id: number, updates: Partial<InsertSdrMerchant>): Promise<SdrMerchant | undefined>;

  getSdrMerchantContacts(merchantId: number): Promise<SdrMerchantContact[]>;
  createSdrMerchantContact(data: InsertSdrMerchantContact): Promise<SdrMerchantContact>;

  getALeadQueue(): Promise<Array<SdrLeadState & { merchant: SdrMerchant | null; processorEvidence: ProcessorEvidence }>>;
  getSdrLeadStates(filters?: { stage?: string; priorityBucket?: string; limit?: number }): Promise<SdrLeadState[]>;
  getSdrLeadState(id: number): Promise<SdrLeadState | undefined>;
  getSdrLeadStateByMerchant(merchantId: number): Promise<SdrLeadState | undefined>;
  getSdrLeadStateByContact(contactId: number): Promise<SdrLeadState | undefined>;
  createSdrLeadState(lead: InsertSdrLeadState): Promise<SdrLeadState>;
  upsertSdrLeadState(data: InsertSdrLeadState): Promise<SdrLeadState>;
  updateSdrLeadState(id: number, updates: UpdateSdrLeadState): Promise<SdrLeadState | undefined>;
  getDueSdrLeads(limit?: number): Promise<SdrLeadState[]>;

  getSdrLeadEvents(leadStateId: number): Promise<SdrLeadEvent[]>;
  createSdrLeadEvent(event: InsertSdrLeadEvent): Promise<SdrLeadEvent>;

  getSdrChannelAttempts(leadStateId: number): Promise<SdrChannelAttempt[]>;
  createSdrChannelAttempt(attempt: InsertSdrChannelAttempt): Promise<SdrChannelAttempt>;

  getSdrComplianceState(merchantId: number): Promise<SdrComplianceState | undefined>;
  upsertSdrComplianceState(data: InsertSdrComplianceState): Promise<SdrComplianceState>;

  getSdrDashboardSummary(): Promise<any>;
  getSdrFunnelData(): Promise<any>;
  getSdrStuckLeads(): Promise<any[]>;
  getSdrActivityData(): Promise<any>;

  getSendingIdentities(): Promise<SendingIdentity[]>;
  getSendingIdentity(id: number): Promise<SendingIdentity | undefined>;
  createSendingIdentity(data: InsertSendingIdentity): Promise<SendingIdentity>;
  updateSendingIdentity(id: number, updates: Partial<InsertSendingIdentity>): Promise<SendingIdentity | undefined>;
  deleteSendingIdentity(id: number): Promise<boolean>;

  getLeadDiscoveryJobs(limit?: number): Promise<LeadDiscoveryJob[]>;
  getLeadDiscoveryJob(id: number): Promise<LeadDiscoveryJob | undefined>;
  createLeadDiscoveryJob(data: InsertLeadDiscoveryJob): Promise<LeadDiscoveryJob>;
  updateLeadDiscoveryJob(id: number, updates: Partial<InsertLeadDiscoveryJob>): Promise<LeadDiscoveryJob | undefined>;
  getLeadDiscoveryResults(jobId: number): Promise<LeadDiscoveryResult[]>;
  createLeadDiscoveryResult(data: InsertLeadDiscoveryResult): Promise<LeadDiscoveryResult>;
  createLeadDiscoveryResultsBulk(data: InsertLeadDiscoveryResult[]): Promise<LeadDiscoveryResult[]>;
  getLeadDiscoveryStats(): Promise<any>;
  findSdrMerchantByDomain(domain: string): Promise<SdrMerchant | undefined>;
  findSdrMerchantByNameCity(businessName: string, city: string | null): Promise<SdrMerchant | undefined>;
  getSdrMerchantsByCity(city: string): Promise<SdrMerchant[]>;

  getGhlWorkflowMappings(): Promise<import("@shared/schema").GhlWorkflowMapping[]>;
  upsertGhlWorkflowMapping(sequenceName: string, ghlWorkflowId: string | null, category?: string, description?: string): Promise<import("@shared/schema").GhlWorkflowMapping>;
  getGhlWorkflowIdBySequenceName(sequenceName: string): Promise<string | null>;

  getChargebacks(filters?: { status?: string; contactId?: number; cardBrand?: string; overdueOnly?: boolean }): Promise<import("@shared/schema").Chargeback[]>;
  getChargeback(id: number): Promise<import("@shared/schema").Chargeback | undefined>;
  getChargebacksByContact(contactId: number): Promise<import("@shared/schema").Chargeback[]>;
  getChargebacksByDeal(dealId: number): Promise<import("@shared/schema").Chargeback[]>;
  createChargeback(data: import("@shared/schema").InsertChargeback): Promise<import("@shared/schema").Chargeback>;
  updateChargeback(id: number, updates: import("@shared/schema").UpdateChargebackRequest): Promise<import("@shared/schema").Chargeback | undefined>;
  deleteChargeback(id: number): Promise<void>;
  getOverdueChargebacks(): Promise<import("@shared/schema").Chargeback[]>;
  getChargebackStats(): Promise<{ total: number; open: number; overdue: number; won: number; lost: number; thisMonthWinRate: number; totalAtRiskAmount: number }>;

  // Residual Imports
  getResidualImports(): Promise<import("@shared/schema").ResidualImport[]>;
  getResidualImport(id: number): Promise<import("@shared/schema").ResidualImport | undefined>;
  createResidualImport(data: import("@shared/schema").InsertResidualImport): Promise<import("@shared/schema").ResidualImport>;
  updateResidualImport(id: number, updates: Partial<import("@shared/schema").InsertResidualImport>): Promise<import("@shared/schema").ResidualImport | undefined>;
  deleteResidualImport(id: number): Promise<void>;
  getResidualImportRows(importId: number): Promise<import("@shared/schema").ResidualImportRow[]>;
  getResidualImportRow(id: number): Promise<import("@shared/schema").ResidualImportRow | undefined>;
  createResidualImportRow(data: import("@shared/schema").InsertResidualImportRow): Promise<import("@shared/schema").ResidualImportRow>;
  createResidualImportRowsBulk(data: import("@shared/schema").InsertResidualImportRow[]): Promise<import("@shared/schema").ResidualImportRow[]>;
  updateResidualImportRow(id: number, updates: Partial<import("@shared/schema").InsertResidualImportRow>): Promise<import("@shared/schema").ResidualImportRow | undefined>;
  deleteResidualImportRows(importId: number): Promise<void>;

  // Sync Conflicts
  getSyncConflicts(resolution?: string): Promise<import("@shared/schema").SyncConflict[]>;
  createSyncConflict(data: import("@shared/schema").InsertSyncConflict): Promise<import("@shared/schema").SyncConflict>;
  resolveSyncConflict(id: number, resolution: "kept-internal" | "kept-ghl" | "manual"): Promise<import("@shared/schema").SyncConflict | undefined>;

  // Churn Scores
  getMerchantHealthScores(filters?: { riskTier?: string; vertical?: string; agentOwner?: string; readActor?:{role?:string;email?:string|null} }): Promise<import("@shared/schema").MerchantHealthScore[]>;
  getMerchantHealthScoreByContact(contactId: number): Promise<import("@shared/schema").MerchantHealthScore | undefined>;
  upsertMerchantHealthScore(data: import("@shared/schema").InsertMerchantHealthScore): Promise<import("@shared/schema").MerchantHealthScore>;
  updateMerchantHealthScore(id: number, updates: Partial<import("@shared/schema").InsertMerchantHealthScore>): Promise<import("@shared/schema").MerchantHealthScore | undefined>;
  getChurnScoreWeights(options?:{seedDefaults?:boolean}): Promise<import("@shared/schema").ChurnScoreWeight[]>;
  upsertChurnScoreWeight(signalKey: string, weight: number, label?: string, description?: string): Promise<import("@shared/schema").ChurnScoreWeight>;
  getMerchantHealthScoresByTier(tier: string): Promise<import("@shared/schema").MerchantHealthScore[]>;
  getChurnRiskSummary(readActor?:{role?:string;email?:string|null}): Promise<{ tier: string; count: number }[]>;

  // Deal Backfill
  getOrphanContactCount(filters: { source?: string; vertical?: string; minScore?: number }): Promise<number>;
  getOrphanContactCandidates(filters: { source?: string; vertical?: string; minScore?: number; limit?: number; afterId?: number }): Promise<Array<{ id: number; firstName: string; lastName: string; email: string; phone: string; companyName: string | null; leadScore: number | null; vertical: string | null; leadSource: string | null; doNotContact: boolean | null; businessId: number | null }>>;
  getBackfillProgress(): Promise<Record<string, unknown> | null>;
  setBackfillProgress(progress: Record<string, unknown>): Promise<void>;

  // Underwriting
  getUnderwritingRules(): Promise<UnderwritingRules>;
  updateUnderwritingRules(updates: Partial<InsertUnderwritingRules>): Promise<UnderwritingRules>;
  getUnderwritingDecisions(filters?: { decision?: string; dealId?: number; since?: Date; limit?: number }): Promise<UnderwritingDecision[]>;
  getUnderwritingDecisionByDeal(dealId: number): Promise<UnderwritingDecision | undefined>;
  createUnderwritingDecision(data: InsertUnderwritingDecision): Promise<UnderwritingDecision>;
  overrideUnderwritingDecision(decisionId: number, overrideAction: "approve" | "reject", overriddenBy: string, note?: string): Promise<UnderwritingDecision | undefined>;
  getUnderwritingStats(since?: Date): Promise<{ total: number; approved: number; review: number; hold: number; overridden: number }>;
  insertSystemAuditRun(data: { triggeredBy?: string; overallScore?: number; probeResults?: unknown; claudeNarrative?: string | null; slackStatus?: string }): Promise<{ id: number }>;
  getSystemAuditRuns(limit?: number): Promise<any[]>;
  getSystemAuditRun(id: number): Promise<any | null>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function normalizePagination(params?: PaginationParams): { limit: number; offset: number } {
  const limit = Math.min(Math.max(params?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(params?.offset ?? 0, 0);
  return { limit, offset };
}

// ── Mixin composition ────────────────────────────────────────────────────────
  // DatabaseStorage is composed at runtime from per-domain mixin classes. The
  // declaration-merged interface below lets TypeScript see all the methods on
  // the final class, while `applyMixins` copies the implementations onto the
  // prototype at module load time.
  function applyMixins(derivedCtor: any, baseCtors: any[]) {
    for (const baseCtor of baseCtors) {
      for (const name of Object.getOwnPropertyNames(baseCtor.prototype)) {
        if (name === "constructor") continue;
        Object.defineProperty(
          derivedCtor.prototype,
          name,
          Object.getOwnPropertyDescriptor(baseCtor.prototype, name) || Object.create(null),
        );
      }
    }
  }

export interface DatabaseStorage extends ContactsStorage, DealsStorage, TicketsStorage, TasksStorage, DocumentsStorage, AuditStorage, NotificationsStorage, WorkflowsStorage, TemplatesStorage, ProspectsStorage, CampaignsStorage, NotesStorage, CommLogsStorage, AutomationStorage, SunbizStorage, MerchantsStorage, ResidualsStorage, HealthStorage, PartnersStorage, ReviewsStorage, MiscStorage, RateReviewStorage, BusinessesStorage, SdrStorage, PartnerOrgsStorage, ContentStorage, ChurnStorage, RelationshipsStorage, UnderwritingStorage, SystemAuditStorage {}

// @ts-ignore -- methods are injected at runtime by applyMixins below
export class DatabaseStorage implements IStorage {}

applyMixins(DatabaseStorage, [ContactsStorage, DealsStorage, TicketsStorage, TasksStorage, DocumentsStorage, AuditStorage, NotificationsStorage, WorkflowsStorage, TemplatesStorage, ProspectsStorage, CampaignsStorage, NotesStorage, CommLogsStorage, AutomationStorage, SunbizStorage, MerchantsStorage, ResidualsStorage, HealthStorage, PartnersStorage, ReviewsStorage, MiscStorage, RateReviewStorage, BusinessesStorage, SdrStorage, PartnerOrgsStorage, ContentStorage, ChurnStorage, RelationshipsStorage, UnderwritingStorage, SystemAuditStorage]);

export const storage = new DatabaseStorage();
