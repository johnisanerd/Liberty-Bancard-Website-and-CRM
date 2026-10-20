import {createHash} from "node:crypto";
import {and,asc,eq,sql} from "drizzle-orm";
import {z} from "zod";
import {db} from "../db";
import {users,followUpSequences,sequenceCommandReceipts,sequenceSteps,insertSequenceStepSchema,type InsertFollowUpSequence} from "@shared/schema";
import {workPrincipalFields,WorkCommandError,type WorkActor} from "./work-item-command";
import {auditChange} from "./audit-change";
export const sequenceCommandFields=z.object({commandId:z.string().uuid(),expectedVersion:z.number().int().positive(),
  expectedActorId:z.string().min(1),expectedAccountVersion:z.number().int().positive().optional()}).strict();
export const sequenceEditorSteps=z.array(insertSequenceStepSchema.omit({sequenceId:true}).extend({
  id:z.number().int().positive().optional(),stepOrder:z.number().int().positive(),
})).max(100);
export async function commandSequence(actor:WorkActor,id:number,operation:"edit"|"toggle"|"retire"|"restore",
  fields:z.infer<typeof sequenceCommandFields>,updates:Partial<InsertFollowUpSequence>={},editorSteps?:z.infer<typeof sequenceEditorSteps>) {
  const hash=createHash("sha256").update(JSON.stringify([actor,id,operation,fields,updates,editorSteps])).digest("hex");
  return db.transaction(async tx=>{
    const [principal]=await tx.select(workPrincipalFields).from(users).where(eq(users.id,actor.id)).for("share");
    if(!principal || principal.accountState!=="active" || principal.authEpoch!==actor.authEpoch ||
      principal.accountVersion!==actor.accountVersion || !["admin","manager"].includes(principal.role ?? "")) throw new WorkCommandError("Sequence unavailable",404);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sequence-command:${actor.id}:${fields.commandId}`},0))`);
    const [before]=await tx.select().from(followUpSequences).where(eq(followUpSequences.id,id)).for("update");
    if(!before || (principal.role==="manager" && before.createdBy!==principal.email && before.createdBy!==principal.id)) throw new WorkCommandError("Sequence unavailable",404);
    const [prior]=await tx.select().from(sequenceCommandReceipts).where(and(eq(sequenceCommandReceipts.actorId,actor.id),eq(sequenceCommandReceipts.commandId,fields.commandId)));
    if(prior) {
      if(prior.payloadHash!==hash) throw new WorkCommandError("Sequence retry differs from the retained command",409);
      return {...prior.result as any,replayed:true};
    }
    if(before.version!==fields.expectedVersion) throw new WorkCommandError("Sequence changed. Reload before saving; nothing was changed.",409);
    if(before.retiredAt && operation!=="restore") throw new WorkCommandError("Sequence retired. Restore it to paused before editing or preparing.",409);
    if(["edit","retire"].includes(operation) && !["paused","draft"].includes(before.status ?? "")) throw new WorkCommandError("Pause this sequence before editing or retiring it.",409);
    if(operation==="restore" && !before.retiredAt) throw new WorkCommandError("Sequence is not retired",409);
    if(operation==="toggle" && !["active","paused","draft"].includes(before.status ?? "")) throw new WorkCommandError("Unsupported sequence state",409);
    const retainedSteps=editorSteps===undefined?[]:await tx.select().from(sequenceSteps).where(eq(sequenceSteps.sequenceId,id))
      .orderBy(asc(sequenceSteps.id)).for("update");
    if(editorSteps!==undefined) {
      const ids=editorSteps.flatMap(step=>step.id?[step.id]:[]);
      if(new Set(ids).size!==ids.length || ids.some(stepId=>!retainedSteps.some(row=>row.id===stepId))) throw new WorkCommandError("Selected sequence steps unavailable; nothing was changed",404);
      if(retainedSteps.some(step=>!ids.includes(step.id))) throw new WorkCommandError("Step removal is blocked until retained-history dependencies are certified. Edit steps or retire the sequence instead.",409);
      if(new Set(editorSteps.map(step=>step.stepOrder)).size!==editorSteps.length) throw new WorkCommandError("Duplicate step order; nothing was changed",409);
      for(const {id:stepId,...step} of editorSteps) {
        if(stepId) await tx.update(sequenceSteps).set(step).where(and(eq(sequenceSteps.id,stepId),eq(sequenceSteps.sequenceId,id)));
        else await tx.insert(sequenceSteps).values({...step,sequenceId:id});
      }
    }
    const [after]=await tx.update(followUpSequences).set({...(operation==="edit"?updates:{}),
      ...(editorSteps!==undefined?{totalSteps:editorSteps.length}:{}),
      ...(operation==="retire"?{retiredAt:new Date(),status:"paused"}:operation==="restore"?{retiredAt:null,status:"paused"}:
        operation==="toggle"?{status:before.status==="active"?"paused":"active"}:{}),
      version:before.version+1,updatedAt:new Date()}).where(eq(followUpSequences.id,id)).returning();
    await auditChange({userId:actor.id,actorType:"user",action:`sequence_${operation}`,entityType:"sequence",entityId:id,before,after,
      details:{commandId:fields.commandId,historyRetained:true,retainedStepIds:retainedSteps.map(step=>step.id)}},tx);
    const result={...after,replayed:false};
    await tx.insert(sequenceCommandReceipts).values({actorId:actor.id,commandId:fields.commandId,sequenceId:id,payloadHash:hash,result});
    return result;
  });
}

