import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { users, agents, tasks, tickets, contacts, deals, taskAuthorityEvents, ticketAuthorityEvents, ticketComments, notifications } from "@shared/schema";
import { db } from "../db";
import { auditChange } from "./audit-change";
import { taskReadPredicate } from "./task-read-authority";
import { legacyTaskStatusToAuthorityState, authorityStateToLegacyTaskStatus, legacyTicketStatusToAuthorityState } from "@shared/work-item-commands";
import { ticketStatusMessage } from "./ticket-status-message";

export class WorkCommandError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) { super(message); }
}
export type WorkActor = { id: string; authEpoch: number;accountVersion?:number };
export function bindWorkActor(user: any, expectedActorId?: string, expectedAccountVersion?:number): WorkActor {
  if (!user?.id || !Number.isSafeInteger(user.authEpoch)) throw unavailable();
  if (expectedActorId && expectedActorId !== user.id) throw new WorkCommandError("Sign-in changed. Reload before submitting work captured by another account.", 409);
  if (expectedAccountVersion!==undefined && expectedAccountVersion!==user.accountVersion) {
    throw new WorkCommandError("Account authority changed. Queued work is retained for review; no work was submitted.",409);
  }
  return { id: user.id, authEpoch: user.authEpoch,accountVersion:user.accountVersion };
}
export type WorkSelection = Array<{ id: number; expectedFence: number }>;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const workPrincipalFields = {id:users.id,email:users.email,role:users.role,accountState:users.accountState,authEpoch:users.authEpoch,accountVersion:users.accountVersion,agentId:users.agentId};
type UserRow = Pick<typeof users.$inferSelect, keyof typeof workPrincipalFields>;
function stable(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(stable(value)) ?? "undefined").digest("hex");
const unavailable = () => new WorkCommandError("Work item unavailable", 404);

/** One user ID/email mapping. Display names and stale pool emails never own work. */
export async function resolveWorkAssignee(identity: string, tx: Tx, locked?: UserRow[], requireSalesRep=false) {
  const rows = locked ? locked.filter(u => u.accountState === "active" &&
    ["admin","manager","agent"].includes(u.role || "") &&
    (u.id === identity || u.email?.toLowerCase() === identity.toLowerCase())) : await tx.select(workPrincipalFields).from(users).where(and(eq(users.accountState, "active"),
    inArray(users.role, ["admin","manager","agent"]),
    sql`(${users.id}=${identity} OR lower(${users.email})=lower(${identity}))`)).orderBy(asc(users.id)).for("share");
  if (rows.length !== 1 || !rows[0].email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rows[0].email) ||
    /@(?:[^@]+\.)?libertybancard\.internal$/i.test(rows[0].email)) {
    throw new WorkCommandError("Assignee is not a current eligible dashboard account. Reload the assignment choices.", 409);
  }
  const user = rows[0];
  const agentId = user.agentId && /^\d+$/.test(user.agentId) ? Number(user.agentId) : null;
  if (agentId!==null && (!Number.isSafeInteger(agentId) || agentId<1 || agentId>2147483647)) {
    throw new WorkCommandError("Linked sales-rep identity is malformed. Management review is required.",409);
  }
  const links = await tx.select({id:agents.id,userId:agents.userId,email:agents.email,status:agents.status}).from(agents)
    .where(sql`${agents.userId}=${user.id} ${agentId ? sql`OR ${agents.id}=${agentId}`:sql``}`)
    .orderBy(asc(agents.id)).for("share");
  if (links.length>1 || links.some(a=>a.status!=="active" || (a.userId && a.userId!==user.id) ||
    a.email.toLowerCase()!==user.email!.toLowerCase()) ||
    (requireSalesRep && (user.role!=="agent" || links.length!==1))) {
    throw new WorkCommandError("Assignee's linked sales-rep identity is inactive, missing or ambiguous. Management review is required.",409);
  }
  return rows[0];
}

/** Locks and authorizes actual/prospective endpoints, including explicit null
 * clears; classes/owners cannot change between validation and work commit. */
