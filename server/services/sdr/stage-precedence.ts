/**
 * SDR lead stage precedence.
 *
 * sdr_lead_state carries two non-null stage columns that both default to 'DISCOVERED': `stage` (read by the
 * orchestrator and queue filters) and `current_stage` (written by upsertSdrLeadState and the GHL sync mirror).
 * The old `stage || currentStage` never fell back because `stage` is never empty. Precedence is now explicit:
 *   1. If the two agree, that value.
 *   2. If they disagree and `stage` still holds the untouched default, only `current_stage` was advanced: use it.
 *   3. Otherwise `stage` wins (the orchestrator-owned pipeline state).
 * A disagreement is always reported (`conflict: true`) so it can be surfaced rather than hidden.
 */
export const SDR_DEFAULT_STAGE = "DISCOVERED";

export interface SdrStageResolution {
  stage: string;
  source: "agree" | "current_stage_advanced" | "stage";
  conflict: boolean;
}

export function resolveSdrStage(row: { stage?: string | null; currentStage?: string | null }): SdrStageResolution {
  const stage = row.stage ?? null;
  const current = row.currentStage ?? null;
  if (stage && current && stage === current) return { stage, source: "agree", conflict: false };
  if (!stage && current) return { stage: current, source: "current_stage_advanced", conflict: false };
  if (stage && !current) return { stage, source: "stage", conflict: false };
  if (!stage && !current) return { stage: SDR_DEFAULT_STAGE, source: "agree", conflict: false };
  if (stage === SDR_DEFAULT_STAGE && current) return { stage: current, source: "current_stage_advanced", conflict: true };
  return { stage: stage as string, source: "stage", conflict: true };
}
