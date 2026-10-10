import assert from "node:assert/strict";
import { decideOrganizationIdentity, type OrganizationIdentity } from "../../server/services/organization-resolution-policy";
const base: OrganizationIdentity={canonicalName:"Shared Brand",websiteDomain:"brand.test",
  city:"Fort Lauderdale",state:"FL",streetAddress:"10 Main St",googlePlaceId:"place-a"};
const a={...base,id:1};
const b={...base,id:2,city:"Miami",streetAddress:"20 Main St",googlePlaceId:"place-b"};
let checks=0;
function check(input:OrganizationIdentity,candidates:any[],expected:any) {
  assert.deepEqual(decideOrganizationIdentity(input,candidates),expected);checks++;
}
check(base,[a,b],{kind:"matched",id:1});
check({...b},[a],{kind:"create"});
check({...base,googlePlaceId:null,city:"Miami",streetAddress:"20 Main St"},[a],{kind:"create"});
check({...base,state:" Florida "},[a],{kind:"matched",id:1});
check({...base,googlePlaceId:null,streetAddress:null,city:null,state:null},[a,b],
  {kind:"deferred",reasonCode:"AMBIGUOUS_ORGANIZATION_MATCH",candidateIds:[1,2]});
check({...base,googlePlaceId:null},[{...a,exactSource:true},b],{kind:"matched",id:1});
check(base,[{...b,exactSource:true},a],{kind:"deferred",reasonCode:"AMBIGUOUS_ORGANIZATION_MATCH",candidateIds:[1,2]});
check({...base,state:"GA"},[{...a,exactSource:true}],
  {kind:"deferred",reasonCode:"AMBIGUOUS_ORGANIZATION_MATCH",candidateIds:[1]});
check({canonicalName:"Name Only",sourceIdentity:{sourceSystem:"crm",sourceType:"import",stableKey:"row:1"}},[],
  {kind:"deferred",reasonCode:"INSUFFICIENT_ORGANIZATION_EVIDENCE",candidateIds:[]});
console.log(`Organization location identity: ${checks} checks passed`);
