import assert from "node:assert/strict";
import {applicationStatuses,boardingStatuses,outreachViews,leaderboardMetrics,leaderboardPeriods,retainedSelection,
  retainedSelectionUrl,outreachAliasUrl} from "../client/src/lib/crm-destination-state";
import {readFileSync} from "node:fs";
import {financialState,financialUrl,selectValue,revenueViews,underwritingViews,supportViews,onboardingViews} from "../client/src/lib/crm-destination-state";
import {rfiViews,rfiUrl,c4WorkspaceSelection} from "../client/src/lib/crm-destination-state";
import {RFI_STATUSES} from "../shared/schema";
import {projectPayoutLedger} from "../server/services/payout-ledger-projection";
import {reviewQueueViews,reviewQueueUrl,c4WorkspaceUrl} from "../client/src/lib/crm-destination-state";
import {portfolioFollowupDay,portfolioFollowupDays,portfolioFollowupCarrier} from "../client/src/lib/portfolio-followup-date";
import {requireDealTransitionObservation,DealTransitionObservationError} from "../client/src/lib/deal-transition-observation";
import {requireNoPriorChargebackIntent} from "../client/src/lib/chargeback-intent-observation";
import {projectResidualObservations} from "../server/services/residual-observation-projection";
import {revenueFilterState,revenueFilterUrl} from "../client/src/lib/crm-destination-state";
import {residualExportCell} from "../client/src/lib/residual-observation-export";
import {parseOperationsSpend,operationsReportSchema} from "../shared/operations-report";
import {operationsReportCsv} from "../client/src/lib/operations-report-export";
import { npsStatsReadSchema, npsRecordsReadSchema, isScoredNpsRecord } from "../shared/nps-observation";
import { merchantHealthUrl, merchantHealthAliasUrl, merchantHealthViews } from "../client/src/lib/crm-destination-state";
import { residualPayeeObservationsSchema } from "../shared/residual-payee-observation";
import { residualPartnerObservationsSchema } from "../shared/residual-partner-observation";
import { isCalendarStartInWindow } from "../client/src/lib/calendar-window";
import {workDueDay,workDueDateChange} from "../client/src/lib/work-due-date";
import {churnSummarySchema,churnWeightsSchema,churnScoresSchema} from "../client/src/lib/churn-observation-reader";
import {testimonialViews,testimonialUrl,testimonialAliasUrl} from "../client/src/lib/crm-destination-state";

