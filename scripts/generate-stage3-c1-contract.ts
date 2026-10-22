/** Reproducible, exact portable input and evidence inventory generator.
 * Input copies are specifications, never proof of runtime acceptance. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import ts from "typescript";
import {execFileSync} from "node:child_process";
import {contactSections} from "../client/src/lib/crm-destination-state";

const root = "docs/certification/stage3-c1";
fs.mkdirSync(`${root}/inputs`,{recursive:true});
const inputs = [
  [".local/tasks/liberty-stage3-c1-hypothesis-audit.md","adjudication.md",1],
  [".local/tasks/task-2072.md","implementation-contract.md",2],
  ["attached_assets/LIBERTY_TASK_2072_C1_REPLIT_AUDIT_CORRECTIONS_2026-10-07_1791367791047.md","submitted-review.md",3],
  ["attached_assets/LIBERTY_STAGE3_TASK_C1_PREFLIGHT_BUILD_MASTER_PROMPT_1791318462918.md","original-c1.md",4],
  [".local/tasks/liberty-stage3-c-preflight-common.md","common.md",4],
  [".local/tasks/liberty-stage3-post-2071-audit.md","inheritance.md",4],
] as const;
const provenance = inputs.map(([source,name,precedence])=>{
  const portable = `${root}/inputs/${name}`;
  const bytes = fs.readFileSync(fs.existsSync(source) ? source : portable);
  if(!fs.existsSync(source)) {
    const previous=JSON.parse(fs.readFileSync(`${root}/provenance.json`,"utf8"));
    const expected=previous.inputs.find((input:{portable:string})=>input.portable===`inputs/${name}`)?.sha256;
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),expected,`unavailable original requires its exact portable copy: ${source}`);
  }
  fs.writeFileSync(`${root}/inputs/${name}`,bytes);
  return {source,portable:`inputs/${name}`,sha256:crypto.createHash("sha256").update(bytes).digest("hex"),precedence,
    status:"exact available specification/evidence, not a current runtime pass"};
});
fs.writeFileSync(`${root}/provenance.json`,JSON.stringify({
  baseline:"442fd044f10f52db4bf391dabcb1299403314eaf",
  sourceHead:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),
  toolchain:{node:process.version,npm:execFileSync("npm",["--version"],{encoding:"utf8"}).trim()},
  servingIdentity:"Only isolated test candidate; no deployed identity inferred",inputs:provenance,
},null,2)+"\n");
const contract=fs.readFileSync(`${root}/inputs/implementation-contract.md`,"utf8");
const original=fs.readFileSync(`${root}/inputs/original-c1.md`,"utf8");
const table = contract.split("## Appendix C. Current 147-route")[1].split("\n## ")[0];
const rows = table.split("\n").filter(l=>/^\| R-\d{3} \|/.test(l)).map(l=>{
  const [id,pattern,currentTarget,guard,owner] = l.split("|").slice(1,-1).map(s=>s.trim().replaceAll("`",""));
  return {id,pattern,currentTarget,guard,owner};
});
assert.equal(rows.length,147);
assert.equal(new Set(rows.map(r=>r.pattern)).size,147);
const app=fs.readFileSync("client/src/App.tsx","utf8");
const source=ts.createSourceFile("App.tsx",app,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const routeSources = new Map<string,string[]>();
let appLiteralCount=0;
const visit=(node:ts.Node)=>{
  if(ts.isJsxAttribute(node) && node.name.getText(source)==="path" && node.initializer && ts.isStringLiteral(node.initializer)){
    appLiteralCount++;
    const pattern=node.initializer.text;
    if(pattern==="/dashboard" || pattern.startsWith("/dashboard/")){
      const element=node.parent.parent;
      const full = ts.isJsxOpeningElement(element) ? element.parent.getText(source) : element.getText(source);
      routeSources.set(pattern,[...(routeSources.get(pattern)??[]),full]);
    }
  }
  ts.forEachChild(node,visit);
};
visit(source);
assert.deepEqual([...routeSources.keys()].sort(),rows.map(r=>r.pattern).sort());
const panels = original.split("\n").filter(l=>/^\| T-\d{3} \|/.test(l)).map(l=>{
  const [id,url,label,target,disposition]=l.split("|").slice(1,-1).map(s=>s.trim());
  const owner=["T-218","T-219","T-220"].includes(id) ? "C4" : disposition.match(/C[2-5]/)?.[0];
  assert.ok(owner,`panel owner ${id}`);
  return {id,url,label,target,owner,disposition:"Deferred to the specific workspace owner; historical observation, not a C1 action pass",
    originalDisposition:disposition};
});
assert.equal(panels.length,309);
assert.equal(new Set(panels.map(p=>p.id)).size,309);
fs.writeFileSync(`${root}/panel-dispositions.json`,JSON.stringify(panels,null,2)+"\n");
const futureRows = new Map(original.split("\n").filter(l=>/^\| R-\d{3} \|/.test(l)).map(l=>{
  const fields=l.split("|").slice(1,-1).map(s=>s.trim());
  return [fields[0],fields[4]];
}));
const imports = new Map<string,string>();
for(const m of app.matchAll(/const (\w+) = lazy\(\(\) => import\(["']([^"']+)["']\)\)/g))
  imports.set(m[1],path.resolve("client/src",m[2].replace(/^@\//,""))+".tsx");
function componentPolicies(component:string) {
  const file=imports.get(component);
  const text=file && fs.existsSync(file) ? fs.readFileSync(file,"utf8") : "";
  const selectors=component==="ContactDetail" ? [...contactSections] :
    [...new Set([...text.matchAll(/<TabsTrigger[^>]*value=["']([^"']+)["']/g)].map(m=>m[1]))];
  const queryKeys=[...new Set([...text.matchAll(/(?:params|Params|searchParams|p|next)\.get\(["']([^"']+)["']\)/g)].map(m=>m[1]))];
  const children:Array<{selector:string;renderedComponents:string[];conditionExpressions:string[]}>=[];
  if(file && text){
    const tree=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    const visitChild=(node:ts.Node)=>{
      if(ts.isJsxElement(node) && node.openingElement.tagName.getText(tree)==="TabsContent"){
        const value=node.openingElement.attributes.properties.find(p=>ts.isJsxAttribute(p)&&p.name.getText(tree)==="value");
        if(value && ts.isJsxAttribute(value) && value.initializer && ts.isStringLiteral(value.initializer)){
          const conditions:string[]=[];
          for(let p=node.parent;p;p=p.parent){
            if(ts.isBinaryExpression(p) && p.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken)
              conditions.push(p.left.getText(tree));
            if(ts.isConditionalExpression(p))conditions.push(p.condition.getText(tree));
          }
          const renderedComponents=[...new Set([...node.getText(tree).matchAll(/<([A-Z]\w*)\b/g)].map(m=>m[1]))].filter(name=>name!=="TabsContent");
          children.push({selector:value.initializer.text,renderedComponents,conditionExpressions:conditions});
        }
      }
      ts.forEachChild(node,visitChild);
    };
    visitChild(tree);
  }
  return {source:file ? path.relative(process.cwd(),file) : null,selectors,queryKeys,children,
    interpretation:"Source mount conditions are evidence, not an authorization grant; actual wrapper/handler and child tests remain required."};
}
const specialQueries: Record<string,string[]> = {
  "/dashboard/contacts":["tab","search","sort","archived","status","recordClass","limit","offset","churnRisk","noOutreach","blocked","emailHealth","assignedToMe","vertical","tag","contactedToday","hasAssignee","leadSource","lifecycle","stale","recentlyUpdated","neverContacted","notContactedIn30","noDeal","createdThisWeek"],
  "/dashboard/contacts-leads":["tab","search","sort","archived","status","recordClass","limit","offset","churnRisk","noOutreach","blocked","emailHealth","assignedToMe","vertical","tag","contactedToday","hasAssignee","leadSource","lifecycle","stale","recentlyUpdated","neverContacted","notContactedIn30","noDeal","createdThisWeek"],
  "/dashboard/reporting":["tab","financialTab","selectionIssue","revenueView","revenueQuery","revenueParentContactId","revenuePeriod","outreachView"],
  "/dashboard/financial-hub":["tab","financialTab","selectionIssue","revenueView","revenueQuery","revenueParentContactId","revenuePeriod"],
  "/dashboard/merchant-risk":["tab","healthView"],
  "/dashboard/merchant-health":["healthView"],
  "/dashboard/underwriting":["underwritingView"],
  "/dashboard/boarding":["status"],
  "/dashboard/merchant-applications":["status"],
  "/dashboard/leaderboard":["metric","period"],
  "/dashboard/onboarding":["tab"],
  "/dashboard/support-hub":["tab"],
  "/dashboard/merchant-success":["tab"],
  "/dashboard/system-health":["tab","view","selectionIssue"],
  "/dashboard/operator":["tab","view","selectionIssue"],
  // C5 selectors (registered once in crm-destination-state.ts `c5RouteKeys`).
  "/dashboard/admin-hub":["tab","area","integrationsView"],
  "/dashboard/training":["tab"],
  "/dashboard/knowledge-admin":["tab"],
  "/dashboard/settings/integrations":["integrationsView"],
  // D05 hub tabs (decoded once by hubTabState in crm-destination-state.ts).
  "/dashboard/ghl-integration":["tab"],
  "/dashboard/content-hub":["tab"],
  "/dashboard/playbooks":["tab"],
  "/dashboard/sdr-hub":["tab"],
  "/dashboard/deliverability-hub":["tab"],
};
const registry=rows.map(row=>{
  const declarations=routeSources.get(row.pattern)!;
  const component=declarations.map(s=>s.match(/component=\{(\w+)\}/)?.[1]).find(Boolean) ?? row.currentTarget;
  const policies=componentPolicies(component);
  const namespace = row.pattern.includes("/companies/") ? "company"
    : row.pattern.includes("/business/") ? "business"
    : row.pattern.includes("/contacts/") ? "contact" : null;
  const owner=row.owner.slice(0,2);
  const roleLists=declarations.flatMap(s=>[...s.matchAll(/allowedRoles=\{(\[[^}]+\])\}/g)].map(m=>JSON.parse(m[1])));
  return {...row,owner,workspace:row.owner,sourceDeclarations:declarations,
    renderOwner:row.owner,
    actualWrapperKinds:[...new Set(declarations.flatMap(text=>[...text.matchAll(/<(ProtectedRoute|AgentRoute|PartnerProtectedRoute)\b/g)].map(m=>m[1])))],
    component,componentPolicy:policies,
    wrapperRoles:roleLists[0] ?? (row.guard.startsWith("AgentRoute") ? ["agent"] : row.guard.startsWith("PartnerProtectedRoute") ? ["partner","admin"] : null),
    childCapabilities:row.pattern==="/dashboard/system-health" ? {monitor:["admin"],incidents:["admin"],readiness:["admin","manager"],seo:["admin","manager"]}
      : row.pattern==="/dashboard/lead-intelligence" || row.pattern==="/dashboard/command-center"
        ? {privileged:["admin","manager"],legacyInline:["agent","affiliate","other"]} : {},
    entityParameters:row.pattern.includes(":id") ? [{parameter:"id",namespace:namespace ?? "mobile-contact",type:"positive-local-integer"}] : [],
    queryPolicy:{allowed:[...new Set([...(specialQueries[row.pattern]??policies.queryKeys),"contactId","companyId","businessId","dealId","sourceId","from"])],
      selectors:policies.selectors,duplicates:"equal-collapse; conflict explicit safe fallback",unknown:"not authority; adopted codecs strip unregistered keys"},
    fragmentPolicy:"registered local anchor matching #[a-z][a-z0-9_-]{0,63}; never external navigation",
    futureTarget:futureRows.get(row.id)??row.pattern,
    status:"current render retained; future target is NOT activated by this registry",
    outcomes:{invalid:"reason + permitted fallback; no name lookup",forbidden:"existing wrapper/child denial before mount/request",conflict:"reason + permitted fallback"},
  };
});
fs.writeFileSync("client/src/lib/crm-route-registry.generated.json",JSON.stringify(registry,null,2)+"\n");
fs.writeFileSync(`${root}/route-census.json`,JSON.stringify({appLiteralCount,patterns:registry.length,
  routePartitions:Object.fromEntries(["C2","C3","C4","C5"].map(o=>[o,registry.filter(r=>r.owner===o).length])),
  panelPartitions:Object.fromEntries(["C2","C3","C4","C5"].map(o=>[o,panels.filter(r=>r.owner===o).length])),
  status:"source evidence inventory only; not effective-handler/browser/action acceptance"},null,2)+"\n");
console.log("Portable exact inputs and 147-route/309-panel evidence generated. No acceptance inferred.");
