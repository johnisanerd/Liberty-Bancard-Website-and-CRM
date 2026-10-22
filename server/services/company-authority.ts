import {and,asc,eq,sql,type SQL} from "drizzle-orm";
import {db} from "../db";
import {users,contacts,deals,companies,contactCompanies} from "@shared/schema";
import type {InsertCompany} from "@shared/schema";
import {canAccessOwner} from "./crm-object-access";
import {workPrincipalFields,WorkCommandError,type WorkActor} from "./work-item-command";
import {auditChange} from "./audit-change";
type Tx=Parameters<Parameters<typeof db.transaction>[0]>[0];
const unavailable=()=>new WorkCommandError("Company context unavailable",404);
async function pinActor(tx:Tx,actor:WorkActor) {
  const [user]=await tx.select(workPrincipalFields).from(users).where(eq(users.id,actor.id)).for("share");
  if(!user || user.accountState!=="active" || user.authEpoch!==actor.authEpoch ||
    user.accountVersion!==actor.accountVersion || !["admin","manager","agent"].includes(user.role ?? "")) throw unavailable();
  return {...user,role:user.role ?? undefined};
}
type Principal=Awaited<ReturnType<typeof pinActor>>;
/** Actual companies-table policy, NOT businesses-table identity.
 * Privileged managers retain global scope. Agents see session-created companies
 * or companies related to a contact/deal allowed by the existing owner/unassigned
 * policy. Legacy unlinked companies remain management review, not guessed owners.
 * A visible shared company never grants access to its other memberships.
 */
function companyPredicate(actor:Principal):SQL {
  if(actor.role!=="agent") return sql`TRUE`;
  if(!actor.email) return sql`FALSE`;
  return sql`(${companies.createdByUserId}=${actor.id} OR
    EXISTS(SELECT 1 FROM contact_companies cc JOIN contacts c ON c.id=cc.contact_id
      WHERE cc.company_id=${companies.id} AND c.archived_at IS NULL AND (c.assigned_to IS NULL OR c.assigned_to=${actor.email})) OR
    EXISTS(SELECT 1 FROM deals d WHERE d.company_id=${companies.id} AND d.archived_at IS NULL
      AND (d.owner IS NULL OR d.owner=${actor.email})))`;
}
async function pinContact(tx:Tx,actor:Principal,id:number) {
  const [contact]=await tx.select({id:contacts.id,owner:contacts.assignedTo,archivedAt:contacts.archivedAt})
    .from(contacts).where(eq(contacts.id,id)).for("share");
  if(!contact || contact.archivedAt || !canAccessOwner(actor,contact.owner,false)) throw unavailable();
  return contact;
}
async function pinCompany(tx:Tx,actor:Principal,id:number) {
  const [company]=await tx.select().from(companies).where(and(eq(companies.id,id),companyPredicate(actor))).for("update");
  if(!company) throw unavailable();
  return company;
}
export async function readCompanies(actor:WorkActor,id?:number) {
  return db.transaction(async tx=>{
    const principal=await pinActor(tx,actor);
    const rows=await tx.select().from(companies).where(and(companyPredicate(principal),id===undefined?undefined:eq(companies.id,id)))
      .orderBy(asc(companies.id));
    if(id!==undefined && !rows.length) throw unavailable();
    return id===undefined?rows:rows[0];
  });
}
export const COMPANY_SEARCH_DEFAULT_LIMIT=25;
export const COMPANY_SEARCH_MAX_LIMIT=50;
export const COMPANY_SEARCH_MAX_QUERY=100;
const likeEscape=(v:string)=>v.replace(/[\\%_]/g,m=>`\\${m}`);
export function encodeCompanyCursor(name:string,id:number) {
  return Buffer.from(JSON.stringify({n:name,i:id}),"utf8").toString("base64url");
}
export function decodeCompanyCursor(raw:string):{n:string;i:number} {
  try {
    const v=JSON.parse(Buffer.from(raw,"base64url").toString("utf8"));
    if(typeof v?.n!=="string" || !Number.isSafeInteger(v?.i) || v.i<1) throw new Error("shape");
    return {n:v.n,i:v.i};
  } catch { throw new WorkCommandError("Company search cursor is invalid",400); }
}
/** Bounded, authorized company search. The actor predicate is applied in SQL before ordering and the page limit,
 * so an agent can never receive (or page into) a company outside readCompanies' policy. Stable order is
 * lower(legal_name), id; the cursor is that pair. `total` is the exact authorized match count for the same filter. */
