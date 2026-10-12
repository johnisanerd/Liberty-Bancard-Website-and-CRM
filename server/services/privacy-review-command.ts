import {eq} from "drizzle-orm";
import {z} from "zod";
import {db} from "../db";
import {users,contacts,dataDeleteRequests} from "@shared/schema";
import {auditChange} from "./audit-change";
import {WorkCommandError,workPrincipalFields,type WorkActor} from "./work-item-command";
export const privacyReviewCommand=z.object({
  status:z.enum(["pending","processing","completed","denied"]),
  expectedVersion:z.number().int().positive(),
  subjectContactId:z.number().int().positive().max(2147483647),
  reviewEvidence:z.string().trim().min(1).max(4000),
  retentionReason:z.string().trim().min(1).max(4000),
  expectedActorId:z.string().min(1),expectedAccountVersion:z.number().int().positive().optional(),
}).strict();
const transitions:Record<string,string[]>={pending:["processing","denied"],processing:["completed","denied","pending"],
  completed:["processing"],denied:["processing"]};
export async function reviewPrivacyRequest(id:number,actor:WorkActor,input:z.infer<typeof privacyReviewCommand>) {
  return db.transaction(async tx=>{
    const [operator]=await tx.select(workPrincipalFields).from(users).where(eq(users.id,actor.id)).for("share");
    if(!operator || operator.role!=="admin" || operator.accountState!=="active" || operator.authEpoch!==actor.authEpoch ||
      (actor.accountVersion!==undefined && operator.accountVersion!==actor.accountVersion)) throw new WorkCommandError("Request unavailable",404);
    const [subject]=await tx.select().from(contacts).where(eq(contacts.id,input.subjectContactId)).for("share");
    const [before]=await tx.select().from(dataDeleteRequests).where(eq(dataDeleteRequests.id,id)).for("update");
    if(!before || !subject?.email?.trim() || before.email.trim().toLowerCase()!==subject.email.trim().toLowerCase() ||
      /@(?:[^@]+\.)?libertybancard\.internal$/i.test(subject.email)) {
      throw new WorkCommandError("Subject record match could not be verified; no review state was changed.",409);
    }
    // Retry only the identical accepted administrative outcome. This is not
    // identity ownership certification or an erasure execution receipt.
    if(before.version===input.expectedVersion+1 && before.status===input.status &&
      before.subjectContactId===input.subjectContactId && before.reviewEvidence===input.reviewEvidence &&
      before.retentionReason===input.retentionReason && before.processedBy===actor.id) return {...before,replayed:true};
    if(before.version!==input.expectedVersion) throw new WorkCommandError("Privacy review changed. Reload before saving.",409);
    if(before.status!==input.status && !transitions[before.status ?? "pending"]?.includes(input.status)) {
      throw new WorkCommandError("Unsupported administrative review transition.",409);
    }
    if(before.status===input.status) return {...before,changed:false};
    const [after]=await tx.update(dataDeleteRequests).set({status:input.status,version:before.version+1,
      subjectContactId:subject.id,reviewEvidence:input.reviewEvidence,retentionReason:input.retentionReason,
      processedBy:operator.id,processedAt:new Date(),executionState:"not_executed"}).where(eq(dataDeleteRequests.id,id)).returning();
    await auditChange({userId:operator.id,actorType:"user",action:"privacy_review_updated",entityType:"data_request",entityId:id,
      before,after,details:{recordMatchOnly:true,erasureExecuted:false}},tx);
    return {...after,changed:true,replayed:false};
  });
}
