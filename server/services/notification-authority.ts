import {and,desc,eq,getTableColumns,sql,type SQL} from "drizzle-orm";
import {alias} from "drizzle-orm/pg-core";
import {db} from "../db";
import {users,notifications,notificationPreferences,notificationActorStates,tasks,tickets,rfis,contacts,deals} from "@shared/schema";
import {taskReadPredicate} from "./task-read-authority";
const categories:Record<string,string[]>={
  leads:["contact_created","hot_lead","sequence_completed"],
  deals:["deal_created","deal_stage_changed","deal_closed_won"],
  sla:["sla_breach","task_due_soon","ticket_created","ticket_updated"],
  system:["daily_digest","weekly_digest","mention","comment_reply","task_assigned"],
};
async function currentActor(id?:string) {
  if(!id) throw new Error("Notification actor is required");
  const [actor]=await db.select({id:users.id,email:users.email,role:users.role,accountVersion:users.accountVersion})
    .from(users).where(and(eq(users.id,id),eq(users.accountState,"active")));
  if(!actor) throw new Error("Current notification authority unavailable");
  return actor;
}
type Actor=Awaited<ReturnType<typeof currentActor>>;
const value=(key:string)=>sql`(${notifications.metadata}->>${key})`;
function positive(expression:SQL) {
  return sql`CASE WHEN ${expression} ~ '^[1-9][0-9]{0,9}$' AND length(${expression})<=10
    THEN CASE WHEN ${expression}::bigint<=2147483647 THEN ${expression}::integer ELSE NULL END ELSE NULL END`;
}
function resourceAllowed(actor:Actor,kind:string,id:SQL):SQL {
  const dashboard=["admin","manager","agent"].includes(actor.role ?? "");
  if(!dashboard) return sql`FALSE`;
  const privileged=actor.role!=="agent";
  const contact=(key:SQL)=>sql`EXISTS(SELECT 1 FROM contacts c WHERE c.id=${key} AND c.archived_at IS NULL
    AND c.record_class='production' AND (${privileged} OR c.assigned_to=${actor.email}))`;
  const deal=(key:SQL)=>sql`EXISTS(SELECT 1 FROM deals d WHERE d.id=${key} AND d.archived_at IS NULL
    AND d.record_class='production' AND (${privileged} OR d.owner=${actor.email})
    AND (d.contact_id IS NULL OR ${contact(sql`d.contact_id`)}))`;
  if(kind==="contact") return contact(id);
  if(kind==="deal") return deal(id);
  if(kind==="task") return sql`EXISTS(SELECT 1 FROM ${tasks} WHERE ${tasks.id}=${id} AND
    ${taskReadPredicate({actor:{...actor,role:actor.role ?? undefined},asOf:new Date(),timezone:"UTC"})})`;
  if(kind==="ticket") return sql`EXISTS(SELECT 1 FROM ${tickets} WHERE ${tickets.id}=${id}
    AND (${tickets.contactId} IS NOT NULL AND ${contact(sql`${tickets.contactId}`)}
      OR ${tickets.contactId} IS NULL AND ${privileged}))`;
  if(kind==="rfi") return sql`EXISTS(SELECT 1 FROM ${rfis} WHERE ${rfis.id}=${id}
    AND (${rfis.contactId} IS NOT NULL AND ${contact(sql`${rfis.contactId}`)}
      OR ${rfis.contactId} IS NULL AND ${privileged})
    AND (${rfis.dealId} IS NULL OR ${deal(sql`${rfis.dealId}`)}))`;
  return sql`FALSE`;
}
const targetKinds=["contact","deal","task","ticket","rfi"];
const legacyPatterns:Record<string,string>={
  contact:"^/dashboard/contacts/([1-9][0-9]*)$",
  deal:"^/dashboard/pipeline\\?id=([1-9][0-9]*)$",
  ticket:"^/dashboard/tickets\\?id=([1-9][0-9]*)$",
  task:"^/dashboard/tasks\\?id=([1-9][0-9]*)$",
  rfi:"^/dashboard/rfis\\?id=([1-9][0-9]*)$",
};
/**
 * Admin-only review queues. A notification may link to one of these pages only when its event type is the one that
 * owns the page AND the reader is an active admin (the queue routes themselves are admin-only). Any other link that is
 * not a recognized resource detail URL stays hidden.
 */
