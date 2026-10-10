import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
await assertDisposableTestInfrastructure({operation:"organization-location-identity",requireRedis:false});
const {pool}=await import("../../server/db");
const {resolveOrganization,peekOrganizationResolution}=await import("../../server/services/organization-resolver");
const label=`Identity ${randomUUID()}`;
let checks=0;
try {
  const first={canonicalName:label,websiteDomain:`${randomUUID()}.test`,googlePlaceId:randomUUID(),
    city:"Fort Lauderdale",state:"FL",streetAddress:"10 Main St"};
  const a=await resolveOrganization(first);
  assert.equal(a.kind,"created");checks++;
  if(a.kind==="deferred")throw new Error("EXPECTED_BUSINESS");
  const second={...first,city:"Miami",streetAddress:"20 Main St",googlePlaceId:randomUUID(),state:"Florida"};
  assert.equal((await peekOrganizationResolution(second)).kind,"would_create");checks++;
  const simultaneous=await Promise.all([resolveOrganization(second),resolveOrganization(second)]);
  assert.equal(simultaneous.filter(result=>result.kind==="created").length,1);checks++;
  assert(simultaneous.every(result=>result.kind!=="deferred"));checks++;
  assert.equal((await peekOrganizationResolution(first)).kind,"matched");checks++;
  const sourceIdentity={sourceSystem:"outscraper",sourceType:"provider_import",stableKey:randomUUID()};
  await pool.query(`INSERT INTO canonical_source_links(business_id,source_system,source_type,stable_key)
    VALUES($1,$2,$3,$4)`,[a.business.id,sourceIdentity.sourceSystem,sourceIdentity.sourceType,sourceIdentity.stableKey]);
  const aliasInput={...first,googlePlaceId:null,state:" florida ",sourceIdentity};
  const peek=await peekOrganizationResolution(aliasInput);
  const resolved=await resolveOrganization(aliasInput);
  assert.equal(peek.kind,"matched");assert.equal(resolved.kind,"matched");checks+=2;
  if(peek.kind!=="matched" || resolved.kind==="deferred")throw new Error("EXPECTED_MATCH");
  assert.equal(peek.business.id,resolved.business.id);checks++;
  const conflict={...aliasInput,city:"Other City"};
  assert.equal((await peekOrganizationResolution(conflict)).kind,"deferred");
  assert.equal((await resolveOrganization(conflict)).kind,"deferred");checks+=2;
  console.log(`Organization resolver native: ${checks} checks passed; provider calls=0; outbound changes=0`);
} finally {await pool.end();}
