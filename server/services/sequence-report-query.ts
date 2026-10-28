/** Independent child censuses: step identities and membership identities never
 * share a joined count. Repeated contacts remain distinct memberships.
 */
export const SEQUENCE_REPORT_SQL = `
SELECT s.id,s.name,s.status,s.trigger_type,s.sequence_family,s.description,
  s.eligible_consent_tiers,s.channels_allowed,s.lifecycle_stages_allowed,COALESCE(steps.step_count,0)::int AS total_steps,
  steps.step_count,steps.email_steps,steps.sms_steps,steps.ghl_steps,steps.task_steps,steps.max_delay_days,
  members.active_enrollments,members.completed_enrollments,members.total_memberships,members.unique_contacts
FROM follow_up_sequences s
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS step_count,
    COUNT(*) FILTER(WHERE action_type='email')::int AS email_steps,
    COUNT(*) FILTER(WHERE action_type='sms')::int AS sms_steps,
    COUNT(*) FILTER(WHERE action_type='ghl_workflow')::int AS ghl_steps,
    COUNT(*) FILTER(WHERE action_type='task')::int AS task_steps,
    MAX(delay_days+COALESCE(delay_hours,0)/24.0)::numeric(6,1) AS max_delay_days
  FROM sequence_steps WHERE sequence_id=s.id
) steps ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int AS total_memberships,COUNT(DISTINCT contact_id)::int AS unique_contacts,
    COUNT(*) FILTER(WHERE status='active')::int AS active_enrollments,
    COUNT(*) FILTER(WHERE status='completed')::int AS completed_enrollments
  FROM sequence_enrollments WHERE sequence_id=s.id
) members ON TRUE
ORDER BY s.status DESC,s.sequence_family NULLS LAST,s.name`;