// Source/codec checks only. No browser, handler, DB, provider or action claim.
for(const [path,key,allowed,fallback] of [
  ["/dashboard/merchant-applications","status",applicationStatuses,"all"],
  ["/dashboard/boarding","status",boardingStatuses,"all"],
  ["/dashboard/reporting","outreachView",outreachViews,"campaigns"],
  ["/dashboard/leaderboard","metric",leaderboardMetrics,"deals"],
  ["/dashboard/leaderboard","period",leaderboardPeriods,"month"],
] as const){
  for(const value of allowed){
    assert.equal(retainedSelection(`${key}=${value}`,key,allowed as readonly string[],fallback).value,value);
    const url=retainedSelectionUrl(path,"contactId=42&page=9&offset=100&cursor=old&unsafe=x","#records",key,allowed as readonly string[],value);
    const params=new URL(url,"http://isolated.test").searchParams;
    assert.equal(params.get(key),value);assert.equal(params.get("contactId"),"42");
    for(const dropped of ["page","offset","cursor","unsafe"])assert.equal(params.has(dropped),false);
    assert.equal(retainedSelection(`${key}=${value}&${key}=${value}`,key,allowed as readonly string[],fallback).issues.length,0);
  }
  assert.equal(retainedSelection(`${key}=unknown`,key,allowed as readonly string[],fallback).issues[0].kind,"invalid");
  assert.equal(retainedSelection(`${key}=${allowed[0]}&${key}=${allowed[1]}`,key,allowed as readonly string[],fallback).issues[0].kind,"conflict");
}
assert.throws(()=>retainedSelectionUrl("/dashboard/unregistered","","","status",applicationStatuses,"all"));
assert.equal(new URL(outreachAliasUrl("contactId=42&outreachView=ab-testing","#records"),"http://isolated.test").searchParams.get("outreachView"),"ab-testing");
const originalZone=process.env.TZ;
try{
  for(const timezone of ["UTC","America/Bogota","America/New_York","Pacific/Apia"]){
    process.env.TZ=timezone;
    const original="2026-10-09T04:22:33.123456Z";
    assert.deepEqual(workDueDateChange(workDueDay(original),original),{},"Unchanged due day omits timestamp, preserving stored precision/time");
    assert.deepEqual(workDueDateChange("",original),{dueDate:null},"Explicit clear of a populated due day");
    const changed=workDueDateChange("2026-10-11",original).dueDate!;
    assert.equal(workDueDay(changed),"2026-10-11");
    assert.equal(new Date(changed).getHours(),0);
    assert.throws(()=>workDueDateChange("2026-02-30",original));
  }
  process.env.TZ="Pacific/Apia";
  assert.throws(()=>workDueDateChange("2011-12-30"),"C1 strict local-day validator rejects a skipped day");
}finally{if(originalZone===undefined)delete process.env.TZ;else process.env.TZ=originalZone;}
assert.deepEqual(workDueDateChange("",null),{});
assert.deepEqual(churnSummarySchema.parse([]),[]);
for(const rows of [[{tier:"High",count:"2"}],[{tier:"High",count:-1}],[{tier:"Unknown",count:1}],
  [{tier:"High",count:1},{tier:"High",count:2}]]){
  assert.equal(churnSummarySchema.safeParse(rows).success,false,"Malformed summary is unavailable, not zero");
}
assert.equal(churnWeightsSchema.safeParse([{id:1,signalKey:"nps_score",label:"NPS",weight:NaN}]).success,false);
assert.equal(churnWeightsSchema.safeParse([{id:1,signalKey:"nps_score",label:"NPS",weight:1},
  {id:2,signalKey:"nps_score",label:"Other",weight:2}]).success,false);
assert.equal(churnScoresSchema.safeParse([{id:1,contactId:1,churnScore:null}]).success,false);
for(const value of testimonialViews){
  const url=testimonialUrl("?contactId=42&testimonialView=pending","#proof",value);
  const params=new URL(url,"https://fixture.invalid").searchParams;
  assert.equal(params.get("tab"),"testimonials");
  assert.equal(params.get("testimonialView"),value);
  assert.equal(params.get("contactId"),"42");
  assert.ok(url.endsWith("#proof"));
}
for(const raw of ["testimonialView=approved&testimonialView=rejected","testimonialView=wrong"]){
  const alias=testimonialAliasUrl(`?${raw}&contactId=42`,"#proof");
  const params=new URL(alias,"https://fixture.invalid").searchParams;
  assert.ok(selectValue(params,"testimonialView",testimonialViews,"pending").issues.length);
  assert.equal(params.get("contactId"),"42");
}
assert.equal(selectValue(new URLSearchParams("testimonialView=approved&testimonialView=approved"),
  "testimonialView",testimonialViews,"pending").issues.length,0);
const routes=JSON.parse(readFileSync("client/src/lib/crm-route-registry.generated.json","utf8"));
assert.deepEqual(rfiViews.filter(value=>value!=="all"),RFI_STATUSES,"Retain every actual RFI status, including Waiting on Merchant");
for(const view of rfiViews){
  const href=rfiUrl("?contactId=23&id=29","#proof",view);
  const url=new URL(href,"https://fixture.invalid");
  assert.equal(url.pathname,"/dashboard/support-hub");assert.equal(url.searchParams.get("tab"),"rfis");
  assert.equal(url.searchParams.get("id"),"29");assert.equal(url.hash,"#proof");
  assert.equal(c4WorkspaceSelection(url.search,"rfiView",rfiViews,"all").value,view);
  const closed=new URL(rfiUrl(url.search,url.hash,undefined,true),"https://fixture.invalid");
  assert.equal(closed.searchParams.has("id"),false);assert.equal(closed.searchParams.get("contactId"),"23");
  assert.equal(closed.searchParams.get("rfiView"),view);
}
for(const raw of ["?rfiView=bad","?rfiView=Open&rfiView=Closed"]){
  const url=new URL(rfiUrl(raw,"#proof"),"https://fixture.invalid");
  assert.equal(c4WorkspaceSelection(url.search,"rfiView",rfiViews,"all").issues.length,1);
}
const panels=JSON.parse(readFileSync("docs/certification/stage3-c1/panel-dispositions.json","utf8"));
assert.equal(routes.filter((r:any)=>r.owner==="C4").length,39);
assert.equal(panels.filter((p:any)=>p.owner==="C4").length,70);
for(const selector of revenueViews)
  assert.equal(selectValue(new URLSearchParams({revenueView:selector}),"revenueView",revenueViews,"dashboard").value,selector);
