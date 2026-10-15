import fs from "node:fs";
import ts from "typescript";
import {build} from "esbuild";
import {decideOrganizationIdentity,normalOrganizationValue,normalOrganizationName} from "../../server/services/organization-resolution-policy";
import {normalizeStateIdentity,stateIdentitySql} from "../../shared/state-identity";
import {mapProviderCsvRow} from "../../server/services/provider-import-columns";

// Extract the actual, dependency-free production normalizers rather than
// importing the live SDR database/service graph into a read-only audit.
const source=fs.readFileSync("server/services/sdr/dedupe.ts","utf8");
const ast=ts.createSourceFile("dedupe.ts",source,ts.ScriptTarget.Latest,true);
const functions=ast.statements.filter(node=>ts.isFunctionDeclaration(node)
  && ["normalizeDomain","normalizePhoneE164"].includes(node.name?.text??""));
if(functions.length!==2)throw Error("NORMALIZER_CAPTURE_DRIFT");
const normalized=ts.transpile(functions.map(node=>node.getText(ast)).join("\n")
  .replaceAll("export function","function"),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
const normalize=new Function(normalized+";return {normalizeDomain,normalizePhoneE164};")();
const directory="generated-artifacts/intake-incremental";
const columns=ts.createSourceFile("columns.ts",fs.readFileSync("server/services/provider-import-columns.ts","utf8"),
  ts.ScriptTarget.Latest,true);
const maps=columns.statements.filter(node=>ts.isVariableStatement(node)
  && node.declarationList.declarations.some(d=>["googleMapsColumnMap","apolloColumnMap","genericColumnMap"].includes(d.name.getText(columns))));
const mapCode=ts.transpile(maps.map(node=>node.getText(columns)).join("\n"),
  {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
const columnMaps=new Function(mapCode+";return [googleMapsColumnMap,apolloColumnMap,genericColumnMap];")();
const businessKeys=[...new Set(columnMaps.flatMap((map:any)=>Object.entries(map)
  .filter(([,value])=>["companyName","website","phone","city","state","address"].includes(String(value)))
  .map(([key])=>key.replace(/\s+/g,"_"))))];
fs.writeFileSync(`${directory}/organization-business-raw-keys.json`,JSON.stringify(businessKeys));
if(process.argv.includes("--projection-only"))process.exit(0);
const originals=JSON.parse(fs.readFileSync(`${directory}/current-organization-inputs.json`,"utf8"));
const inputs=originals.map((row:any)=>{
  if(!row.rawAvailable || row.placeKeys?.length>1 || row.organizationKeys?.length>1)
    throw Error("ORIGINAL_RAW_BUSINESS_KEYS_UNQUALIFIED");
  if(!row.rawRow)throw Error("PROJECTED_ORIGINAL_BUSINESS_COLUMNS_REQUIRED");
  const m=mapProviderCsvRow(row.rawRow,row.sourceFormat),place=row.placeKeys?.[0]??null;
  const identity={canonicalName:m.companyName?.trim(),websiteDomain:normalOrganizationValue(normalize.normalizeDomain(m.website)),
    googlePlaceId:place,mainPhone:normalize.normalizePhoneE164(m.phone)?.replace(/\D/g,"")??null,
    city:normalOrganizationValue(m.city),state:normalizeStateIdentity(m.state),streetAddress:m.address??null,
    sourceIdentity:{sourceSystem:row.sourceFormat==="google_maps_outscraper"?"outscraper":"apollo",
      sourceType:place?"place":"provider_import",
      stableKey:place??row.organizationKeys?.[0]??`import:${row.executionId}:row:${row.row}`}};
  return {itemId:row.itemId,input:identity,normalName:normalOrganizationName(identity.canonicalName)};
});
const exact=`EXISTS(SELECT 1 FROM canonical_source_links sl WHERE sl.business_id=b.id
  AND sl.source_system=x.value->'input'->'sourceIdentity'->>'sourceSystem'
  AND sl.source_type=x.value->'input'->'sourceIdentity'->>'sourceType'
  AND sl.stable_key=x.value->'input'->'sourceIdentity'->>'stableKey')`;
const query=`WITH inputs AS (SELECT value FROM jsonb_array_elements($1::jsonb))
 SELECT jsonb_build_object('itemId',x.value->>'itemId','input',x.value->'input',
 'candidates',coalesce(jsonb_agg(jsonb_build_object('id',b.id,'canonicalName',b.canonical_name,
 'websiteDomain',b.website_domain,'googlePlaceId',b.google_place_id,'mainPhone',b.main_phone,
 'city',b.city,'state',b.state,'streetAddress',b.street_address,'exactSource',${exact}))
 FILTER(WHERE b.id IS NOT NULL),'[]'::jsonb)) record
 FROM inputs x LEFT JOIN businesses b ON (
 ${exact}
 OR (x.value->'input'->>'googlePlaceId' IS NOT NULL AND b.google_place_id=x.value->'input'->>'googlePlaceId')
 OR (x.value->'input'->>'websiteDomain' IS NOT NULL AND lower(btrim(b.website_domain))=x.value->'input'->>'websiteDomain')
 OR (x.value->'input'->>'mainPhone' IS NOT NULL
 AND regexp_replace(coalesce(b.main_phone,''),'[^0-9]','','g')=ANY(ARRAY[
 x.value->'input'->>'mainPhone',CASE
 WHEN length(x.value->'input'->>'mainPhone')=10 THEN '1'||(x.value->'input'->>'mainPhone')
 WHEN length(x.value->'input'->>'mainPhone')=11 AND left(x.value->'input'->>'mainPhone',1)='1'
 THEN substring(x.value->'input'->>'mainPhone' FROM 2) ELSE NULL END]))
 OR (x.value->'input'->>'city' IS NOT NULL AND x.value->'input'->>'state' IS NOT NULL
 AND b.normalized_name=x.value->>'normalName' AND lower(btrim(coalesce(b.city,'')))=x.value->'input'->>'city'
 AND ${stateIdentitySql("b.state")}=x.value->'input'->>'state')) GROUP BY x.value`;
fs.writeFileSync(`${directory}/organization-prepared-inputs.json`,JSON.stringify(inputs));
fs.writeFileSync(`${directory}/organization-candidates.sql`,query);
await build({entryPoints:["server/services/organization-resolution-policy.ts"],bundle:true,platform:"node",
  format:"esm",outfile:`${directory}/organization-policy.mjs`});
console.log(`Prepared ${inputs.length} original-row organization identities; no DB calls or writes.`);
if(process.argv.includes("--classify")){
  const cases=JSON.parse(fs.readFileSync(`${directory}/current-organization-candidates.json`,"utf8"));
  const digits=(v:any)=>String(v??"").replace(/\D/g,"").replace(/^1(?=\d{10}$)/,"");
  const address=(v:any)=>String(v??"").toLowerCase().replace(/[^a-z0-9]/g,"");
  const rows=cases.map((row:any)=>({...row,result:decideOrganizationIdentity(row.input,row.candidates),
    candidateConflictFacts:row.candidates.map((candidate:any)=>{
      const input=row.input;
      const conflicts=[
        input.googlePlaceId&&candidate.googlePlaceId&&input.googlePlaceId.trim()!==candidate.googlePlaceId.trim()?"place":null,
        input.websiteDomain&&candidate.websiteDomain&&normalOrganizationValue(input.websiteDomain)!==normalOrganizationValue(candidate.websiteDomain)?"domain":null,
        digits(input.mainPhone)&&digits(candidate.mainPhone)&&digits(input.mainPhone)!==digits(candidate.mainPhone)?"phone":null,
        input.city&&candidate.city&&normalOrganizationValue(input.city)!==normalOrganizationValue(candidate.city)?"city":null,
        input.state&&candidate.state&&normalizeStateIdentity(input.state)!==normalizeStateIdentity(candidate.state)?"state":null,
        address(input.streetAddress)&&address(candidate.streetAddress)&&address(input.streetAddress)!==address(candidate.streetAddress)?"street":null,
        normalOrganizationName(input.canonicalName)&&normalOrganizationName(candidate.canonicalName)&&normalOrganizationName(input.canonicalName)!==normalOrganizationName(candidate.canonicalName)?"name":null,
      ].filter(Boolean);
      return {businessId:candidate.id,exactSource:candidate.exactSource,conflicts};
    })}));
  const counts:Record<string,number>={},conflictGroups:Record<string,number>={};
  for(const row of rows){
    const key=row.result.kind+(row.result.reasonCode?":"+row.result.reasonCode:"");
    counts[key]=(counts[key]??0)+1;
    const group=JSON.stringify([...new Set(row.candidateConflictFacts.map((c:any)=>c.conflicts.join(",")))].sort());
    conflictGroups[group]=(conflictGroups[group]??0)+1;
  }
  fs.writeFileSync(`${directory}/current-organization-qualification.json`,
    JSON.stringify({observedAt:new Date().toISOString(),counts,conflictGroups,rows}));
  console.log(JSON.stringify({rows:rows.length,counts,conflictGroups}));
}