export async function searchCompanies(actor:WorkActor,input:{q?:string;limit?:number;cursor?:string;excludeContactId?:number}) {
  const q=(input.q ?? "").trim().slice(0,COMPANY_SEARCH_MAX_QUERY);
  const limit=Math.min(Math.max(Math.trunc(input.limit ?? COMPANY_SEARCH_DEFAULT_LIMIT),1),COMPANY_SEARCH_MAX_LIMIT);
  const cursor=input.cursor?decodeCompanyCursor(input.cursor):null;
  return db.transaction(async tx=>{
    const principal=await pinActor(tx,actor);
    if(input.excludeContactId!==undefined) await pinContact(tx,principal,input.excludeContactId);
    const pattern=q?`%${likeEscape(q.toLowerCase())}%`:null;
    const filter=sql`${companyPredicate(principal)}
      ${pattern?sql`AND (lower(${companies.legalName}) LIKE ${pattern} ESCAPE '\\' OR lower(coalesce(${companies.dba},'')) LIKE ${pattern} ESCAPE '\\')`:sql``}
      ${input.excludeContactId!==undefined?sql`AND NOT EXISTS (SELECT 1 FROM contact_companies x WHERE x.company_id=${companies.id} AND x.contact_id=${input.excludeContactId})`:sql``}`;
    const totalRow=await tx.select({n:sql<number>`count(*)::int`}).from(companies).where(filter);
    const page=await tx.select({id:companies.id,legalName:companies.legalName,dba:companies.dba}).from(companies)
      .where(cursor?sql`${filter} AND (lower(${companies.legalName}),${companies.id}) > (${cursor.n.toLowerCase()},${cursor.i})`:filter)
      .orderBy(sql`lower(${companies.legalName}) ASC`,asc(companies.id)).limit(limit+1);
    const items=page.slice(0,limit);
    const last=items[items.length-1];
    return {items,total:totalRow[0]?.n ?? 0,limit,nextCursor:page.length>limit&&last?encodeCompanyCursor(last.legalName,last.id):null};
  });
}
export async function createOwnedCompany(actor:WorkActor,input:InsertCompany) {
  return db.transaction(async tx=>{
    const principal=await pinActor(tx,actor);
    const [company]=await tx.insert(companies).values({...input,createdByUserId:principal.id}).returning();
    await auditChange({userId:actor.id,actorType:"user",action:"company_created",entityType:"company",entityId:company.id,after:company},tx);
    return company;
  });
}
export async function updateOwnedCompany(actor:WorkActor,id:number,input:Partial<InsertCompany>) {
  return db.transaction(async tx=>{
    const principal=await pinActor(tx,actor),before=await pinCompany(tx,principal,id);
    const [company]=await tx.update(companies).set(input).where(eq(companies.id,id)).returning();
    await auditChange({userId:actor.id,actorType:"user",action:"company_updated",entityType:"company",entityId:id,before,after:company},tx);
    return company;
  });
}
export async function readContactCompanies(actor:WorkActor,contactId:number) {
  return db.transaction(async tx=>{
    const principal=await pinActor(tx,actor);await pinContact(tx,principal,contactId);
    return tx.select({id:contactCompanies.id,contactId:contactCompanies.contactId,companyId:contactCompanies.companyId,
      role:contactCompanies.role,isPrimary:contactCompanies.isPrimary,createdAt:contactCompanies.createdAt,company:companies})
      .from(contactCompanies).innerJoin(companies,eq(contactCompanies.companyId,companies.id))
      .where(and(eq(contactCompanies.contactId,contactId),companyPredicate(principal))).orderBy(asc(contactCompanies.id));
  });
}
export async function readCompanyMembers(actor:WorkActor,companyId:number) {
  return db.transaction(async tx=>{
    const principal=await pinActor(tx,actor);await pinCompany(tx,principal,companyId);
    return tx.select({id:contacts.id,firstName:contacts.firstName,lastName:contacts.lastName,email:contacts.email,
      emailStatus:contacts.emailStatus,isDecisionMaker:contacts.isDecisionMaker,role:contactCompanies.role,
      decisionMakerConfidence:contacts.decisionMakerConfidence,title:contacts.title,companyName:contacts.companyName,bouncedAt:contacts.bouncedAt})
      .from(contactCompanies).innerJoin(contacts,eq(contactCompanies.contactId,contacts.id))
      .where(sql`${contactCompanies.companyId}=${companyId} AND ${contacts.archivedAt} IS NULL
        ${principal.role==="agent"?sql`AND (${contacts.assignedTo} IS NULL OR ${contacts.assignedTo}=${principal.email})`:sql``}`);
  });
}
export async function linkCompany(actor:WorkActor,input:{contactId:number;companyId:number;role:string;isPrimary:boolean}) {
  return db.transaction(async tx=>{
    const principal=await pinActor(tx,actor);await pinContact(tx,principal,input.contactId);
    await pinCompany(tx,principal,input.companyId);
    const [prior]=await tx.select().from(contactCompanies).where(and(eq(contactCompanies.contactId,input.contactId),
      eq(contactCompanies.companyId,input.companyId))).orderBy(asc(contactCompanies.id)).limit(1).for("update");
    if(prior) {
      if(prior.role!==input.role || !!prior.isPrimary!==input.isPrimary) throw new WorkCommandError("Existing company link differs. No association was overwritten.",409);
      return {link:prior,changed:false,replayed:true};
    }
    const [link]=await tx.insert(contactCompanies).values(input).returning();
    await auditChange({userId:actor.id,actorType:"user",action:"contact_company_linked",entityType:"contact_company",entityId:link.id,after:link},tx);
    return {link,changed:true,replayed:false};
  });
}
export async function unlinkCompany(actor:WorkActor,associationId:number) {
  return db.transaction(async tx=>{
    const principal=await pinActor(tx,actor);
    const [metadata]=await tx.select({contactId:contactCompanies.contactId,companyId:contactCompanies.companyId})
      .from(contactCompanies).where(eq(contactCompanies.id,associationId));
    if(!metadata?.contactId || !metadata.companyId) throw unavailable();
    await pinContact(tx,principal,metadata.contactId);await pinCompany(tx,principal,metadata.companyId);
    const [before]=await tx.select().from(contactCompanies).where(eq(contactCompanies.id,associationId)).for("update");
    if(!before || before.contactId!==metadata.contactId || before.companyId!==metadata.companyId) throw unavailable();
    await tx.delete(contactCompanies).where(eq(contactCompanies.id,associationId));
    await auditChange({userId:actor.id,actorType:"user",action:"contact_company_unlinked",entityType:"contact_company",entityId:associationId,before},tx);
    return {changed:true,contactId:metadata.contactId};
  });
}