for(const selector of underwritingViews)
  assert.equal(selectValue(new URLSearchParams({underwritingView:selector}),"underwritingView",underwritingViews,"queue").value,selector);
for(const selector of supportViews)
  assert.equal(selectValue(new URLSearchParams({tab:selector}),"tab",supportViews,"tickets").value,selector);
for(const selector of reviewQueueViews){
  assert.equal(selectValue(new URLSearchParams({reviewView:selector}),"reviewView",reviewQueueViews,"pending").value,selector);
  const url=reviewQueueUrl("dealId=123&unregistered=bad","#review",selector);
  assert.equal(url,`/dashboard/support-hub?dealId=123&reviewView=${selector}&tab=review-queue#review`);
}
assert.equal(selectValue(new URLSearchParams("reviewView=approved&reviewView=approved"),"reviewView",reviewQueueViews,"pending").issues.length,0);
assert.equal(selectValue(new URLSearchParams("reviewView=approved&reviewView=pending"),"reviewView",reviewQueueViews,"pending").issues[0].kind,"conflict");
assert.equal(selectValue(new URLSearchParams("reviewView=invalid"),"reviewView",reviewQueueViews,"pending").issues[0].kind,"invalid");
assert.match(c4WorkspaceUrl("/dashboard/support-hub","reviewView=invalid","#review","tab",supportViews,"tickets","review-queue"),/reviewView=invalid/);
for(const selector of onboardingViews)
  assert.equal(selectValue(new URLSearchParams({tab:selector}),"tab",onboardingViews,"overview").value,selector);
assert.equal(selectValue(new URLSearchParams("underwritingView=approved&underwritingView=config"),"underwritingView",underwritingViews,"queue").issues[0].kind,"conflict");
assert.equal(selectValue(new URLSearchParams("revenueView=unknown"),"revenueView",revenueViews,"dashboard").issues[0].kind,"invalid");
assert.equal(financialState("tab=revenue&financialTab=forecasting").value,"forecasting");
assert.equal(financialUrl("tab=financial&financialTab=revenue&revenueView=history&contactId=17","#evidence"),
  "/dashboard/reporting?contactId=17&tab=financial&financialTab=revenue&revenueView=history#evidence");