export async function validateLinks(tx: Tx, row: any, actor: UserRow | undefined, recordClass: string): Promise<{
  contact?: { id: number; assignedTo: string | null; ghlContactId: string | null };
  dealOwner?: string | null;
}> {
  const agent = actor?.role === "agent";
  let contact: { id: number; assignedTo: string | null; ghlContactId: string | null } | undefined;
  const classFilter = (column: any) => recordClass === "all" ? undefined : eq(column, recordClass);
  if (row.contactId) {
    [contact] = await tx.select({ id: contacts.id, assignedTo: contacts.assignedTo, ghlContactId: contacts.ghlContactId })
      .from(contacts).where(and(eq(contacts.id, row.contactId),
      isNull(contacts.archivedAt), classFilter(contacts.recordClass),
      agent ? eq(contacts.assignedTo, actor!.email || "") : undefined)).for("share");
    if (!contact) throw unavailable();
  }
  let dealOwner: string | null | undefined;
  if (row.dealId) {
    const [deal] = await tx.select({ id: deals.id, contactId: deals.contactId, owner: deals.owner }).from(deals).where(and(eq(deals.id, row.dealId),
      isNull(deals.archivedAt), classFilter(deals.recordClass),
      agent ? eq(deals.owner, actor!.email || "") : undefined)).for("share");
    if (!deal || (row.contactId && deal.contactId !== row.contactId)) throw unavailable();
    dealOwner = deal.owner;
    if (deal.contactId) contact ??= (await validateLinks(tx, { contactId: deal.contactId }, actor, recordClass)).contact;
  }
  if (row.ticketId) {
    const [ticket] = await tx.select({ id: tickets.id, contactId: tickets.contactId }).from(tickets)
      .where(eq(tickets.id, row.ticketId)).for("share");
    if (!ticket || (row.contactId && ticket.contactId !== row.contactId)) throw unavailable();
    const ticketLinks = await validateLinks(tx, { contactId: ticket.contactId }, actor, recordClass);
    if (contact && ticketLinks.contact && contact.id !== ticketLinks.contact.id) throw unavailable();
    contact ??= ticketLinks.contact;
  }
  if (agent && !row.contactId && !row.dealId && !row.ticketId &&
    (row.canonicalAssignee ?? row.assignedTo) !== actor!.email) throw unavailable();
  return { contact, dealOwner };
}

