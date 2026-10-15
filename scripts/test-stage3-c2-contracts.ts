import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { contactAreas, contactAreaSections, contactSections, contactWorkspaceState,
  buildContactWorkspaceHref, workWorkspaceState, buildWorkWorkspaceHref, inboxWorkspaceState,
  buildInboxWorkspaceHref } from "../client/src/lib/crm-destination-state";
import { normalizeGhlMessage } from "../server/services/ghl-message-normalization";
import { crmDayWindow } from "../shared/crm-time-window";
import { writeCandidateIdentity, verifyCandidateIdentity } from "./fixtures/candidate-build-identity";
import { taskPresentationState, isPendingTask, decodeTaskRows } from "../client/src/lib/task-source";
import { decodeInboxSourceItem, decodeInboxSourcePage } from "../client/src/lib/inbox-source";

let assertions=0;
for (const [authorityState, status, expected, pending] of [
  ["cancelled", "pending", "cancelled", false],
  ["completed", "pending", "completed", false],
  ["open", "completed", "open", true],
  ["in_progress", "completed", "in_progress", true],
  [null, "canceled", "cancelled", false],
  [null, "done", "completed", false],
] as const) {
  const task={authorityState,status};
  assert.equal(taskPresentationState(task),expected);
  assert.equal(isPendingTask(task),pending);assertions+=2;
}
assert.equal(taskPresentationState({effectiveState:"cancelled",authorityState:"open",status:"pending"}),"cancelled");assertions++;
assert.throws(()=>taskPresentationState({effectiveState:"invalid",status:"pending"}));assertions++;
for(const malformed of [{data:[]},null,[{id:1,title:"missing state"}],[{id:0,title:"bad id",status:"pending",authorityFence:0}]]){
  assert.throws(()=>decodeTaskRows(malformed));assertions++;
}
assert.equal(decodeTaskRows([{id:1,title:"Terminal",status:"pending",authorityState:"cancelled",authorityFence:0}]).length,1);assertions++;
for(const area of contactAreas) for(const section of contactAreaSections[area]) {
  const href=buildContactWorkspaceHref("/dashboard/contacts/12?contactId=12&search=exact#notes",{area,section});
  const state=contactWorkspaceState(href.split("?")[1].split("#")[0]);
  assert.equal(state.area,area);assert.equal(state.section,section);assert.equal(state.issues.length,0);assertions+=3;
  for(const drawer of ["activity","history"] as const) {
    const open=buildContactWorkspaceHref(href,{drawer});
    const selected=contactWorkspaceState(new URL(open,"https://test.invalid").search);
    assert.equal(selected.section,section);assert.equal(selected.drawer,drawer);
    assert.equal(buildContactWorkspaceHref(open,{drawer:null}),href);assertions+=3;
  }
}
assert.equal(contactAreas.length,5);
assert.equal(Object.values(contactAreaSections).flat().length,23);
assert.equal(contactSections.length,25);
for(const tab of contactSections) {
  const state=contactWorkspaceState(`tab=${tab}`);
  assert.equal(["activity","history"].includes(tab)?state.drawer:state.section,tab);assertions++;
}
for(const input of ["area=lifecycle&section=notes","section=tasks&section=notes","section=unknown",
  "drawer=activity&drawer=history","tab=tasks&section=deals"]) {
  assert.ok(contactWorkspaceState(input).issues.length);assertions++;
}
assert.equal(contactWorkspaceState("section=notes&section=notes").section,"notes");
assert.equal(contactWorkspaceState("",[]).section,null);
assert.equal(contactWorkspaceState("section=notes",["overview"]).section,"overview");
assert.equal(workWorkspaceState("tab=calendar").tab,"calendar");
assert.equal(buildWorkWorkspaceHref("/dashboard/tasks-appointments?contactId=23&search=due#work","calendar"),
  "/dashboard/tasks-appointments?search=due&contactId=23&tab=calendar#work");
assert.equal(inboxWorkspaceState("tab=messages").channel,"sms");
assert.equal(inboxWorkspaceState("tab=live-chat").channel,"site");
assert.ok(inboxWorkspaceState("tab=messages&channel=email").issues.length);
assert.equal(inboxWorkspaceState("thread=ghl%3Alocation%3A%3Amessage%3A1").thread,"ghl:location::message:1");
const inboxHref=buildInboxWorkspaceHref("/dashboard/comms-hub?contactId=12#reply",{channel:"email",filter:"needs_reply",thread:"ghl:loc::message:42",search:"invoice"});
assert.equal(inboxWorkspaceState(new URL(inboxHref,"https://test.invalid").search).thread,"ghl:loc::message:42");
const mobileInboxHref=buildInboxWorkspaceHref("/mobile/inbox?channel=email#reply",
  {filter:"unread",thread:"ghl:loc::message:42",search:"invoice"});
assert.ok(mobileInboxHref.startsWith("/mobile/inbox?"));
const mobileInboxState=inboxWorkspaceState(new URL(mobileInboxHref,"https://test.invalid").search);
assert.equal(mobileInboxState.channel,"email");
assert.equal(mobileInboxState.thread,"ghl:loc::message:42");
assert.ok(mobileInboxHref.endsWith("#reply"));
const sourceItem={id:"email::fixture",contactId:1,contactName:null,channel:"email",isRead:false,body:"Captured"};
assert.equal(decodeInboxSourceItem(sourceItem,sourceItem.id).id,sourceItem.id);
assert.throws(()=>decodeInboxSourceItem(sourceItem,"email::different"));
assert.throws(()=>decodeInboxSourceItem({...sourceItem,channel:"unknown"},sourceItem.id));
const sourcePage={items:[sourceItem],complete:false,totalIsExact:false,knownFilteredCount:1,
  hasMoreKnown:true,sourceStatus:[{source:"email",status:"ok",fetched:1,truncated:true}],nextCursor:"signed"};