export const sequenceCreateCommandFields=z.object({commandId:z.string().uuid(),expectedActorId:z.string().min(1),
  expectedAccountVersion:z.number().int().positive()}).strict();
/** Idempotent initial create. The sequence row, its audit row and the replay receipt commit in ONE transaction, so a
 * lost response or a retry can only recover the committed ID (never create a second sequence), and a committed
 * sequence can never lack its audit row. The server owns the paused status, step count and creator. A retry whose
 * normalized payload differs from the retained command conflicts (409). */
export async function createSequenceCommand(actor:WorkActor,fields:z.infer<typeof sequenceCreateCommandFields>,
  input:Omit<InsertFollowUpSequence,"status"|"totalSteps"|"createdBy">) {
  const hash=createHash("sha256").update(JSON.stringify([actor,"create",fields,input])).digest("hex");
  return db.transaction(async tx=>{
    const [principal]=await tx.select(workPrincipalFields).from(users).where(eq(users.id,actor.id)).for("share");
    if(!principal || principal.accountState!=="active" || principal.authEpoch!==actor.authEpoch ||
      principal.accountVersion!==actor.accountVersion || !["admin","manager"].includes(principal.role ?? "")) throw new WorkCommandError("Sequence unavailable",404);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sequence-command:${actor.id}:${fields.commandId}`},0))`);
    const [prior]=await tx.select().from(sequenceCommandReceipts).where(and(eq(sequenceCommandReceipts.actorId,actor.id),eq(sequenceCommandReceipts.commandId,fields.commandId)));
    if(prior) {
      if(prior.payloadHash!==hash) throw new WorkCommandError("Sequence create retry differs from the retained command",409);
      return {...prior.result as any,replayed:true};
    }
    const [created]=await tx.insert(followUpSequences).values({...input,status:"paused",totalSteps:0,createdBy:principal.email ?? principal.id}).returning();
    await auditChange({userId:actor.id,actorType:"user",action:"sequence_created",entityType:"sequence",entityId:created.id,
      after:created as any,details:{name:created.name,commandId:fields.commandId}},tx);
    const result={...created,replayed:false};
    await tx.insert(sequenceCommandReceipts).values({actorId:actor.id,commandId:fields.commandId,sequenceId:created.id,payloadHash:hash,result});
    return result;
  });
}