export async function commandWorkItems(input: {
  kind: "task" | "ticket"; items: WorkSelection; commandId: string; actor?: WorkActor;
  producer?: string; recordClass?: "production" | "test" | "demo" | "all";
  operation?: "edit" | "soft_delete" | "delete" | "native_dispatch" | "native_finalize"; updates: Record<string, any>;
  terminalReason?: string | null;
  context?: Record<string, unknown>;
  eligible?: (tx: Tx, before: any) => Promise<boolean>;
  afterWrite?: (tx: Tx, before: any, after: any) => Promise<void>;
}, existingTx?: Tx) {
  const execute = async (tx: Tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`work-command:${input.kind}:${input.actor?.id ?? input.producer}:${input.commandId}`},0))`);
    const scopeClass = input.recordClass ?? "production";
    // Complete principal set in stable order BEFORE graph locks. A later
    // assignee lookup must not invert account lifecycle's user lock order.
    const assignee = input.updates.assignedTo;
    const principalRows = input.actor || assignee ? await tx.select(workPrincipalFields).from(users).where(sql`
      (${users.id}=${input.actor?.id ?? ""} OR ${users.id}=${assignee ?? ""}
        OR lower(${users.email})=lower(${assignee ?? ""}))`).orderBy(asc(users.id)).for("share") : [];
    let actor: UserRow | undefined;
    if (input.actor) {
      actor = principalRows.find(u => u.id === input.actor!.id);
      if (!actor || actor.accountState !== "active" || actor.authEpoch !== input.actor.authEpoch ||
        (input.actor.accountVersion!==undefined && actor.accountVersion!==input.actor.accountVersion) ||
        !["admin","manager","agent"].includes(actor.role || "")) throw unavailable();
    } else if (!input.producer) throw unavailable();
    const ids = input.items.map(i => i.id).sort((a,b) => a-b);
    const rows: any[] = input.kind === "task"
      ? await tx.select().from(tasks).where(and(inArray(tasks.id, ids), actor ? taskReadPredicate({
          actor: { role: actor.role ?? undefined, email: actor.email }, asOf: new Date(), timezone: "UTC", recordClass: scopeClass, includeDeletedForCommand: true,
        }) : undefined)).orderBy(asc(tasks.id)).for("update")
      : await tx.select().from(tickets).where(and(inArray(tickets.id, ids),
          actor?.role === "agent" ? sql`EXISTS(SELECT 1 FROM contacts wt WHERE wt.id=${tickets.contactId}
            AND wt.assigned_to=${actor.email} AND wt.archived_at IS NULL
            ${scopeClass === "all" ? sql`` : sql`AND wt.record_class=${scopeClass}`})` : undefined))
        .orderBy(asc(tickets.id)).for("update");
    if (rows.length !== ids.length) throw unavailable();
    const updates = { ...input.updates };
    if (updates.assignedTo !== undefined && updates.assignedTo !== null) {
      updates.assignedTo = (await resolveWorkAssignee(updates.assignedTo, tx, principalRows)).email;
    }
    const commandHash = hash({ ...input, eligible: undefined, afterWrite: undefined, items: [...input.items].sort((a,b) => a.id-b.id) });
    const eventKey = ["native_dispatch","native_finalize"].includes(input.operation || "")
      ? `${input.operation}:${input.commandId}` : `work-command:${input.commandId}`;
    const events: any[] = input.kind === "task"
      ? await tx.select().from(taskAuthorityEvents).where(and(inArray(taskAuthorityEvents.taskId, ids), eq(taskAuthorityEvents.eventKey, eventKey)))
      : await tx.select().from(ticketAuthorityEvents).where(and(inArray(ticketAuthorityEvents.ticketId, ids), eq(ticketAuthorityEvents.eventKey, eventKey)));
    // Validate every selected/prospective endpoint BEFORE any local mutation.
    const linksById = new Map<number, Awaited<ReturnType<typeof validateLinks>>>();
    for (const before of rows) {
      await validateLinks(tx, before, actor, scopeClass);
      const prospective = { ...before, ...updates,
        canonicalAssignee: updates.assignedTo === undefined ? before.canonicalAssignee : updates.assignedTo };
      if (input.kind === "ticket" && actor?.role === "agent" && !prospective.contactId) throw unavailable();
      const links = await validateLinks(tx, prospective, actor, scopeClass);
      linksById.set(before.id, links);
      if (updates.assignedTo && ((links.contact && links.contact.assignedTo !== updates.assignedTo) ||
        (links.dealOwner !== undefined && links.dealOwner !== updates.assignedTo))) {
        throw new WorkCommandError("Assignee does not own the linked contact. Use the approved record ownership handoff first; no work was reassigned.", 409);
      }
    }
    if (!["native_dispatch","native_finalize"].includes(input.operation || "")) {
      const table = input.kind === "task" ? sql`task_authority_events` : sql`ticket_authority_events`;
      const prior = await tx.execute(sql`SELECT payload->>'commandHash' hash FROM ${table}
        WHERE command_key=${input.commandId} AND payload->>'commandHash' IS NOT NULL
          AND COALESCE(payload->>'actorId','')=${actor?.id ?? ""}
          AND producer=${input.producer ?? "dashboard"}
          AND event_type NOT IN ('native_delete_dispatch','native_delete_local_committed')`);
      if (prior.rows.some(r => r.hash !== commandHash)) throw new WorkCommandError("Command retry payload differs from its retained intent. No selected work changed.", 409);
    }
    if (events.length) {
      if (events.length !== rows.length || events.some(e => e.payload?.commandHash !== commandHash)) {
        throw new WorkCommandError("Command retry payload differs or its retained receipt is incomplete.", 409);
      }
      return { results: events.map(e => e.payload.result), replayed: true,
        changed: events.filter(e => e.payload.result.changed).length };
    }
    for (const before of rows) {
      if (before.authorityFence !== input.items.find(i => i.id === before.id)!.expectedFence || before.deletedAt) {
        throw new WorkCommandError("Work changed. Reload its current version before retrying; no selected work was changed.", 409);
      }
      if (input.eligible && !await input.eligible(tx, before)) throw new WorkCommandError("Work is no longer eligible for this producer action.", 409);
      if (input.kind === "task") {
        const active = await tx.execute(sql`SELECT command_key,payload->>'actorId' actor_id FROM task_authority_events claim
          WHERE claim.task_id=${before.id} AND claim.event_type='native_delete_intent'
            AND NOT EXISTS(SELECT 1 FROM task_authority_events terminal
              WHERE terminal.task_id=claim.task_id AND terminal.command_key=claim.command_key
                AND terminal.event_type IN ('native_delete_blocked','native_delete_failed','native_delete_local_committed'))`);
        if (active.rows.some(r => !["native_dispatch","native_finalize"].includes(input.operation || "") ||
          r.command_key !== input.commandId || r.actor_id !== actor?.id)) throw new WorkCommandError("A retained native deletion is pending or has an unknown result. No local work changed; review its retained outcome before editing.", 409);
        if (["native_dispatch","native_finalize"].includes(input.operation || "") && active.rows.length !== 1) {
          throw new WorkCommandError("Native deletion intent is unavailable or already settled.", 409);
        }
        if (input.operation === "native_finalize") {
          const receipt = await tx.execute(sql`SELECT 1 FROM task_authority_events
            WHERE task_id=${before.id} AND event_key=${`native-result:${input.commandId}`}
              AND payload->'outcome'->>'disposition'='succeeded'`);
          if (receipt.rows.length !== 1) throw new WorkCommandError("A confirmed native result is required before local deletion.", 409);
        }
        if (input.operation === "delete" && input.items.length !== 1) throw new WorkCommandError("Native propagation uses a single-record command; bulk native deletion is unavailable.", 409);
      }
      if (input.operation === "soft_delete" && (input.kind !== "task" || before.ghlTaskId)) {
        throw new WorkCommandError("Native-linked task deletion requires its governed propagation command. No local work was deleted.", 409);
      }
    }
    const results: any[] = [];
    for (const before of rows) {
      const toState = updates.status === undefined ? before.authorityState : input.kind === "task"
        ? legacyTaskStatusToAuthorityState(updates.status) : legacyTicketStatusToAuthorityState(updates.status);
      const values: any = { ...updates,
        canonicalAssignee: updates.assignedTo === undefined ? before.canonicalAssignee : updates.assignedTo,
        terminalReason: ["completed","cancelled"].includes(toState) ? input.terminalReason ?? before.terminalReason : null,
        authorityState: toState, authorityFence: before.authorityFence + 1 };
      const nativePrepare = input.operation === "delete" && !!before.ghlTaskId;
      const nativeReadOnly = nativePrepare || input.operation === "native_dispatch";
      if (input.kind === "task") Object.assign(values, {
        status: authorityStateToLegacyTaskStatus(toState),
        completedAt: toState === "completed" ? before.completedAt ?? new Date() : null,
        ...(["soft_delete","native_finalize"].includes(input.operation || "") ||
          (input.operation === "delete" && !before.ghlTaskId) ? { deletedAt: new Date() } : {}),
      });
      else Object.assign(values, { resolvedAt: toState === "completed" ? before.resolvedAt ?? new Date() : null });
      const changed = !nativeReadOnly && Object.entries(values).some(([key,value]) => key !== "authorityFence" && hash(value) !== hash(before[key]));
      const after = !changed ? before : input.kind === "task"
        ? (await tx.update(tasks).set(values).where(eq(tasks.id, before.id)).returning())[0]
        : (await tx.update(tickets).set({ ...values, updatedAt: new Date() }).where(eq(tickets.id, before.id)).returning())[0];
      const result = { item: after, changed, prior: {
        status: before.status, assignedTo: before.assignedTo, priority: before.priority, contactId: before.contactId,
      }, ...(nativeReadOnly ? { native: {
        ghlTaskId: before.ghlTaskId, ghlContactId: before.contactId ? linksById.get(before.id)?.contact?.ghlContactId ?? null : null,
        status: nativePrepare ? "intent_claimed" : "dispatch_claimed",
      } } : {}) };
      const eventType = nativePrepare ? "native_delete_intent" : input.operation === "native_dispatch" ? "native_delete_dispatch"
        : input.operation === "native_finalize" ? "native_delete_local_committed" : changed ? "command" : "command_noop";
      const event = { eventKey, eventType, producer: input.producer ?? "dashboard",
        createdAt: sql`clock_timestamp()`,
        commandKey: input.commandId, fence: after.authorityFence, fromState: before.authorityState, toState,
        payload: { commandHash, actorId: actor?.id ?? null, result, commandSnapshot: {
          items: input.items, updates: input.updates, context: input.context, operation: input.operation,
        } } };
      if (input.kind === "task") await tx.insert(taskAuthorityEvents).values({ ...event, taskId: before.id });
      else await tx.insert(ticketAuthorityEvents).values({ ...event, ticketId: before.id });
      if (changed) {
        if (input.kind === "ticket" && updates.status !== undefined && updates.status !== before.status) {
          const [contact] = after.contactId ? await tx.select({firstName:contacts.firstName}).from(contacts).where(eq(contacts.id,after.contactId)) : [];
          const message = ticketStatusMessage(updates.status,contact?.firstName || "there");
          if (message) await tx.insert(ticketComments).values({ticketId:before.id,content:message,
            authorName:"Liberty Bancard Support",isInternal:false});
        }
        await auditChange({ actorType: actor ? "user" : "system", userId: actor?.id ?? null,
          action: `${input.kind}_${["soft_delete","delete","native_finalize"].includes(input.operation || "") ? "soft_deleted" : "commanded"}`,
          entityType: input.kind, entityId: before.id, before, after }, tx);
        if (input.afterWrite) await input.afterWrite(tx, before, after);
      }
      results.push(result);
    }
    return { results, replayed: false, changed: results.filter(r => r.changed).length };
  };
  return existingTx ? execute(existingTx) : db.transaction(execute);
}

/** Internal producers resolve an indexed current row/retained original fence.
 * A discovered candidate may additionally pin its server-observed version. */
export async function commandProducedTask(input: {
  id: number; producer: string; commandId: string; updates: Record<string, any>;
  actor?: WorkActor; observedFence?: number; recordClass?: "production" | "test" | "demo" | "all";
  context?: Record<string, unknown>; eligible?: (tx: Tx, before: any) => Promise<boolean>;
  afterWrite?: (tx: Tx, before: any, after: any) => Promise<void>;
}, existingTx?: Tx) {
  const executor = existingTx ?? db;
  const [current] = await executor.select().from(tasks).where(eq(tasks.id,input.id));
  if (!current) throw unavailable();
  const [receipt] = await executor.select().from(taskAuthorityEvents).where(and(eq(taskAuthorityEvents.taskId,input.id),
    eq(taskAuthorityEvents.eventKey,`work-command:${input.commandId}`),eq(taskAuthorityEvents.producer,input.producer)));
  const originalFence = (receipt?.payload as any)?.commandSnapshot?.items?.[0]?.expectedFence;
  const command = await commandWorkItems({ kind:"task", items:[{id:input.id,expectedFence:originalFence ?? input.observedFence ?? current.authorityFence}],
    commandId:input.commandId, producer:input.producer, actor:input.actor, updates:input.updates,
    context:input.context, recordClass:input.recordClass, eligible:input.eligible, afterWrite:input.afterWrite },existingTx);
  return { ...command, changed:command.replayed ? 0 : command.changed };
}

export async function createHumanTask(input: {
  actor:WorkActor; commandId:string; recordClass:"production"|"test"|"demo"|"all"; fields:Record<string,any>;
}) {
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`human-task-create:${input.actor.id}:${input.commandId}`},0))`);
    const target = input.fields.assignedTo;
    const principals = await tx.select(workPrincipalFields).from(users).where(sql`${users.id}=${input.actor.id}
      OR ${users.id}=${target ?? ""} OR lower(${users.email})=lower(${target ?? ""})`).orderBy(asc(users.id)).for("share");
    const actor = principals.find(u=>u.id===input.actor.id);
    if (!actor || actor.accountState!=="active" || actor.authEpoch!==input.actor.authEpoch ||
      (input.actor.accountVersion!==undefined && actor.accountVersion!==input.actor.accountVersion) ||
      !["admin","manager","agent"].includes(actor.role ?? "")) throw unavailable();
    const assigneeIdentity = target === undefined && actor.role==="agent" ? actor.id : target;
    const assignee = assigneeIdentity ? await resolveWorkAssignee(assigneeIdentity,tx,principals) : null;
    const fields = {...input.fields,assignedTo:assignee?.email ?? null};
    const links = await validateLinks(tx,{...fields,canonicalAssignee:fields.assignedTo},actor,input.recordClass);
    if (assignee && ((links.contact && links.contact.assignedTo!==assignee.email) ||
      (links.dealOwner!==undefined && links.dealOwner!==assignee.email))) {
      throw new WorkCommandError("Assignee does not own the linked record. Use the approved ownership handoff first.",409);
    }
    const commandKey = `human-create:${actor.id}:${input.commandId}`;
    const commandHash = hash(input);
    const [existing] = await tx.select().from(tasks).where(eq(tasks.commandKey,commandKey));
    if (existing) {
      await validateLinks(tx,existing,actor,input.recordClass);
      const [receipt] = await tx.select().from(taskAuthorityEvents).where(and(eq(taskAuthorityEvents.taskId,existing.id),
        eq(taskAuthorityEvents.eventKey,`create:${commandKey}`)));
      if ((receipt?.payload as any)?.context?.commandHash!==commandHash) throw new WorkCommandError("Creation retry differs from the original intent. No new task was created.",409);
      if (existing.deletedAt) throw new WorkCommandError("The original task is retired. No replacement was created.",409);
      return {task:existing,replayed:true};
    }
    const {storage} = await import("../storage");
    const task = await storage.createAuthorityTask(fields as any,{producer:"human",commandKey,issueKey:commandKey,
      context:{commandHash,actorId:actor.id},actorId:actor.id},tx);
    if (assignee) await tx.insert(notifications).values({channel:"internal",title:"Task Assigned",
      message:`"${task.title}" has been assigned to ${assignee.email}.`,type:"info",recipientId:assignee.id,
      metadata:{taskId:task.id,eventType:"task_assigned",assignedTo:assignee.email}});
    return {task,replayed:false};
  });
}

