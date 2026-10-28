/**
 * Stage 4A operational-truth unit contracts (pure derivations; no database writes, no provider calls).
 *  F12: ZeroBounce next automatic run is nullable with an explicit state and honors the cron override.
 *  F13: queue runtime state is derived from expected selection, and freshness is event-driven aware.
 */
import assert from "node:assert/strict";

let checks = 0;
const check = (ok: unknown, message: string) => { assert(ok, message); checks++; console.log(`✓ [S4A-${String(checks).padStart(2, "0")}] ${message}`); };

const { resolveZeroBounceNextRun } = await import("../server/services/paid-provider-control");
const { deriveQueueFreshness, deriveQueueRuntimeState, QUEUE_STALE_AFTER_INTERVALS } = await import("../server/services/queue-manager");

// ── F12 ──
const noon = new Date("2026-10-28T12:00:00.000Z");
const off = resolveZeroBounceNextRun({ autoRunEnabled: false, cron: "0 6 * * *", now: noon });
check(off.state === "disabled" && off.nextAutomaticRunAt === null, "F12: disabled auto-run has no next run (null + explicit state), not a fabricated 06:00");
const on = resolveZeroBounceNextRun({ autoRunEnabled: true, cron: "0 6 * * *", now: noon });
check(on.state === "scheduled" && on.nextAutomaticRunAt === "2026-10-29T06:00:00.000Z", "F12: enabled default schedule resolves to the next 06:00 UTC");
const before = resolveZeroBounceNextRun({ autoRunEnabled: true, cron: "0 6 * * *", now: new Date("2026-10-28T05:00:00.000Z") });
check(before.nextAutomaticRunAt === "2026-10-28T06:00:00.000Z", "F12: before today's run time resolves to today");
const custom = resolveZeroBounceNextRun({ autoRunEnabled: true, cron: "30 14 * * *", now: noon });
check(custom.nextAutomaticRunAt === "2026-10-28T14:30:00.000Z" && custom.schedule === "30 14 * * *", "F12: ZEROBOUNCE_AUTO_RUN_CRON override is respected");
const odd = resolveZeroBounceNextRun({ autoRunEnabled: true, cron: "*/15 * * * *", now: noon });
check(odd.state === "schedule_unresolved" && odd.nextAutomaticRunAt === null, "F12: a non-daily schedule is reported unresolved with a null time, never guessed");
const bad = resolveZeroBounceNextRun({ autoRunEnabled: true, cron: "61 25 * * *", now: noon });
check(bad.state === "schedule_unresolved", "F12: an out-of-range daily schedule is unresolved");
const unavailable = resolveZeroBounceNextRun({ autoRunEnabled: null, cron: "0 6 * * *", now: noon });
check(unavailable.state === "unavailable" && unavailable.nextAutomaticRunAt === null, "F12: an unreadable setting is unavailable, not disabled");

// ── F13 runtime state ──
check(deriveQueueRuntimeState({ expectedSelected: false, workerInstantiated: false, workerActive: false, probeOk: true }) === "expected_not_selected", "F13: an unselected queue is expected_not_selected (deliberate, not a failure)");
check(deriveQueueRuntimeState({ expectedSelected: true, workerInstantiated: false, workerActive: false, probeOk: true }) === "selected_missing", "F13: selection is independent of instantiated workers: selected but no worker is selected_missing");
check(deriveQueueRuntimeState({ expectedSelected: true, workerInstantiated: true, workerActive: false, probeOk: true }) === "selected_not_ready", "F13: a worker that exists but is not running is selected_not_ready");
check(deriveQueueRuntimeState({ expectedSelected: true, workerInstantiated: true, workerActive: true, probeOk: true }) === "active", "F13: a running selected worker is active");
check(deriveQueueRuntimeState({ expectedSelected: true, workerInstantiated: true, workerActive: true, probeOk: false }) === "unreadable", "F13: a failed Redis read is unreadable and stays a failure");

// ── F13 freshness ──
const now = Date.parse("2026-10-28T12:00:00.000Z");
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const base = { hasCron: false, runtimeState: "active" as const, paused: false, probeOk: true, nowMs: now };
check(deriveQueueFreshness({ ...base, repeatEveryMs: 0, lastObservedAt: null }).status === "not_applicable", "F13: an event-driven queue is never stale from silence");
check(deriveQueueFreshness({ ...base, hasCron: true, repeatEveryMs: 86_400_000, lastObservedAt: null }).model === "cron", "F13: a cron queue reports the cron model and no expected interval");
check(deriveQueueFreshness({ ...base, repeatEveryMs: 60_000, lastObservedAt: null }).status === "no_observation_in_process", "F13: no completion observed in this process is unknown, not stale");
check(deriveQueueFreshness({ ...base, repeatEveryMs: 60_000, lastObservedAt: iso(60_000) }).status === "fresh", "F13: a recent completion is fresh");
check(deriveQueueFreshness({ ...base, repeatEveryMs: 60_000, lastObservedAt: iso(QUEUE_STALE_AFTER_INTERVALS * 60_000 + 1) }).status === "stale", "F13: a completion older than three intervals is stale");
check(deriveQueueFreshness({ ...base, runtimeState: "expected_not_selected", repeatEveryMs: 60_000, lastObservedAt: iso(9_999_999) }).status === "not_applicable", "F13: an unselected queue is not judged for freshness");
check(deriveQueueFreshness({ ...base, paused: true, repeatEveryMs: 60_000, lastObservedAt: iso(9_999_999) }).status === "not_applicable", "F13: a paused queue is not judged stale");
check(deriveQueueFreshness({ ...base, probeOk: false, repeatEveryMs: 60_000, lastObservedAt: null }).status === "unavailable", "F13: an unreadable probe makes freshness unavailable");

console.log(`\nStage 4A operational-truth contracts passed: ${checks} checks`);
process.exit(0);
