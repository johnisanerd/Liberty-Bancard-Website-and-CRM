/** Read-only inventory of shared-presentation adoption per employee destination (UI-04). Source inspection only. */
import fs from "node:fs";
import path from "node:path";
import { employeeSidebarEntries } from "../client/src/lib/employee-sidebar";

const registry: Array<{ pattern: string; component: string }> = JSON.parse(fs.readFileSync("client/src/lib/crm-route-registry.generated.json", "utf8"));
const walk = (d: string): string[] => fs.readdirSync(d).flatMap(n => { const p = path.join(d, n); return fs.statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk("client/src").filter(f => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));
const byName = new Map<string, string>();
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const m = /export default (?:async )?(?:function )?([A-Za-z0-9_]+)/.exec(src);
  byName.set(path.basename(f, ".tsx"), f);
  if (m) byName.set(m[1], f);
}
const owner = (pattern: string) => employeeSidebarEntries.find(e => e.matches(pattern))?.label ?? null;
export interface Row { destination: string; route: string; component: string; file: string | null; page: boolean; header: boolean; metrics: boolean; states: boolean; toolbar: boolean; table: boolean; rawTiles: number; rawH1: number }
export function inventory(): Row[] {
  const rows: Row[] = [];
  for (const r of registry) {
    const destination = owner(r.pattern);
    if (!destination) continue;
    const file = byName.get(r.component) ?? null;
    const src = file ? fs.readFileSync(file, "utf8") : "";
    const has = (n: string) => new RegExp(`\\b${n}\\b`).test(src);
    // Hubs delegate their content: count children imported from the same hub file list (one hop).
    rows.push({ destination, route: r.pattern, component: r.component, file,
      page: has("CrmPage"), header: has("CrmPageHeader"), metrics: has("ScopedMetricStrip"), states: has("CrmDataState"),
      toolbar: has("WorklistToolbar"), table: has("CrmDataTable"),
      rawTiles: (src.match(/data-testid="(?:stat|metric|kpi)-/g) ?? []).length, rawH1: (src.match(/<h1[\s>]/g) ?? []).length });
  }
  return rows.sort((a, b) => a.destination.localeCompare(b.destination) || a.route.localeCompare(b.route));
}
if (process.argv[1]?.endsWith("stage3-d-r2-ui04-inventory.ts")) {
  const rows = inventory();
  for (const r of rows) console.log([r.destination, r.route, r.component, r.page ? "P" : "-", r.header ? "H" : "-", r.metrics ? "M" : "-", r.states ? "S" : "-", r.toolbar ? "W" : "-", r.table ? "T" : "-", r.rawTiles, r.file ? "" : "NOFILE"].join("\t"));
  console.log(`routes=${rows.length}`);
}