/** Employee ticket intents compose the existing issue/generation writer.
 * Reuse is explicit and never overwrites another active issue's fields. */
export async function createHumanTicket(input:{actor:WorkActor;commandId:string;fields:Record<string,any>}) {
  return db.transaction(async tx=>{
    const commandKey=`human-ticket-create:${input.actor.id}:${input.commandId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandKey},0))`);
    const target=input.fields.assignedTo;
    const principals=await tx.select(workPrincipalFields).from(users).where(sql`${users.id}=${input.actor.id}
      OR ${users.id}=${target??""} OR lower(${users.email})=lower(${target??""})`).orderBy(asc(users.id)).for("share");
    const actor=principals.find(row=>row.id===input.actor.id);
    if(!actor||actor.accountState!=="active"||actor.authEpoch!==input.actor.authEpoch||
      actor.accountVersion!==input.actor.accountVersion||!["admin","manager","agent"].includes(actor.role??""))throw unavailable();
    if(actor.role==="agent"&&!input.fields.contactId)throw unavailable();
    const links=await validateLinks(tx,input.fields,actor,"production");
    const identity=target===undefined&&actor.role==="agent"?actor.id:target;
    const assignee=identity?await resolveWorkAssignee(identity,tx,principals):null;
    const fields={...input.fields,assignedTo:assignee?.email??null};
    if(assignee&&links.contact&&links.contact.assignedTo!==assignee.email)
      throw new WorkCommandError("Assignee does not own the linked record. Use the approved ownership handoff first.",409);
    const commandHash=hash(input);
    const eventKey=`create-intent:${commandKey}`;
    const [prior]=await tx.select().from(ticketAuthorityEvents).where(and(
      eq(ticketAuthorityEvents.eventKey,eventKey),eq(ticketAuthorityEvents.producer,"dashboard")));
    if(prior){
      const [current]=await tx.select().from(tickets).where(eq(tickets.id,prior.ticketId)).for("update");
      if(!current)throw unavailable();
      await validateLinks(tx,current,actor,"production");
      if((prior.payload as any)?.commandHash!==commandHash)
        throw new WorkCommandError("Creation retry differs from the original ticket intent. No new ticket was created.",409);
      return {ticket:current,replayed:true,reused:!!(prior.payload as any)?.reused};
    }
    const {storage}=await import("../storage");
    const ticket=await storage.createAuthorityTicket(fields as any,{producer:"dashboard",commandKey},tx);
    await validateLinks(tx,ticket,actor,"production");
    const reused=ticket.commandKey!==commandKey;
    if(reused){
      // Keep the original active-issue identity, but never acknowledge changed
      // data as a save just because category/subject happen to match.
      for(const [key,value]of Object.entries(fields)){
        if(hash(value)!==hash((ticket as any)[key]))
          throw new WorkCommandError("An active ticket already exists with different fields. Open it; no ticket was created or changed.",409);
      }
    }else{
      await auditChange({actorType:"user",userId:actor.id,action:"ticket_created",entityType:"ticket",entityId:ticket.id,
        before:null,after:{id:ticket.id,contactId:ticket.contactId,status:ticket.status,
          assignedTo:ticket.assignedTo,authorityFence:ticket.authorityFence}},tx);
      if(assignee)await tx.insert(notifications).values({channel:"internal",title:"Ticket Assigned",
        message:`Ticket #${ticket.id} has been assigned to ${assignee.email}.`,type:"info",recipientId:assignee.id,
        metadata:{ticketId:ticket.id,eventType:"ticket_assigned",assignedTo:assignee.email}});
    }
    await tx.insert(ticketAuthorityEvents).values({ticketId:ticket.id,eventKey,eventType:"creation_intent_accepted",
      producer:"dashboard",commandKey,fence:ticket.authorityFence,toState:ticket.authorityState,
      payload:{commandHash,reused,actorId:actor.id}});
    return {ticket,replayed:false,reused};
  });
}
