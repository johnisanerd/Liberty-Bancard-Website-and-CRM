import { pool } from "../db";

/**
 * Durable per-effect dispatch ledger for GHL workflow enrollment.
 *
 * 'started' is written before the provider request, so a later attempt of the same effect (the first handoff, a webhook
 * retry, or the recovery job) never re-sends over an accepted or possibly accepted request. Only a definite outcome
 * settles the row: 'accepted' (the provider took it) or 'refused' (definitely not sent or definitely rejected, so a
 * retry is safe). A lost response or a crash leaves 'started', which every caller treats as an unknown outcome that is
 * never re-sent automatically.
 */
export type HandoffClaim = "claimed" | "accepted" | "unknown";

export async function claimHandoffDispatch(key: string, workflowKey: string, ghlContactId: string): Promise<HandoffClaim> {
  const claimed = await pool.query(
    `INSERT INTO ghl_workflow_handoff_dispatches AS d (idempotency_key, workflow_key, ghl_contact_id, state)
     VALUES ($1, $2, $3, 'started')
     ON CONFLICT (idempotency_key) DO UPDATE
       SET state = 'started', attempt_count = d.attempt_count + 1, started_at = now(), settled_at = NULL
       WHERE d.state = 'refused'
     RETURNING state`,
    [key, workflowKey, ghlContactId]);
  if (claimed.rows[0]) return "claimed";
  const existing = (await pool.query(`SELECT state FROM ghl_workflow_handoff_dispatches WHERE idempotency_key = $1`, [key])).rows[0];
  return existing?.state === "accepted" ? "accepted" : "unknown";
}

/** Never throws: a failed settle leaves 'started', which is the safe (never re-sent) reading. */
export async function settleHandoffDispatch(key: string, state: "accepted" | "refused"): Promise<void> {
  await pool.query(
    `UPDATE ghl_workflow_handoff_dispatches SET state = $2, settled_at = now() WHERE idempotency_key = $1 AND state = 'started'`,
    [key, state]).catch(err => console.error("[GHL Handoff] could not settle dispatch ledger:", err instanceof Error ? err.message : err));
}
