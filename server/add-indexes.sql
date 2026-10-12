-- Performance indexes for high-volume tables
-- Safe: CREATE INDEX IF NOT EXISTS prevents duplicates

-- contacts (152K rows): phone, status, ghl_contact_id are common filters
-- Email is a nonunique delivery mailbox (contacts_active_email_idx WHERE archived_at IS NULL).
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_ghl_id ON contacts(ghl_contact_id);
CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_lead_score ON contacts(lead_score DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_business_id ON contacts(business_id);

-- deals (502 rows): pipeline, stage, contact_id are core CRM filters
CREATE INDEX IF NOT EXISTS idx_deals_pipeline ON deals(pipeline);
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_deals_contact_id ON deals(contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_pipeline_stage ON deals(pipeline, stage);
CREATE INDEX IF NOT EXISTS idx_deals_created_at ON deals(created_at DESC);

-- tickets: status, priority, contact_id for dashboard filtering
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority);
CREATE INDEX IF NOT EXISTS idx_tickets_contact_id ON tickets(contact_id);

-- tasks: status, assigned_to for task management
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_deal_id ON tasks(deal_id);
CREATE INDEX IF NOT EXISTS idx_tasks_contact_id ON tasks(contact_id);

-- prospects: status, list_id, score for enrichment pipeline  
CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status);
CREATE INDEX IF NOT EXISTS idx_prospects_list_id ON prospects(list_id);
CREATE INDEX IF NOT EXISTS idx_prospects_score ON prospects(qualification_score);
CREATE INDEX IF NOT EXISTS idx_prospects_email ON prospects(email);

-- sunbiz_entities (1.9M rows): filing_number, enrichment_status, list_id are critical
CREATE INDEX IF NOT EXISTS idx_sunbiz_filing_number ON sunbiz_entities(filing_number);
CREATE INDEX IF NOT EXISTS idx_sunbiz_enrichment_status ON sunbiz_entities(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_sunbiz_list_id ON sunbiz_entities(list_id);
CREATE INDEX IF NOT EXISTS idx_sunbiz_email ON sunbiz_entities(email);
CREATE INDEX IF NOT EXISTS idx_sunbiz_created_at ON sunbiz_entities(created_at DESC);

-- audit_logs: created_at for recent log queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- documents: contact_id, deal_id for document lookup
CREATE INDEX IF NOT EXISTS idx_documents_contact_id ON documents(contact_id);
CREATE INDEX IF NOT EXISTS idx_documents_deal_id ON documents(deal_id);

-- notifications: read status for unread count
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);
-- Partial index for unread count badge (covers WHERE read = false scoped by recipient)
CREATE INDEX IF NOT EXISTS idx_notifications_unread_recipient
  ON notifications(recipient_id) WHERE read = false;
-- Recipient lookup for paginated list (recipient + recency)
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created_at
  ON notifications(recipient_id, created_at DESC);

-- notification_preferences: speed up disabled-event subquery filter
CREATE INDEX IF NOT EXISTS idx_notif_prefs_user_disabled
  ON notification_preferences(user_id, event_type) WHERE enabled = false;

-- deals: company_id FK — joins with companies table on deal lookups
CREATE INDEX IF NOT EXISTS idx_deals_company_id ON deals(company_id);

-- tasks: ticket_id FK — unindexed despite being a FK and common filter
CREATE INDEX IF NOT EXISTS idx_tasks_ticket_id ON tasks(ticket_id);

-- workflow_runs: workflow_id FK — queried constantly by the workflow engine
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);

-- notes: polymorphic entity lookup — all note queries filter by (entity_type, entity_id)
CREATE INDEX IF NOT EXISTS idx_notes_entity_type_entity_id ON notes(entity_type, entity_id);

-- comments: polymorphic entity lookup — all comment queries filter by (entity_type, entity_id)
CREATE INDEX IF NOT EXISTS idx_comments_entity_type_entity_id ON comments(entity_type, entity_id);

-- sdr_lead_events: lead_state_id FK — queried by orchestrator on every SDR tick
-- CONCURRENTLY: avoids exclusive lock on a high-write table during index build
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sdr_lead_events_lead_state_id ON sdr_lead_events(lead_state_id);

-- sdr_channel_attempts: lead_state_id FK — queried alongside lead events per lead
-- CONCURRENTLY: avoids exclusive lock on a high-write table during index build
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sdr_channel_attempts_lead_state_id ON sdr_channel_attempts(lead_state_id);
