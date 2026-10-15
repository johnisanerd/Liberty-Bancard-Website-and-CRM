import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {assertDisposableTestInfrastructure} from "../test-infrastructure-guard";
import {businesses} from "../../shared/schema";
import {fingerprintQuery} from "../../server/lib/lock-trace";
import {drizzle} from "drizzle-orm/node-postgres";
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
  // Reproduce production's actual surviving historical constraint. A migrated
  // template without this index cannot certify retained native topology.
  await pool.query(readFileSync("migrations/0043_sdr_business_domain_unique.sql","utf8"));
  const businessBefore=(await pool.query("SELECT to_jsonb(b) row FROM businesses b WHERE id=$1",
    [a.business.id])).rows[0].row;
  await assert.rejects(()=>resolveOrganization(second),(error:any)=>
    error.cause?.code==="23505" &&
    error.cause?.constraint==="businesses_website_domain_unique_idx");checks++;
  const insert=drizzle.mock().insert(businesses).values({
    canonicalName:label,normalizedName:"fixture",websiteDomain:first.websiteDomain,
    googlePlaceId:first.googlePlaceId,mainPhone:"1234567890",city:first.city,state:first.state,
    streetAddress:first.streetAddress,recordClass:"canonical",postalCode:"33301",
    vertical:"test",lastSourceType:"google_maps_outscraper",
  }).returning().toSQL();
  assert.equal(fingerprintQuery(insert.sql),"93542bc5fb34f2ee",
    "Reproduced business insert matches production's failing query fingerprint");checks++;
  const repair=readFileSync("migrations/0355_business_shared_domain_identity.sql","utf8");
  await pool.query(repair);
  await pool.query(repair); // Idempotent owner-console/development delivery.
  assert.deepEqual((await pool.query("SELECT to_jsonb(b) row FROM businesses b WHERE id=$1",
    [a.business.id])).rows[0].row,businessBefore,"Repair preserves original business facts");checks++;
  assert.equal((await pool.query(`SELECT to_regclass(
    'public.businesses_website_domain_unique_idx') obsolete,
    to_regclass('public.businesses_website_domain_idx') lookup`)).rows[0].obsolete,null);checks++;
  const simultaneous=await Promise.all([resolveOrganization(second),resolveOrganization(second)]);
  assert.equal(simultaneous.filter(result=>result.kind==="created").length,1);checks++;
  assert(simultaneous.every(result=>result.kind!=="deferred"));checks++;
  assert.equal(Number((await pool.query("SELECT count(*) FROM businesses WHERE website_domain=$1",
    [first.websiteDomain])).rows[0].count),2);checks++;
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
  const phoneLabel=`US phone ${randomUUID()}`;
  const phoneBusiness=await resolveOrganization({canonicalName:phoneLabel,mainPhone:"3055550123"});
  assert.notEqual(phoneBusiness.kind,"deferred");
  const countryCode={canonicalName:phoneLabel,mainPhone:"+1 (305) 555-0123"};
  const phonePeek=await peekOrganizationResolution(countryCode);
  const phoneResolved=await resolveOrganization(countryCode);
  assert.equal(phonePeek.kind,"matched");assert.equal(phoneResolved.kind,"matched");checks+=2;
  if(phoneBusiness.kind==="deferred"||phonePeek.kind!=="matched"||phoneResolved.kind==="deferred")
    throw Error("EXPECTED_PHONE_MATCH");
  assert.equal(phonePeek.business.id,phoneBusiness.business.id);
  assert.equal(phoneResolved.business.id,phoneBusiness.business.id);checks+=2;
  assert.equal((await peekOrganizationResolution({canonicalName:phoneLabel,mainPhone:"+44 3055550123"})).kind,
    "would_create");checks++;
  assert.equal((await peekOrganizationResolution({...aliasInput,mainPhone:"+1 (305) 555-0124"})).kind,
    "matched");checks++; // A missing candidate phone is not fabricated contrary evidence.
  await pool.query("UPDATE businesses SET main_phone='3055550123' WHERE id=$1",[a.business.id]);
  assert.equal((await peekOrganizationResolution({...aliasInput,mainPhone:"+1 (305) 555-0124"})).kind,
    "deferred");checks++;
  assert.equal((await peekOrganizationResolution({...aliasInput,mainPhone:"+1 (305) 555-0123",city:"Other City"})).kind,
    "deferred");checks++;
  console.log(`Organization resolver native: ${checks} checks passed; provider calls=0; outbound changes=0`);
} finally {await pool.end();}