const adminQueueLinks:Record<string,string>={
  partner_application_received:"/dashboard/referral-program",
  privacy_request_received:"/dashboard/data-requests",
};
function readExpression(actor:Actor) {
  return sql<boolean>`COALESCE((SELECT s.read_at IS NOT NULL FROM notification_actor_states s
    WHERE s.actor_id=${actor.id} AND s.notification_id=${notifications.id}),FALSE)
    OR (COALESCE(${notifications.recipientId}=${actor.id},FALSE) AND COALESCE(${notifications.read},FALSE))`;
}
function scope(actor:Actor,category="all") {
  const m=sql`COALESCE(${notifications.metadata},'{}'::jsonb)`;
  const dashboard=["admin","manager","agent"].includes(actor.role ?? "");
  const privileged=["admin","manager"].includes(actor.role ?? "");
  const validTargets=targetKinds.map(kind=>{
    const v=value(`${kind}Id`);
    return sql`(${v} IS NULL OR (${positive(v)} IS NOT NULL AND ${resourceAllowed(actor,kind,positive(v))}))`;
  });
  const typed=value("entityType"),entity=positive(value("entityId"));
  const typedAccess=sql`(${typed} IS NULL OR ${value("entityId")} IS NULL OR
    (${sql.join(targetKinds.map(kind=>sql`(${typed}=${kind} AND ${entity} IS NOT NULL AND ${resourceAllowed(actor,kind,entity)})`),sql` OR `)}))`;
  const hasTarget=sql`(${sql.join(targetKinds.map(kind=>sql`${value(`${kind}Id`)} IS NOT NULL`),sql` OR `)}
    OR (${typed} IS NOT NULL AND ${value("entityId")} IS NOT NULL))`;
  const broadcast=sql`(${dashboard} AND (${privileged} OR ${hasTarget} OR
    (${m}->>'broadcast'='true' AND ${value("eventType")} IN ('system_announcement','maintenance_notice'))))`;
  const parts=[
    sql`EXISTS(SELECT 1 FROM users u WHERE u.id=${actor.id} AND u.account_state='active'
      AND u.account_version=${actor.accountVersion} AND u.role IS NOT DISTINCT FROM ${actor.role})`,
    sql`(${notifications.recipientId}=${actor.id} OR (${notifications.recipientId} IS NULL AND ${broadcast}))`,
    sql`(${m}->'audienceRoles' IS NULL OR
      (jsonb_typeof(${m}->'audienceRoles')='array' AND ${m}->'audienceRoles' ? ${actor.role ?? ""}))`,
    ...validTargets,typedAccess,
    ...targetKinds.map(kind=>sql`(${typed} IS DISTINCT FROM ${kind} OR ${value("entityId")} IS NULL
      OR ${value(`${kind}Id`)} IS NULL OR ${positive(value(`${kind}Id`))}=${entity})`),
    sql`(${value("link")} IS NULL OR ${value("link")}='/dashboard' OR
      (${actor.role==="admin"} AND (${sql.join(Object.entries(adminQueueLinks).map(([event,link])=>
        sql`(${value("eventType")}=${event} AND ${value("link")}=${link})`),sql` OR `)})) OR
      (${sql.join(targetKinds.map(kind=>{
        const linkedId=positive(sql`substring(${value("link")} from ${legacyPatterns[kind]})`);
        return sql`(${linkedId} IS NOT NULL AND ${resourceAllowed(actor,kind,linkedId)})`;
      }),sql` OR `)}))`,
    sql`NOT EXISTS(SELECT 1 FROM notification_actor_states s WHERE s.actor_id=${actor.id}
      AND s.notification_id=${notifications.id} AND s.dismissed_at IS NOT NULL)`,
    sql`NOT EXISTS(SELECT 1 FROM ${notificationPreferences} WHERE ${notificationPreferences.userId}=${actor.id}
      AND ${notificationPreferences.enabled}=FALSE AND ${notificationPreferences.eventType}=${value("eventType")})`,
  ];
  if(category!=="all") {
    if(!categories[category]) throw new Error("Unsupported notification category");
    parts.push(sql`${value("eventType")} IN (${sql.join(categories[category].map(event=>sql`${event}`),sql`,`)})`);
  }
  return sql`${sql.join(parts.map(part=>sql`(${part})`),sql` AND `)}`;
}
function typedTarget(metadata:any):{kind:string;id:number}|null {
  const parse=(v:any)=>typeof v==="number" && Number.isSafeInteger(v) && v>0 && v<=2147483647?v:
    typeof v==="string" && /^[1-9]\d*$/.test(v) && Number(v)<=2147483647?Number(v):null;
  if(targetKinds.includes(metadata?.entityType)) {
    const id=parse(metadata.entityId);
    const legacy=metadata[`${metadata.entityType}Id`];
    if(legacy!==undefined && parse(legacy)!==id) return null;
    if(typeof metadata.link==="string" && metadata.link!=="/dashboard") {
      const matched=new RegExp(legacyPatterns[metadata.entityType]).exec(metadata.link);
      if(parse(matched?.[1])!==id) return null;
    }
    return id?{kind:metadata.entityType,id}:null;
  }
  for(const kind of ["ticket","rfi","task","deal","contact"]) {
    const id=parse(metadata?.[`${kind}Id`]);if(id) return {kind,id};
  }
  if(typeof metadata?.link==="string") for(const kind of targetKinds) {
    const matched=new RegExp(legacyPatterns[kind]).exec(metadata.link);
    const id=parse(matched?.[1]);if(id) return {kind,id};
  }
  return null; // Never infer an entity from a title, name or arbitrary URL.
}
function destination(metadata:any) {
  const target=typedTarget(metadata);
  if(!target && metadata?.eventType && adminQueueLinks[metadata.eventType]===metadata?.link)
    return {state:"available",url:metadata.link};
  if(!target) return metadata?.link==="/dashboard" || ["daily","weekly"].includes(metadata?.digestType)
    ? {state:"available",url:"/dashboard"}:{state:"unavailable",url:null};
  if(target.kind==="task") return {state:"available",url:"/dashboard/tasks-appointments?tab=tasks",...target,
    context:"authorized_list_fallback",label:"Open task list (no selected task)"};
  const paths:Record<string,string>={contact:`/dashboard/contacts/${target.id}`,
    deal:`/dashboard/pipeline?id=${target.id}`,ticket:`/dashboard/tickets?id=${target.id}`,
    task:`/dashboard/tasks?id=${target.id}`,rfi:`/dashboard/rfis?id=${target.id}`};
  return {state:"available",url:paths[target.kind],...target};
}
export async function listActorNotifications(params:{userId?:string;limit:number;offset:number;category?:string}) {
  const actor=await currentActor(params.userId),where=scope(actor,params.category);
  const data=await db.select({...getTableColumns(notifications),read:readExpression(actor)}).from(notifications)
    .where(where).orderBy(desc(notifications.createdAt),desc(notifications.id)).limit(params.limit).offset(params.offset);
  const [total]=await db.select({n:sql<number>`count(*)::integer`}).from(notifications).where(where);
  return {data:data.map(row=>({...row,target:destination(row.metadata)})),total:total.n};
}
export async function countActorNotifications(userId?:string) {
  const actor=await currentActor(userId);
  const [row]=await db.select({n:sql<number>`count(*)::integer`}).from(notifications)
    .where(sql`${scope(actor)} AND NOT (${readExpression(actor)})`);
  return row.n;
}
export async function acknowledgeActorNotifications(userId:string|undefined,action:"read"|"dismiss",id?:number,oldOnly=false) {
  const actor=await currentActor(userId);
  const where=sql`${scope(actor)} ${id===undefined?sql``:sql`AND ${notifications.id}=${id}`}
    ${oldOnly?sql`AND (${readExpression(actor)}) AND ${notifications.createdAt}<NOW()-interval '7 days'`:sql``}`;
  const result=await db.execute(sql`INSERT INTO notification_actor_states(actor_id,notification_id,read_at,dismissed_at)
    SELECT ${actor.id},${notifications.id},NOW(),${action==="dismiss"?sql`NOW()`:sql`NULL`} FROM ${notifications} WHERE ${where}
    ON CONFLICT(actor_id,notification_id) DO UPDATE SET
      read_at=COALESCE(notification_actor_states.read_at,EXCLUDED.read_at),
      dismissed_at=COALESCE(notification_actor_states.dismissed_at,EXCLUDED.dismissed_at)
    WHERE notification_actor_states.read_at IS NULL OR
      (EXCLUDED.dismissed_at IS NOT NULL AND notification_actor_states.dismissed_at IS NULL)
    RETURNING notification_id`);
  return result.rows.length;
}
export async function hasActorNotification(userId:string,id:number) {
  const actor=await currentActor(userId);
  const [row]=await db.select({id:notifications.id}).from(notifications).where(sql`${scope(actor)} AND ${notifications.id}=${id}`);
  return !!row;
}
/** Trusted producers supply explicit IDs/canonical assignment, never names. */
export async function bindNotificationAudience(input:typeof notifications.$inferInsert) {
  if(input.recipientId) {
    const matches=await db.select({id:users.id}).from(users).where(sql`${users.accountState}='active'
      AND (${users.id}=${input.recipientId} OR lower(${users.email})=lower(${input.recipientId}))`).limit(2);
    // Unknown personal recipients stay inaccessible; never convert their body
    // to a management/global broadcast or infer identity from a display name.
    return matches.length===1?{...input,recipientId:matches[0].id}:input;
  }
  const metadata=(input.metadata ?? {}) as Record<string,any>;
  const target=typedTarget(metadata);
  let identity:string|null=null;
  if(target?.kind==="task") {
    const [row]=await db.select({assignee:tasks.canonicalAssignee}).from(tasks).where(eq(tasks.id,target.id));
    identity=row?.assignee ?? null;
  } else if(target?.kind==="contact") {
    const [row]=await db.select({assignee:contacts.assignedTo}).from(contacts).where(eq(contacts.id,target.id));
    identity=row?.assignee ?? null;
  } else if(target?.kind==="deal") {
    const [row]=await db.select({assignee:deals.owner}).from(deals).where(eq(deals.id,target.id));
    identity=row?.assignee ?? null;
  } else if(target?.kind==="ticket") {
    const [row]=await db.select({assignee:tickets.assignedTo}).from(tickets).where(eq(tickets.id,target.id));
    identity=row?.assignee ?? null;
  } else if(target?.kind==="rfi") {
    const [row]=await db.select({assignee:rfis.assignedTo}).from(rfis).where(eq(rfis.id,target.id));
    identity=row?.assignee ?? null;
  }
  if(identity) {
    const matches=await db.select({id:users.id}).from(users).where(sql`${users.accountState}='active'
      AND ${users.role} IN ('admin','manager','agent')
      AND (${users.id}=${identity} OR lower(${users.email})=lower(${identity}))`).limit(2);
    if(matches.length===1) return {...input,recipientId:matches[0].id};
  }
  const genuineBroadcast=metadata.broadcast===true && ["system_announcement","maintenance_notice"].includes(metadata.eventType);
  return {...input,metadata:{...metadata,audienceRoles:metadata.audienceRoles ??
    (genuineBroadcast?["admin","manager","agent"]:["admin","manager"])}};
}
export async function resolveActorNotification(userId:string,id:number) {
  const actor=await currentActor(userId);
  const [row]=await db.select({metadata:notifications.metadata}).from(notifications)
    .where(sql`${scope(actor)} AND ${notifications.id}=${id}`);
  return row?destination(row.metadata):{state:"unavailable",url:null};
}
export async function readActorRfi(userId:string,id:number) {
  const actor=await currentActor(userId);
  const [row]=await db.select().from(rfis).where(sql`${rfis.id}=${id} AND ${resourceAllowed(actor,"rfi",sql`${id}`)}
    AND EXISTS(SELECT 1 FROM users u WHERE u.id=${actor.id} AND u.account_state='active'
      AND u.account_version=${actor.accountVersion} AND u.role IS NOT DISTINCT FROM ${actor.role})`);
  return row;
}
/** Complete retained collection using the same resource authority as exact
 * RFI/notification reads. Aliased outer IDs must remain correlated. */
export async function readActorRfis(userId:string,contactId?:number){
  const actor=await currentActor(userId);
  if(!["admin","manager","agent"].includes(actor.role??""))throw new Error("RFI collection authority unavailable");
  const visible=alias(rfis,"visible_rfi");
  const principal=alias(users,"rfi_reader");
  const rows=await db.select({actorId:principal.id,record:getTableColumns(visible)})
    .from(principal).leftJoin(visible,and(
      resourceAllowed(actor,"rfi",sql`${visible.id}`),
      contactId===undefined?undefined:eq(visible.contactId,contactId)))
    .where(sql`${principal.id}=${actor.id} AND ${principal.accountState}='active'
      AND ${principal.accountVersion}=${actor.accountVersion}
      AND ${principal.role} IS NOT DISTINCT FROM ${actor.role}`)
    .orderBy(desc(visible.createdAt),desc(visible.id));
  if(!rows.length)throw new Error("Current RFI read authority changed; reload required");
  return rows.flatMap(row=>row.record?.id?[row.record]:[]);
}
