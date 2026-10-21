import assert from "node:assert/strict";
import {stage3BHttpFixture} from "./fixtures/stage3-b-http";

// Dead-letter history: the review list excludes it, aggregates report it separately, and the admin-only archive
// route moves pending rows to "archived" without deleting them. Real route module and guards on a disposable
// migrated database with real persisted admin/manager sessions. Fixture rows use queue name "dlq-archive-test".
const h=await stage3BHttpFixture(async app=>{
  const module=await import("../server/routes/review-queue.ts");module.registerReviewQueueRoutes(app);
  app.use("/api",(_req,res)=>res.status(501).json({message:"Source not registered in this isolated fixture"}));
},undefined,{backgroundProfile:"off"});
const checks:string[]=[];
const check=(ok:unknown,label:string)=>{assert.ok(ok,label);checks.push(label);};
try{
  const {db}=await import("../server/db");
  const {reviewQueue}=await import("../shared/schema");
  const {sql,eq}=await import("drizzle-orm");
  await db.delete(reviewQueue).where(eq(reviewQueue.sourceType,"dead_letter_job"));
  const old=new Date("2026-10-01T12:00:00Z"),recent=new Date("2026-10-18T12:00:00Z");
  const event=(queueName:string,jobName:string)=>({queueName,jobName,failureCode:"timeout",attempts:3,maxAttempts:3,source:"bullmq",retryable:false});
  const rows=[
    ...Array.from({length:7},()=>({sourceType:"dead_letter_job" as const,sourceId:0,status:"pending" as const,metadata:event("dlq-archive-test","tick"),createdAt:old})),
    {sourceType:"dead_letter_job" as const,sourceId:0,status:"pending" as const,metadata:event("dlq-archive-test","tick"),createdAt:recent},
    {sourceType:"dead_letter_job" as const,sourceId:0,status:"pending" as const,metadata:event("dlq-archive-test","continue"),createdAt:old},
    {sourceType:"dead_letter_job" as const,sourceId:0,status:"pending" as const,metadata:event("other-queue","tick"),createdAt:old},
    {sourceType:"quiz" as const,sourceId:1,status:"pending" as const,metadata:{email:"dlq-archive-test@example.invalid"},createdAt:old},
  ];
  await db.insert(reviewQueue).values(rows);

  const list=await h.request("manager","GET","/api/review-queue?status=pending");
  check(list.status===200&&(list.body as any[]).every(r=>r.sourceType!=="dead_letter_job"),"review list excludes dead-letter history");
  check((list.body as any[]).some(r=>r.sourceType==="quiz"),"review list still includes real items");
  const agg=await h.request("manager","GET","/api/review-queue/pending-count");
  check((agg.body as any).pending===1&&(agg.body as any).total===1,"pending/total count only real review items");
  check((agg.body as any).deadLetter.pending===10,"dead-letter counts are reported separately");
  const history=await h.request("manager","GET","/api/review-queue/dead-letter-events?limit=5");
  check(history.status===200&&(history.body as any).events.length===5&&!!(history.body as any).next_cursor,"history route pages dead-letter rows");

  const scope={queueName:"dlq-archive-test",jobName:"tick",createdBefore:"2026-10-16T00:00:00Z"};
  const denied=await h.request("manager","POST","/api/review-queue/dead-letter-events/archive",{...scope,expectedCount:7,dryRun:false});
  check(denied.status===403,"manager cannot archive");
  const anon=await h.request("agent","POST","/api/review-queue/dead-letter-events/archive",{...scope,expectedCount:7,dryRun:false});
  check(anon.status===403,"agent cannot archive");
  const dry=await h.request("admin","POST","/api/review-queue/dead-letter-events/archive",{...scope,expectedCount:7});
  check(dry.status===200&&(dry.body as any).dryRun===true&&(dry.body as any).matched===7&&(dry.body as any).archived===0,"default is a dry run that changes nothing");
  const wrong=await h.request("admin","POST","/api/review-queue/dead-letter-events/archive",{...scope,expectedCount:8,dryRun:false});
  check(wrong.status===409&&(wrong.body as any).matched===7,"mismatched expectedCount archives nothing (409)");
  const bad=await h.request("admin","POST","/api/review-queue/dead-letter-events/archive",{...scope,expectedCount:7,dryRun:false,extra:1});
  check(bad.status===400,"unknown fields are rejected");
  const run=await h.request("admin","POST","/api/review-queue/dead-letter-events/archive",{...scope,expectedCount:7,dryRun:false});
  check(run.status===200&&(run.body as any).archived===7,"admin archives exactly the matching old rows");
  const again=await h.request("admin","POST","/api/review-queue/dead-letter-events/archive",{...scope,expectedCount:0,dryRun:false});
  check(again.status===200&&(again.body as any).archived===0,"repeat run is idempotent");

  const counts=(await db.execute(sql`select status, count(*)::int n from review_queue where source_type='dead_letter_job' group by 1 order by 1`)).rows as any[];
  const by=Object.fromEntries(counts.map(r=>[r.status,r.n]));
  check(by.archived===7&&by.pending===3,"only the 7 matching rows changed; recent, other-job and other-queue rows stay pending");
  const total=(await db.execute(sql`select count(*)::int n from review_queue where source_type='dead_letter_job'`)).rows[0] as any;
  check(total.n===10,"no dead-letter rows were deleted");
  const agg2=await h.request("manager","GET","/api/review-queue/pending-count");
  check((agg2.body as any).deadLetter.pending===3&&!("archived" in (agg2.body as any).deadLetter),"counts show only pending; archived rows are not reported");
  const logged=(await db.execute(sql`select count(*)::int n from audit_logs where action='dead_letter_events_archived'`)).rows[0] as any;
  check(logged.n===1,"one audit log entry for the executed archive");
  const archivedRow=(await db.select().from(reviewQueue).where(eq(reviewQueue.status,"archived")).limit(1))[0];
  const hist=await h.request("manager","GET","/api/review-queue/dead-letter-events?limit=100");
  check((hist.body as any).events.length===3&&(hist.body as any).events.every((e:any)=>e.status==="pending"),"history route returns no archived rows");
  const archivedRead=await h.request("manager","GET",`/api/review-queue/${archivedRow.id}`);
  check(archivedRead.status===404,"an archived row cannot be read by id");
  const approve=await h.request("admin","POST",`/api/review-queue/${archivedRow.id}/approve`,{});
  check(approve.status===400,"archived items cannot be approved");
  // Archive and audit commit together: an audit failure rolls the whole archive back.
  const {pool}=await import("../server/db");
  const auditBefore=(await db.execute(sql`select count(*)::int n from audit_logs where action='dead_letter_events_archived'`)).rows[0] as any;
  await db.insert(reviewQueue).values(Array.from({length:3},()=>({sourceType:"dead_letter_job" as const,sourceId:0,status:"pending" as const,metadata:event("dlq-audit-fail","tick"),createdAt:old})));
  await pool.query(`CREATE OR REPLACE FUNCTION dlq_test_fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'dlq test audit failure'; END $$ LANGUAGE plpgsql`);
  await pool.query(`CREATE TRIGGER dlq_test_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.action='dead_letter_events_archived') EXECUTE FUNCTION dlq_test_fail_audit()`);
  try{
    const failing=await h.request("admin","POST","/api/review-queue/dead-letter-events/archive",{queueName:"dlq-audit-fail",createdBefore:"2026-10-16T00:00:00Z",expectedCount:3,dryRun:false});
    check(failing.status===500,"audit failure fails the request");
    const stillPending=(await db.execute(sql`select count(*)::int n from review_queue where status='pending' and source_type='dead_letter_job' and metadata->>'queueName'='dlq-audit-fail'`)).rows[0] as any;
    check(stillPending.n===3,"audit failure rolls the archive back");
  }finally{
    await pool.query(`DROP TRIGGER IF EXISTS dlq_test_fail_audit ON audit_logs`);await pool.query(`DROP FUNCTION IF EXISTS dlq_test_fail_audit()`);
  }
  const retry=await h.request("admin","POST","/api/review-queue/dead-letter-events/archive",{queueName:"dlq-audit-fail",createdBefore:"2026-10-16T00:00:00Z",expectedCount:3,dryRun:false});
  check(retry.status===200&&(retry.body as any).archived===3,"retry after the audit fault archives exactly the same rows");
  const auditAfter=(await db.execute(sql`select count(*)::int n from audit_logs where action='dead_letter_events_archived'`)).rows[0] as any;
  check(auditAfter.n===auditBefore.n+1,"exactly one audit row for the successful archive");

  // Approval cannot revive an item archived between its read and its update.
  const {REVIEW_CHECKLIST_ITEMS}=await import("../shared/schema");
  const checklistState=Object.fromEntries(REVIEW_CHECKLIST_ITEMS.map(i=>[i.key,true]));
  const [raced]=await db.insert(reviewQueue).values({sourceType:"quiz" as const,sourceId:2,status:"pending" as const,metadata:{email:"dlq-race@example.invalid"},checklistState,createdAt:old}).returning();
  const holder=await pool.connect();
  try{
    await holder.query("BEGIN");
    await holder.query("SELECT id FROM review_queue WHERE id=$1 FOR UPDATE",[raced.id]);
    const approving=h.request("admin","POST",`/api/review-queue/${raced.id}/approve`,{});
    await new Promise(r=>setTimeout(r,700));
    await holder.query("UPDATE review_queue SET status='archived' WHERE id=$1",[raced.id]);
    await holder.query("COMMIT");
    const outcome=await approving;
    check(outcome.status===409,"approval racing an archive is refused");
  }finally{holder.release();}
  const racedAfter=(await db.execute(sql`select status from review_queue where id=${raced.id}`)).rows[0] as any;
  check(racedAfter.status==="archived","archived item stays archived");
  const approvalAudit=(await db.execute(sql`select count(*)::int n from audit_logs where action='review_queue_approved' and entity_id=${raced.id}`)).rows[0] as any;
  check(approvalAudit.n===0,"no approval audit for a refused approval");
  console.log(`Dead-letter archive: PASS (${checks.length} checks)`);
}finally{await h.close();}