const portfolio=readFileSync("client/src/pages/dashboard/MerchantPortfolio.tsx","utf8");
assert.ok(/useState(?:<25 \| 50 \| 100>)?\(50\)/.test(portfolio),"Portfolio default page size must remain 50");
assert.match(portfolio,/loaded page only/);
assert.match(portfolio,/offset/);
const health=readFileSync("client/src/pages/dashboard/MerchantHealth.tsx","utf8");
assert.doesNotMatch(health,/100\s*-\s*alerts\.length/);
const kickoff=readFileSync("client/src/pages/dashboard/OnboardingKickoff.tsx","utf8");
assert.doesNotMatch(kickoff,/apiRequest\("POST", "\/api\/(?:deals|tasks)"/);
assert.match(kickoff,/Closed Won Sales → linked Onboarding preparation/);
assert.match(kickoff,/Idempotency-Key/);
assert.match(kickoff,/Read accepted intent/);
assert.doesNotMatch(kickoff,/triggerClosedWonOnboarding/);
for(const file of ["client/src/pages/dashboard/Chargebacks.tsx","client/src/pages/dashboard/contact-detail-tabs/ChargebacksTab.tsx"]) {
  const source=readFileSync(file,"utf8");
  assert.match(source,/Accepted.*queued/i);
  assert.doesNotMatch(source,/Evidence packet transmitted/);
}
for(const timezone of ["UTC","America/New_York","Pacific/Kiritimati","Pacific/Pago_Pago"]) {
  process.env.TZ=timezone;
  const selected=new Date(2026,9,8);
  const carrier=portfolioFollowupCarrier(selected);
  assert.equal(portfolioFollowupDay(carrier)?.getDate(),8);
  assert.equal(portfolioFollowupDays(carrier,new Date(2026,9,8,23,59)),0);
  assert.equal(portfolioFollowupDays(carrier,new Date(2026,9,9)), -1);
}
assert.equal(portfolioFollowupDay("2026-02-31"),undefined);
const observed={dealId:42,stage:"New Lead",stages:["Contacted"],capability:"structural_policy_observation_only"};
assert.doesNotThrow(()=>requireDealTransitionObservation(observed,42,"New Lead","Contacted"));
assert.doesNotThrow(()=>requireDealTransitionObservation(observed,42,"New Lead","New Lead"));
for(const wrong of [null,{}, {...observed,dealId:43},{...observed,stage:"Closed Lost"},
  {...observed,capability:"permission_grant"},{...observed,stages:[true]}])
  assert.throws(()=>requireDealTransitionObservation(wrong,42,"New Lead","Contacted"),DealTransitionObservationError);
assert.throws(()=>requireDealTransitionObservation(observed,42,"New Lead","Closed Won"),DealTransitionObservationError);
const absence={chargebackId:42,hasPriorIntent:false,intentExistenceCompleteness:"all_case_commands"};
const residualObserved=projectResidualObservations([
  {id:1,registered_mid_id:8,member_contact_id:10,contact_id:99,merchant_mid:"123456789",revenue:"0.10",cost:null},
  {id:2,registered_mid_id:8,member_contact_id:10,merchant_mid:"123456789",revenue:"0.20",cost:"0.01"},
]);
assert.equal(residualObserved.summary.revenue,0.3);
assert.equal(residualObserved.summary.cost,null);
assert.equal(residualObserved.summary.registeredMidCount,1);
assert.equal(residualObserved.rows[0].registeredMidContactId,10);
assert.equal(residualObserved.rows[0].observationContactId,99);
assert.ok(!JSON.stringify(residualObserved).includes("123456789"));
assert.equal(projectResidualObservations([]).summary.revenue,null);
const filterRoundTrip=revenueFilterUrl("contactId=10&revenueView=history","#details",{query:"Alpha & Sons",parentContactId:12,period:"2026-10"});
assert.deepEqual(revenueFilterState(new URL(filterRoundTrip,"https://fixture.invalid").search),{query:"Alpha & Sons",parentContactId:12,period:"2026-10",issues:[]});
for(const malformed of ["revenueParentContactId=0","revenueParentContactId=2147483648","revenueParentContactId=1&revenueParentContactId=2","revenuePeriod=2026-99"])
  assert.ok(revenueFilterState(malformed).issues.length>0);
const filtered=projectResidualObservations([
  {id:7,merchant_name:"Alpha",registered_mid_id:8,month:"2026-10",revenue:"10.10"},
  {id:8,merchant_name:"Beta",registered_mid_id:9,month:"2026-09",revenue:"30.20"},
],{search:"Alpha",period:"2026-10"});
assert.deepEqual(filtered.rows.map(r=>r.id),[7]);
assert.equal(filtered.summary.revenue,10.1);
assert.equal(filtered.series[0].totalRevenue,10.1);
assert.equal(residualExportCell("=HYPERLINK(\"https://fixture.invalid\")"),"'=HYPERLINK(\"https://fixture.invalid\")");
assert.equal(residualExportCell("\t+formula"),"'\t+formula");
assert.equal(residualExportCell(-10.1),-10.1);
assert.equal(residualExportCell(null),"Unavailable");
assert.equal(parseOperationsSpend("10.01"),10.01);
assert.equal(parseOperationsSpend(".25"),0.25);
assert.equal(parseOperationsSpend(undefined),0);
for(const invalid of ["-10","NaN","Infinity","1e6","1abc","1.001",["1","2"],"999999999999999999999"])
  assert.throws(()=>parseOperationsSpend(invalid));
const operationFixture=operationsReportSchema.parse({
  days:30,adSpend:10.01,cplBySource:[],closeRateByVertical:[],sequenceReplyRates:[],
  funnel:[],overdueTasks:[],
  incidentSummary:{queueFailures7d:0,ghlSyncFailures7d:0,mostRecentQueueIncident:null,mostRecentGhlIncident:null},
  meta:{exact:true,asOf:"2026-10-08T12:00:01.000Z",scope:"production",
    snapshotConsistency:"unavailable",sourceCapture:{acquisition:{requestedAt:"2026-10-08T12:00:00.000Z",completedBy:"2026-10-08T12:00:01.000Z",consistency:"independent"}},
    period:{startInclusive:"2026-09-08T12:00:00.000Z",endExclusive:"2026-10-08T12:00:00.000Z",timezone:"UTC",basis:"lead creation cohort"},
    operationalPeriods:{incidentsStartInclusive:"2026-10-01T12:00:00.000Z",incidentsEndExclusive:"2026-10-08T12:00:00.000Z",tasksAsOf:"2026-10-08T12:00:00.000Z"},
    units:{leads:"contacts",booked:"deals"},completeness:{sequenceReplies:"unavailable"},
    spendAllocation:{kind:"estimate",assumption:"proportional lead volume",authoritativeSpendSource:false,currency:"USD"},
  },
});
const csv=operationsReportCsv(["Source","Ratio","Unavailable ratio"],[[' =unsafe,"quoted"',10.01/3,null]],operationFixture);
assert.ok(csv.includes(`"' =unsafe,""quoted"""`),"formula-like quoted source is escaped");
assert.ok(csv.includes(`"${10.01/3}"`),"unrounded model ratio survives");
assert.ok(csv.includes('"Unavailable"'));
assert.ok(csv.includes('"2026-09-08T12:00:00.000Z"'));
assert.ok(csv.includes('"estimate"'));
assert.ok(operationsReportCsv(["Source"],[],operationFixture).includes('"Metadata only"'),"loaded-empty exports retain metadata, not fabricated rows");
assert.equal(operationsReportSchema.safeParse({...operationFixture,overdueTasks:null}).success,false);
assert.equal(operationsReportSchema.safeParse({...operationFixture,incidentSummary:{}}).success,false);
assert.equal(operationsReportSchema.safeParse({...operationFixture,cplBySource:[{source:"missing counts"}]}).success,false);
for(const raw of ["revenueParentContactId=1&revenueParentContactId=2","revenuePeriod=invalid"])
  assert.ok(revenueFilterState(new URL(financialUrl(raw),"https://fixture.invalid").search).issues.length>0);
assert.doesNotThrow(()=>requireNoPriorChargebackIntent(absence,42));
for(const unsafe of [null,{}, {data:[]}, {...absence,chargebackId:43},{...absence,hasPriorIntent:true},
  {...absence,intentExistenceCompleteness:"newest_25_only"}])
  assert.throws(()=>requireNoPriorChargebackIntent(unsafe,42));
const noNps = {
  total:0,submitted:0,scored:0,invalidSubmitted:0,avgScore:null,npsScore:null,
  promoters:0,passives:0,detractors:0,
  metadata:{source:"nps_responses",scope:"nonarchived_production_contact_surveys",
    period:"all_stored_observations_up_to_asOf",timezone:"UTC",asOf:"2026-10-08T12:00:00.123456Z",
    snapshotConsistency:"single_statement",units:"survey_records_not_unique_merchants"},
};
assert.ok(npsStatsReadSchema.safeParse(noNps).success);
assert.ok(npsStatsReadSchema.safeParse({...noNps,total:2,submitted:2,scored:2,avgScore:5,npsScore:0,promoters:1,detractors:1}).success,"observed balanced zero is distinct from unassessed");
for (const invalid of [
  {...noNps,avgScore:0,npsScore:0}, {...noNps,submitted:1},
  {...noNps,total:1,submitted:1,scored:1,avgScore:5,npsScore:0},
  {...noNps,metadata:{...noNps.metadata,asOf:"unknown"}},
]) assert.equal(npsStatsReadSchema.safeParse(invalid).success,false);
const npsRecord={id:1,score:0,createdAt:"2026-10-08T12:00:00Z",submittedAt:"2026-10-08T12:00:00Z",
  dayTrigger:30,comment:null,reviewRequestQueued:false,healthAlertCreated:false};
assert.ok(isScoredNpsRecord(npsRecordsReadSchema.parse([npsRecord])[0]));
for (const score of [null,-1,11]) assert.equal(isScoredNpsRecord({...npsRecord,score}),false);
assert.equal(npsRecordsReadSchema.safeParse([{...npsRecord,score:"0"}]).success,false);
assert.equal(isScoredNpsRecord({...npsRecord,submittedAt:null}),false);
for (const value of merchantHealthViews) {
  const destination=new URL(merchantHealthUrl("?contactId=3&dealId=4&unknown=unsafe","#nps",value),"https://fixture.invalid");
  assert.equal(destination.pathname,"/dashboard/merchant-risk");
  assert.equal(destination.searchParams.get("tab"),"health");assert.equal(destination.searchParams.get("healthView"),value);
  assert.equal(destination.searchParams.get("contactId"),"3");assert.equal(destination.searchParams.get("dealId"),"4");
  assert.equal(destination.searchParams.has("unknown"),false);assert.equal(destination.hash,"#nps");
}
assert.equal(new URL(merchantHealthAliasUrl("healthView=nps&healthView=alerts&contactId=7","#nps"),"https://fixture.invalid").searchParams.getAll("healthView").length,2);
assert.equal(selectValue(new URLSearchParams("healthView=nps&healthView=alerts"),"healthView",merchantHealthViews,"alerts").issues[0].kind,"conflict");
const payeeObservations = [
  {id:1,agent_id:101,agent_label:"Same captured name",registered_mid_id:1,month:"2026-10",revenue:"0.10",agent_commission:"0.01"},
  {id:2,agent_id:101,agent_label:"Same captured name",registered_mid_id:1,month:"2026-10",revenue:"0.20",agent_commission:"0.02"},
  {id:3,agent_id:102,agent_label:"Same captured name",registered_mid_id:2,month:"2026-10",revenue:"10.10",agent_commission:null},
  {id:4,agent_id:null,registered_mid_id:3,month:"2026-09",revenue:"0",agent_commission:"0"},
];
const payeeProjection = projectResidualObservations(payeeObservations);
assert.equal(payeeProjection.payees.length,3,"Labels cannot merge native agent IDs");
assert.equal(payeeProjection.payees[0].revenue,0.3,"Decimal coefficients sum exactly");
assert.equal(payeeProjection.payees[0].agentCommission,0.03);
assert.equal(payeeProjection.payees[0].observationCount,2);
assert.equal(payeeProjection.payees[0].registeredMidCount,1,"Repeated periods/rows are not extra MIDs or deals");
assert.equal(payeeProjection.payees[1].agentCommission,null,"Missing stored money is not zero");
assert.equal(payeeProjection.payees[2].agentId,null);
assert.equal(payeeProjection.payees[2].revenue,0,"A captured zero remains distinct from no observation");
assert.equal(projectResidualObservations(payeeObservations,{period:"2026-10"}).payees.length,2);
assert.deepEqual(projectResidualObservations(payeeObservations,{search:"Same captured name",period:"2026-09"}).payees,[]);
assert.deepEqual(projectResidualObservations([]).payees,[]);
assert.equal(residualPayeeObservationsSchema.safeParse([payeeProjection.payees[0],payeeProjection.payees[0]]).success,false);
assert.equal(residualPayeeObservationsSchema.safeParse([{...payeeProjection.payees[0],agentId:"101"}]).success,false);
assert.equal(residualPayeeObservationsSchema.safeParse([{...payeeProjection.payees[0],registeredMidCount:3}]).success,false);
const partnerRaw=[
  {id:1,registered_mid_id:1,month:"2026-10",revenue:"0.10",net_revenue:"0.05",partner_commission:"0.01",confirmed_import_status:"confirmed",authorized_observation_deal_id:1,observation_partner_org_id:11,partner_org_id:11,partner_org_name:"Equal label"},
  {id:2,registered_mid_id:1,month:"2026-10",revenue:"0.20",net_revenue:"0.10",partner_commission:"0.02",confirmed_import_status:"confirmed",authorized_observation_deal_id:1,observation_partner_org_id:11,partner_org_id:11,partner_org_name:"Equal label"},
  {id:3,registered_mid_id:2,month:"2026-10",revenue:"0",net_revenue:null,partner_commission:null,confirmed_import_status:"confirmed",authorized_observation_deal_id:2,observation_partner_org_id:12,partner_org_id:12,partner_org_name:"Equal label"},
  {id:4,registered_mid_id:3,month:"2026-10",confirmed_import_status:"confirmed",authorized_observation_deal_id:null},
  {id:5,registered_mid_id:4,month:"2026-10",confirmed_import_status:"confirmed",authorized_observation_deal_id:5,observation_partner_org_id:null,partner_org_id:null},
  {id:6,registered_mid_id:5,month:"2026-10",confirmed_import_status:"pending",authorized_observation_deal_id:6,partner_org_id:11},
];
const partnerProjection=projectResidualObservations(partnerRaw).partners;
assert.equal(partnerProjection.rows.length,2,"Equal partner labels cannot merge organization IDs");
assert.equal(partnerProjection.rows[0].totalGrossResidual,0.3);
assert.equal(partnerProjection.rows[0].totalPartnerCommission,0.03);
assert.equal(partnerProjection.rows[0].registeredMidCount,1);
assert.equal(partnerProjection.rows[1].totalGrossResidual,0);
assert.equal(partnerProjection.rows[1].totalNetResidual,null);
assert.equal(partnerProjection.confirmedObservationCount,5);
assert.equal(partnerProjection.unavailableRelationshipCount,1);
assert.equal(partnerProjection.unattributedObservationCount,1);
assert.equal(partnerProjection.unconfirmedOrUnlinkedImportCount,1);
assert.deepEqual(projectResidualObservations(partnerRaw,{period:"2026-09"}).partners.rows,[]);
assert.equal(residualPartnerObservationsSchema.safeParse({...partnerProjection,confirmedObservationCount:99}).success,false);
assert.equal(residualPartnerObservationsSchema.safeParse({...partnerProjection,rows:[partnerProjection.rows[0],partnerProjection.rows[0]]}).success,false);
for (const [start,end] of [
  ["2026-10-01T05:00:00Z","2026-11-01T05:00:00Z"],
  ["2026-10-01T00:00:00Z","2026-11-01T00:00:00Z"],
  ["2026-09-30T10:00:00Z","2026-10-31T10:00:00Z"],
  ["2026-10-01T04:00:00Z","2026-11-01T05:00:00Z"],
]) {
  const first=new Date(start),exclusiveEnd=new Date(end);
  assert.equal(isCalendarStartInWindow(first,first,exclusiveEnd),true);
  assert.equal(isCalendarStartInWindow(new Date(exclusiveEnd.getTime()-1),first,exclusiveEnd),true);
  assert.equal(isCalendarStartInWindow(exclusiveEnd,first,exclusiveEnd),false);
  assert.equal(isCalendarStartInWindow(new Date(first.getTime()-1),first,exclusiveEnd),false);
  assert.equal(isCalendarStartInWindow(new Date("invalid"),first,exclusiveEnd),false);
}
const payoutFacts=projectPayoutLedger([
  {id:1,periodMonth:"2026-10",agentShare:"0.10",grossResidual:"0.00"},
  {id:2,periodMonth:"2026-10",agentShare:"0.20",grossResidual:null},
  {id:3,periodMonth:"2026-09",agentShare:"invalid",grossResidual:"0.00"},
],{month:null,status:null},"2026-10-09T00:00:00Z");
assert.equal(payoutFacts.groups[0].totalAgent,"0.30");
assert.equal(payoutFacts.groups[0].totalGross,null);
assert.equal(payoutFacts.groups[1].totalAgent,null);
assert.equal(payoutFacts.groups[1].totalGross,"0.00");
assert.equal(payoutFacts.read.monetaryMeaning,"stored_allocation_not_native_transfer_or_settlement");
assert.deepEqual(projectPayoutLedger([],{month:null,status:null},"2026-10-09T00:00:00Z").groups,[]);
const outreachSource=readFileSync("client/src/pages/dashboard/OutreachAnalytics.tsx","utf8");
assert.doesNotMatch(outreachSource,/if\s*\(campaignsError\s*\|\|\s*!campaigns\)\s*{\s*return/,"Campaign failure must not remove independent child selectors");
console.log("C4 codec/source contracts PASS; assignment 39/70 is not a dynamic control or action pass.");
