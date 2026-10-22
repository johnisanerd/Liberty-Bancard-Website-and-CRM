import assert from "node:assert/strict";
import fs from "node:fs";
import { hubTabs, hubTabState, typedTabUrl } from "../client/src/lib/crm-destination-state";
let checks = 0;
const check = (v: unknown, m: string) => { assert(v, m); checks++; };

const admin = hubTabs.content, rep = ["content", "linkedin", "blaze"] as const;
check(hubTabState("?tab=blog", admin, admin).value === "blog", "Valid tab is selected");
check(hubTabState("", admin, admin).value === "content" && hubTabState("", admin, admin).issues.length === 0, "No tab selects the first permitted tab without an issue");
const dup = hubTabState("?tab=blog&tab=linkedin", admin, admin);
check(dup.value === "content" && dup.issues[0]?.kind === "conflict", "Conflicting duplicate tab is rejected, not first-wins");
check(hubTabState("?tab=blog&tab=blog", admin, admin).value === "blog", "Identical duplicates are one value");
const bad = hubTabState("?tab=nope", admin, admin);
check(bad.value === "content" && bad.issues[0]?.kind === "invalid", "Unknown tab falls back and reports invalid");
const forb = hubTabState("?tab=blog", admin, rep);
check(forb.value === "content" && forb.issues[0]?.kind === "forbidden", "Role-forbidden tab falls back and reports forbidden");
check(hubTabState("?tab=settings", hubTabs.ghlIntegration, ["sequence-guide"] as const).value === "sequence-guide", "Non-admin GHL hub never selects Settings");
check(hubTabState("?tab=growth", hubTabs.playbooks, ["marketing"] as const).issues[0]?.kind === "forbidden", "Non-manager Growth playbook is forbidden");

const url = typedTabUrl("/dashboard/sdr-hub", "?tab=sdr&contactId=42&junk=1&dealId=x", "#top", { tab: "chatbot" });
const u = new URL(url, "http://x");
check(u.pathname === "/dashboard/sdr-hub" && u.searchParams.get("tab") === "chatbot", "Tab change targets the hub with the new tab");
check(u.searchParams.get("contactId") === "42", "Typed contact context is preserved across a tab change");
check(!u.searchParams.has("junk"), "Arbitrary query state is dropped");
check(u.hash === "#top", "Hash is retained");
check(new URL(typedTabUrl("/dashboard/sdr-hub", "?tab=sdr&tab=chatbot", "", { tab: "sdr" }), "http://x").searchParams.getAll("tab").length === 1, "Result never carries duplicate tab values");

// Source census: every hub uses the shared codec, pushes history and keeps the issue notice.
const hubs: Record<string, string> = {
  GhlIntegrationHub: "/dashboard/ghl-integration", ContentHub: "/dashboard/content-hub", PlaybooksHub: "/dashboard/playbooks",
  SDRHub: "/dashboard/sdr-hub", DeliverabilityHub: "/dashboard/deliverability-hub",
};
for (const [name, path] of Object.entries(hubs)) {
  const src = fs.readFileSync(`client/src/pages/dashboard/${name}.tsx`, "utf8");
  check(/hubTabState<string>\(/.test(src) && src.includes(`typedTabUrl("${path}"`), `${name} decodes with hubTabState and changes with typedTabUrl`);
  check(!/navigate\(`[^`]*\?tab=/.test(src) && !/replace/.test(src.replace(/Replace/g, "")), `${name} has no hand-built tab URL and no history replace`);
  check(src.includes("hub-selection-issue"), `${name} tells the user when a selection was rejected`);
}
const reg = JSON.parse(fs.readFileSync("client/src/lib/crm-route-registry.generated.json", "utf8"));
for (const path of Object.values(hubs)) {
  const row = reg.find((r: any) => r.pattern === path || r.path === path);
  check(row?.queryPolicy?.allowed?.includes("tab"), `${path} registers tab in the generated query policy`);
}
console.log(`Stage 3 D hub tabs: ${checks} checks passed`);
