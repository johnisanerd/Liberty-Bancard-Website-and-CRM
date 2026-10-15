import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";

const receiptPath = "dist/candidate-integrity.json";
export function productionBuildRecipe() {
  assert.equal(process.env.NODE_ENV, "production", "Artifact compilation must run in production mode");
  return { version: 1, mode: "production", nodeEnv: "production", node: process.version,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    entryPoint: "script/build.ts", client: "vite:production", server: "esbuild:production" };
}
async function readBuildRecipe(root:string) {
  const recipe = JSON.parse(await readFile(path.join(root, "dist/build-recipe.json"), "utf8"));
  assert.equal(recipe.version, 1, "Unknown production recipe");
  assert.equal(recipe.mode, "production", "Acceptance requires the production client");
  assert.equal(recipe.nodeEnv, "production", "Build NODE_ENV must be production");
  assert.equal(recipe.node, process.version, "Acceptance/build Node toolchains differ");
  assert.equal(recipe.npm, execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(), "Acceptance/build npm toolchains differ");
  assert.equal(recipe.entryPoint, "script/build.ts");
  assert.equal(recipe.client, "vite:production");
  assert.equal(recipe.server, "esbuild:production");
  return recipe;
}
const inputRoots = ["client","server","shared","scripts","script","migrations","public","attached_assets","package.json","package-lock.json",
  "vite.config.ts","tailwind.config.ts","tailwind-legacy-theme.json","tsconfig.json",
  "postcss.config.js","drizzle.config.ts",".replit"];
type FileReceipt = {file:string;bytes:number;sha256:string};
async function digestFiles(files:string[], root:string):Promise<FileReceipt[]> {
  const receipts:FileReceipt[]=[];
  for(const file of files.sort()){
    const digest=createHash("sha256");let bytes=0;
    for await(const chunk of createReadStream(path.join(root,file))){bytes+=chunk.length;digest.update(chunk);}
    receipts.push({file,bytes,sha256:digest.digest("hex")});
  }
  return receipts;
}
async function outputs(root:string, dir="dist"):Promise<string[]> {
  const files:string[]=[];
  for(const entry of await readdir(path.join(root,dir),{withFileTypes:true})) {
    const file=`${dir}/${entry.name}`;
    if(file===receiptPath) continue;
    assert.ok(!entry.isSymbolicLink(),`Candidate output cannot be a symlink: ${file}`);
    if(entry.isDirectory())files.push(...await outputs(root,file));
    else if(entry.isFile())files.push(file);
  }
  return files;
}
function aggregate(files:FileReceipt[]) {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}
export async function captureCandidateSource(root=process.cwd()) {
  const files=execFileSync("git",["ls-files","--cached","--others","--exclude-standard","-z",...inputRoots],{cwd:root,encoding:"utf8"})
    .split("\0").filter(Boolean);
  // The stock isolated build links the asset directory into its checkout.
  // Git reports that untracked directory link as a path in addition to the
  // tracked descendants. Hash the effective files, never the directory itself.
  const effectiveFiles=new Set<string>();
  const expand=async(file:string,ancestors=new Set<string>())=>{
    const info=await stat(path.join(root,file));
    if(info.isFile()){effectiveFiles.add(file);return;}
    assert.ok(info.isDirectory(),`Unsupported candidate input: ${file}`);
    const key=`${info.dev}:${info.ino}`;
    assert.ok(!ancestors.has(key),`Cyclic candidate input directory: ${file}`);
    const next=new Set(ancestors);next.add(key);
    for(const entry of await readdir(path.join(root,file)))await expand(`${file}/${entry}`,next);
  };
  for(const file of files)await expand(file);
  const inputs=await digestFiles([...effectiveFiles],root);
  return {inputs,inputHash:aggregate(inputs),sourceHead:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim()};
}
export async function captureCandidateIdentity(root=process.cwd()) {
  const source=await captureCandidateSource(root);
  const buildRecipe=await readBuildRecipe(root);
  const emitted=await digestFiles(await outputs(root),root);
  assert.ok(emitted.some(f=>f.file==="dist/public/index.html") && emitted.some(f=>f.file==="dist/index.cjs"),"Complete client/server outputs required");
  return {version:2,...source,sourceInputHash:source.inputHash,
    inputHash:createHash("sha256").update(JSON.stringify({sourceInputHash:source.inputHash,buildRecipe})).digest("hex"),
    outputs:emitted,outputHash:aggregate(emitted),buildRecipe,
    recipe:"Node22.22/npm10.9.4 locked install; script/build.ts; Vite client and bundled server",
    qualification:"Compiled client plus registered source handlers in isolated preview; NOT deployed bundled-server parity"};
}
export async function writeCandidateIdentity(root=process.cwd(), expectedSource?:Awaited<ReturnType<typeof captureCandidateSource>>) {
  const identity=await captureCandidateIdentity(root);
  if(expectedSource){
    assert.equal(identity.sourceInputHash,expectedSource.inputHash,"Effective inputs changed during compilation; discard and rebuild");
    assert.equal(identity.sourceHead,expectedSource.sourceHead,"Source commit changed during compilation; discard and rebuild");
  }
  await writeFile(path.join(root,receiptPath),JSON.stringify(identity,null,2)+"\n");
  return identity;
}
export async function verifyCandidateIdentity(root=process.cwd()) {
  const recorded=JSON.parse(await readFile(path.join(root,receiptPath),"utf8"));
  const current=await captureCandidateIdentity(root);
  assert.equal(recorded.version,2,"Unrecognized build recipe; rebuild the production artifact");
  assert.deepEqual(current.buildRecipe,recorded.buildRecipe,"Effective production build recipe changed");
  assert.equal(current.inputHash,recorded.inputHash,"Source/config/lock/fixture inputs changed; rebuild required");
  assert.equal(current.outputHash,recorded.outputHash,"Emitted chunk/CSS/font/static output changed/missing/added; rebuild required");
  assert.equal(current.sourceHead,recorded.sourceHead,"Candidate source changed; rebuild required");
  return current;
}
