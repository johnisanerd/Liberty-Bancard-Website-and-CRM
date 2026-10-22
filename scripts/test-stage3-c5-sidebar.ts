/** Stage 3 C5 final shell: exact order, role filtering, route/guard agreement and cutover discipline. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { employeeSidebarEntries, employeeSidebarFor, activeSidebarId, EMPLOYEE_SIDEBAR_ORDER } from "../client/src/lib/employee-sidebar";

const registry: Array<{ pattern: string; guard: string }> = JSON.parse(fs.readFileSync("client/src/lib/crm-route-registry.generated.json", "utf8"));
const route = (href: string) => registry.find(r => r.pattern === href.split("?")[0]);
const guardRoles = (guard: string) => {
  const m = guard.match(/:\s*(.+)$/);
  return m ? m[1].split("/").map(x => x.trim()) : null; // null = any authenticated employee
};

assert.deepEqual(employeeSidebarEntries.map(e => e.label), [...EMPLOYEE_SIDEBAR_ORDER], "exact eleven-entry order");
assert.equal(employeeSidebarEntries.length, 11);

const expected: Record<string, string[]> = {
  admin: [...EMPLOYEE_SIDEBAR_ORDER],
  manager: [...EMPLOYEE_SIDEBAR_ORDER],
  agent: EMPLOYEE_SIDEBAR_ORDER.filter(l => l !== "Campaigns" && l !== "Administration"),
};
for (const role of ["admin", "manager", "agent"]) {
  assert.deepEqual(employeeSidebarFor(role).map(i => i.entry.label), expected[role], `${role} visible entries`);
}
assert.deepEqual(employeeSidebarFor("merchant"), [], "portals keep their own shell");
assert.deepEqual(employeeSidebarFor(""), []);

// Role-specific destinations from the plan.
const href = (role: string, id: string) => employeeSidebarFor(role).find(i => i.entry.id === id)?.href;
assert.equal(href("admin", "administration"), "/dashboard/admin-hub?tab=users");
assert.equal(href("manager", "administration"), "/dashboard/admin-hub?tab=agents");
assert.equal(href("agent", "today"), "/dashboard/my-day");
assert.equal(href("agent", "reports"), "/dashboard/my-earnings");
assert.equal(href("agent", "prospecting"), "/dashboard/outreach-queue");
assert.equal(href("agent", "campaigns"), undefined, "no invented agent campaign access");

// Every visible target resolves to a registered route whose guard admits that role.
for (const role of ["admin", "manager", "agent"]) {
  for (const item of employeeSidebarFor(role)) {
    if (item.href.startsWith("/assets")) continue;
    const r = route(item.href);
    assert.ok(r, `${role}/${item.entry.id}: ${item.href} is a registered route`);
    const roles = guardRoles(r!.guard);
    if (roles && roles.some(x => ["admin", "manager", "agent"].includes(x))) {
      assert.ok(roles.includes(role), `${role}/${item.entry.id}: guard "${r!.guard}" admits the role`);
    }
  }
}
// Retired destinations are never targets; legacy-status entries must document a blocker and a working entrance.
for (const entry of employeeSidebarEntries) {
  if (entry.status === "legacy") assert.ok(entry.blocker && entry.legacyHref, `${entry.id}: blocked target documents blocker + entrance`);
}
// Active highlight: child routes belong to their destination; the first match wins.
const active = (role: string, path: string) => activeSidebarId(role, path);
assert.equal(active("admin", "/dashboard"), "today");
assert.equal(active("admin", "/dashboard/contacts/123"), "records");
assert.equal(active("admin", "/dashboard/lead-ops?tab=sources"), "prospecting");
assert.equal(active("admin", "/dashboard/onboarding"), "merchant-operations");
assert.equal(active("admin", "/dashboard/outbound-center?tab=sequences"), "campaigns");
assert.equal(active("admin", "/dashboard/knowledge-admin?tab=feedback"), "resources");
assert.equal(active("admin", "/dashboard/queue-holds"), "administration");
assert.equal(active("agent", "/dashboard/leaderboard"), "reports");
assert.equal(active("admin", "/dashboard/no-such-page"), null);

// Layout wiring: employees get the final nav; merchants and Dev Mode keep the legacy entrances.
const layout = fs.readFileSync("client/src/pages/DashboardLayout.tsx", "utf8");
assert.ok(layout.includes("renderEmployeeNav()"));
assert.ok(layout.includes("PageHeadingOwnerProvider") && layout.includes("canShowMerchantOperationsNav"), "C3/C4 adoption preserved");
assert.ok(layout.includes('"LEGACY: DAILY WORK"') && layout.includes("button-sidebar-dev-mode"), "legacy entrances retained behind Dev Mode");
for (const id of ["link-sidebar-ai-advisor", "link-sidebar-security", "button-logout"]) assert.ok(layout.includes(id), `${id} stays reachable`);
console.log("Stage 3 C5 sidebar: PASS");