assert.throws(()=>decodeInboxSourcePage({...sourcePage,items:{}}));
assert.throws(()=>decodeInboxSourcePage({...sourcePage,sourceStatus:[{source:"email",status:"unknown",fetched:1,truncated:true}]}));
assert.equal(decodeInboxSourcePage(sourcePage).items.length,1);
assertions+=10;
const raw={id:"m1",locationId:"loc",conversationId:"c1",dateAdded:"2026-10-07T12:00:00Z",direction:"inbound",body:"same"};
for(const [type,channel] of [["TYPE_SMS","sms"],["TYPE_EMAIL","email"],["TYPE_WEBCHAT","ghl_chat"],["TYPE_VOICEMAIL","voicemail"]] as const){
  const message=normalizeGhlMessage("loc",{...raw,messageType:type});
  assert.equal(message?.channel,channel);assert.equal(message?.id,"ghl:loc::message:m1");assertions+=2;
}
assert.equal(normalizeGhlMessage("loc",{...raw,messageType:"TYPE_CALL"}),null);
assert.equal(normalizeGhlMessage("loc",{...raw,direction:"outbound",messageType:"TYPE_SMS",unreadCount:2}),null);
assert.throws(()=>normalizeGhlMessage("foreign",{...raw,messageType:"TYPE_SMS"}));
assert.throws(()=>normalizeGhlMessage("loc",{...raw,id:undefined,messageType:"TYPE_SMS"}));
assert.throws(()=>normalizeGhlMessage("loc",{...raw,direction:undefined,messageType:"TYPE_SMS"}));
assert.notEqual(normalizeGhlMessage("loc",{...raw,messageType:"TYPE_SMS"})?.id,
  normalizeGhlMessage("loc",{...raw,id:"m2",messageType:"TYPE_SMS"})?.id,"same body is not deduplication identity");
for(const [instant,hours] of [["2026-03-08T12:00:00Z",23],["2026-11-01T12:00:00Z",25]] as const){
  const w=crmDayWindow(new Date(instant),"America/New_York");
  assert.equal((w.endExclusive.getTime()-w.start.getTime())/3600000,hours);assertions++;
}
assert.throws(()=>crmDayWindow(new Date(),"Not/A_Zone"));
const root=await mkdtemp(path.join(os.tmpdir(),"c2-build-identity-"));
try{
  execFileSync("git",["init","-q",root]);
  for(const dir of ["client","dist/public/assets"])await mkdir(path.join(root,dir),{recursive:true});
  const originals:Record<string,string>={"client/main.ts":"candidate", "postcss.config.js":"compiler recipe",
    "dist/public/index.html":"compiled", "dist/index.cjs":"server",
    "dist/public/assets/main.js":"chunk","dist/public/assets/theme.css":"css","dist/public/assets/font.woff2":"font",
    // Synthetic receipt for tamper tests, not evidence of a production compilation.
    "dist/build-recipe.json":JSON.stringify({version:1,mode:"production",nodeEnv:"production",node:process.version,
      npm:execFileSync("npm",["--version"],{encoding:"utf8"}).trim(),entryPoint:"script/build.ts",
      client:"vite:production",server:"esbuild:production"})};
  for(const [file,text] of Object.entries(originals))await writeFile(path.join(root,file),text);
  execFileSync("git",["-C",root,"add","client","postcss.config.js"]);
  execFileSync("git",["-C",root,"-c","user.name=Fixture","-c","user.email=fixture@example.test","commit","-qm","fixture"]);
  await writeCandidateIdentity(root);await verifyCandidateIdentity(root);
  const originalMode=process.env.NODE_ENV;
  const invalidRecipe=JSON.parse(originals["dist/build-recipe.json"]);
  for(const change of [{mode:"test"},{nodeEnv:"test"},{client:"vite:test"},{node:"v0.0.0"},{npm:"0.0.0"}]){
    await writeFile(path.join(root,"dist/build-recipe.json"),JSON.stringify({...invalidRecipe,...change}));
    await assert.rejects(verifyCandidateIdentity(root));assertions++;
  }
  await writeFile(path.join(root,"dist/build-recipe.json"),originals["dist/build-recipe.json"]);
  assert.equal(process.env.NODE_ENV,originalMode,"Recipe verification must not change the test runtime");
  for(const file of ["postcss.config.js","dist/public/assets/main.js","dist/public/assets/theme.css","dist/public/assets/font.woff2"]){
    await writeFile(path.join(root,file),"tampered");await utimes(path.join(root,file),1,1);
    await assert.rejects(verifyCandidateIdentity(root));assertions++;
    await writeFile(path.join(root,file),originals[file]);
  }
  await rm(path.join(root,"dist/public/assets/theme.css"));
  await assert.rejects(verifyCandidateIdentity(root));assertions++;
}finally{await rm(root,{recursive:true,force:true});}
console.log(`C2 contracts: PASS (${assertions} counted assertions plus boundary checks); no DB/providers/browser claims`);
