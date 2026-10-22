import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { taskCohortState, buildTaskCohortHref, isOverdueTask, todayDestinations } from "../client/src/lib/crm-destination-state";
import { projectContactCore, RetainedContactCore } from "../client/src/lib/retained-contact-core";
import { readFailureKind, metricAvailability } from "../client/src/lib/query-state";
import { dealReadPredicate } from "../server/services/revenue-read-authority";

// Static and pure-function contracts for the independent-review repairs (F02, F03, F04, E1, U1, M1, M2, performance gate).
let checks = 0;
const check = (ok: unknown, label: string) => { assert.ok(ok, label); checks++; console.log(`✓ ${label}`); };
const read = (p: string) => readFileSync(p, "utf8");

// F03: task cohorts.
{
  check(taskCohortState("?tab=tasks&due=overdue").due === "overdue" && taskCohortState("?tab=tasks&due=overdue").status === "all", "due=overdue decodes as the overdue cohort");
  check(taskCohortState("?taskState=pending").status === "pending", "taskState=pending decodes");
  const bad = taskCohortState("?taskState=bogus&due=never");
  check(bad.status === "all" && bad.due === "all" && bad.issues.length === 2, "invalid values fall back and report issues");
  check(taskCohortState("?taskState=pending&taskState=completed").issues[0]?.kind === "conflict", "duplicate values are a conflict, not a silent pick");
  const href = buildTaskCohortHref("https://x.test/dashboard/tasks-appointments?tab=tasks&junk=1&due=overdue", { status: "pending", due: "all" });
  check(href === "/dashboard/tasks-appointments?tab=tasks&taskState=pending", "href keeps registered context, drops unregistered and cleared cohort values");
  check(todayDestinations.overdueTasks.includes("due=overdue") && todayDestinations.pendingTasks.includes("taskState=pending") && todayDestinations.newLeads7d === "/dashboard/pipeline?created=7d", "Today destinations carry the cohort they count");
  const asOf = new Date("2026-10-22T12:00:00Z");
  check(isOverdueTask({ status: "pending", dueDate: "2026-10-22T11:59:59Z" }, asOf) && isOverdueTask({ status: "in_progress", dueDate: "2026-10-01T00:00:00Z" }, asOf), "pending and in-progress tasks past due are overdue");
  check(!isOverdueTask({ status: "completed", dueDate: "2026-10-01T00:00:00Z" }, asOf) && !isOverdueTask({ status: "cancelled", dueDate: "2026-10-01T00:00:00Z" }, asOf)
    && !isOverdueTask({ status: "pending", dueDate: null }, asOf) && !isOverdueTask({ status: "pending", dueDate: "2026-10-23T00:00:00Z" }, asOf), "closed, undated and future tasks are not overdue");
  const values: unknown[] = [];
  const sql = dealReadPredicate({ role: "admin", email: "a@x.test" }, { includeArchived: false, pipeline: "sales", createdLast7Days: true }, values);
  check(/created_at >= NOW\(\) - INTERVAL '7 days'/.test(sql) && /record_class='production'/.test(sql) && /archived_at IS NULL/.test(sql), "new-lead cohort predicate shares the production/non-archived/sales population");
  const without = dealReadPredicate({ role: "admin" }, { includeArchived: false, pipeline: "sales" }, []);
  check(!/INTERVAL '7 days'/.test(without), "7-day predicate applies only when requested");
  const tasks = read("client/src/pages/dashboard/Tasks.tsx"), pipeline = read("client/src/pages/dashboard/Pipeline.tsx"), overview = read("client/src/pages/dashboard/Overview.tsx");
  check(/taskCohortState\(cohortSearch\)/.test(tasks) && !/useState<string>\("all"\);\s*\n\s*const \[filterSource/.test(tasks) && /isOverdueTask\(t, new Date\(\)\)/.test(tasks), "Tasks derives status/due from the URL, not one-time local state");
  check(/new URLSearchParams\(search\)\.get\("created"\) === "7d"/.test(pipeline) && /createdLast7Days:"true"/.test(pipeline) && /pipeline-created-cohort/.test(pipeline), "Pipeline derives the created=7d cohort from the URL each render, sends the server filter and shows a clearable chip");
  check(/todayDestinations\.overdueTasks/.test(overview) && /todayDestinations\.newLeads7d/.test(overview) && !/href: "\/dashboard\/contacts", cta: "Open People"/.test(overview), "Today actions open the cohort they count");
  check(/OPEN_SALES_LEAD_STAGES/.test(overview) && !/d\.stage !== "Closed Won" && d\.stage !== "Closed Lost"/.test(overview), "Overview active deals use the canonical open sales stages");
  check(/createdLast7Days/.test(read("server/routes/deals.ts")), "deal list route accepts the created-last-7-days filter");
}

// F02: partner pages never show a failed read as zero or empty.
{
  check(readFailureKind(new Error("403: Forbidden")) === "denied" && readFailureKind(new Error("500: boom")) === "unavailable" && readFailureKind(new TypeError("network")) === "unavailable", "403/401 are denied; other failures are unavailable");
  check(metricAvailability({ isError: false, data: [] }) === "available" && metricAvailability({ isError: true, data: undefined }) === "unknown" && metricAvailability({ isError: true, data: [1] }) === "stale", "metric availability derives from the read");
  for (const f of ["PartnerPortalAdmin", "PartnerReferralPipeline"]) {
    const src = read(`client/src/pages/dashboard/${f}.tsx`);
    check(/metricAvailability\(partnersRead\)/.test(src) && /readFailureKind\(partnersRead\.error\)/.test(src) && /onRetry/.test(src), `${f} derives metric availability and renders denied/unavailable with Retry`);
    check(!/data: partners = \[\]/.test(src), `${f} no longer defaults failed query data to an empty array`);
  }
  const admin = read("client/src/pages/dashboard/PartnerPortalAdmin.tsx");
  check(!/if \(!res\.ok\) return \[\]/.test(admin) && /throw new Error\(`\$\{res\.status\}/.test(admin) && /referralsRead\.isError/.test(admin), "expanded partner referrals throw on non-OK and render the failure");
}

// M1/M2: named populations.
{
  const stats = read("server/routes/permissions-audit.ts");
  check(/populations: \{[\s\S]*tickets: \{ key: "all_open_tickets_not_role_scoped"/.test(stats) && !/population: "production_non_archived_whole_population"/.test(stats), "dashboard stats name a population per field; tickets are not labelled production non-archived");
  check(/contactsScope/.test(read("server/routes/imports.ts")) && /All unarchived contacts \(all record classes, all owners\)/.test(read("server/routes/imports.ts")), "outreach status states the contact aggregate scope");
  check(!/no archive or record-class filter/.test(read("client/src/pages/dashboard/OutreachCommand.tsx")) && /all unarchived/.test(read("client/src/pages/mobile/MobileOutreach.tsx")), "desktop and mobile contact totals disclose the true scope");
}

// F04: only the projected core is retained.
{
  const detail = { contact: { id: 7, firstName: "Ada" }, capabilities: { hasOnboarding: true }, deals: [{ id: 1 }], tickets: [{ id: 2 }], tasks: [{ id: 3 }], notes: [{ id: 4, body: "private" }], loaded: { deals: true } };
  const projected = projectContactCore<any, any>(detail);
  check(projected !== null && Object.keys(projected).sort().join() === "capabilities,contact", "projection keeps only contact core and capabilities");
  const store = new RetainedContactCore<NonNullable<typeof projected>>();
  const key = RetainedContactCore.key({ id: "a" }, 7);
  store.observe(key, { data: projected, hasCore: true });
  const kept = store.read(key) as any;
  check(kept && !("deals" in kept) && !("notes" in kept) && !("tickets" in kept) && !("tasks" in kept) && !("loaded" in kept), "retained value has no section arrays, notes or loaded flags");
  check(projectContactCore(null) === null && projectContactCore({ contact: null }) === null, "an absent contact projects to nothing");
  const src = read("client/src/pages/dashboard/ContactDetail.tsx");
  check(/projectContactCore</.test(src) && !/new RetainedContactCore<ContactDetailData>/.test(src), "Contact component stores the projection, not the detail response");
}

// E1: no capped export remains.
{
  const ops = read("server/routes/crm-operations.ts");
  const exportsBlock = ops.slice(ops.indexOf("// === CSV EXPORTS ==="), ops.indexOf("// === CONTACT-COMPANY ASSOCIATIONS ==="));
  check(exportsBlock.length > 500 && !/limit: ?500/.test(exportsBlock) && /streamKeysetCsv/.test(exportsBlock), "export routes stream bounded pages and carry no 500-row cap");
}

// U1 and gates.
{
  const enrich = read("client/src/pages/dashboard/CanonicalEnrichment.tsx");
  check(/embedded \? "div" : "section"/.test(enrich) && !/"main"/.test(enrich.slice(enrich.indexOf("const Shell"), enrich.indexOf("const Shell") + 120)), "Canonical Enrichment never renders its own main landmark");
  check(/main!==1/.test(read("docs/certification/stage3-d-v/tools/resp.mjs")), "route crawl fails when a page does not have exactly one main");
  const perf = read("scripts/test-stage3-c5-performance.ts");
  check(/READY_TIMEOUT_MS/.test(perf) && /assert\.ok\(dataMs>=0/.test(perf) && /assert\.ok\(shellMs>=0/.test(perf) && /shellSamples/.test(perf) && /baselineIndexSha/.test(perf), "performance gate asserts shell and data readiness for every sample and records input identity");
}
console.log(`Stage 3 D-V contracts: PASS (${checks} checks)`);
