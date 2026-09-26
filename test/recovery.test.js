import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import YAML from "yaml";
import { loadTaskDag, saveTaskDag, normalizeRelativePath } from "../src/loader.js";
import { buildExecutionWave } from "../src/scheduler.js";
import { updateTaskStatus } from "../src/state.js";
import { inspectCoordination, recoveryReport } from "../src/doctor.js";
import { validateRecord, auditGit } from "../src/provenance.js";
import { buildWorkerContext } from "../src/context.js";

const exec=promisify(execFile), cli=path.resolve("src/cli.js");
async function fixture(t,strict=false) {
  const root=await mkdtemp(path.join(os.tmpdir(),"mso-v2-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await cp(path.resolve("tests/fixtures/sample_project"),root,{recursive:true});
  if (strict) {
    const dag=await loadTaskDag(root);
    dag.data.require_provenance=true;
    dag.tasks=dag.tasks.filter(x=>x.id==="backend-01");
    await saveTaskDag(dag);
  }
  return root;
}
const assignment=(root, overrides={})=>({task_id:"backend-01",task_revision:1,dispatch_id:crypto.randomUUID(),thread_id:"worker-1",worktree:root,base_commit:"a".repeat(40),contracts:["BackendApi@v1"],assigned_at:new Date().toISOString(),...overrides});
async function evidence(root,a,overrides={}) {
  const dir=path.join(root,"docs/coordination/evidence/backend-01");await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,"tests.log"),"fixture observation: passed\n");
  const record={task_id:a.task_id,task_revision:1,dispatch_id:a.dispatch_id,base_commit:a.base_commit,head_commit:"b".repeat(40),checks:[{requirement:"Run backend test suite.",kind:"command",command:"npm test",cwd:root,commit:"b".repeat(40),result:"passed",exit_code:0,evidence:"docs/coordination/evidence/backend-01/tests.log"}],...overrides};
  await writeFile(path.join(dir,"handoff.json"),JSON.stringify(record));return record;
}

test("running task reserves scope; direct assignment cannot bypass dependencies/conflicts",async t=>{
  const root=await fixture(t);
  await assert.rejects(()=>updateTaskStatus(root,"frontend-01","assigned"),/Dependencies/);
  await updateTaskStatus(root,"backend-01","assigned");
  assert.deepEqual(buildExecutionWave(await loadTaskDag(root)).map(t=>t.id),["docs-01"]);
  await assert.rejects(()=>updateTaskStatus(root,"backend-admin-01","assigned"),/Active task conflict/);
});
test("resource conflicts and capacity apply to running and proposed waves",async t=>{
  const root=await fixture(t);let dag=await loadTaskDag(root);
  dag.byId.get("backend-01").raw.resources=["port:8080"];dag.byId.get("docs-01").raw.resources=["port:8080"];
  await saveTaskDag(dag);dag=await loadTaskDag(root);
  assert.deepEqual(buildExecutionWave(dag).map(t=>t.id),["backend-01"]);
  dag.data.max_concurrent=1;await saveTaskDag(dag);
  await updateTaskStatus(root,"backend-01","assigned");
  assert.deepEqual(buildExecutionWave(await loadTaskDag(root)),[]);
  await assert.rejects(()=>updateTaskStatus(root,"docs-01","assigned"),/Concurrency/);
});
test("stale snapshots and locks fail without losing another writer's state",async t=>{
  const root=await fixture(t);const a=await loadTaskDag(root),b=await loadTaskDag(root);
  a.byId.get("backend-01").status="assigned";await saveTaskDag(a);
  b.byId.get("docs-01").status="assigned";
  await assert.rejects(()=>saveTaskDag(b),/Stale task snapshot/);
  assert.equal((await loadTaskDag(root)).byId.get("backend-01").status,"assigned");
  const current=await loadTaskDag(root);await writeFile(current.file+".lock","live-writer");
  await assert.rejects(()=>saveTaskDag(current),/writer locked/);
  assert.equal(await readFile(current.file+".lock","utf8"),"live-writer");
});
test("blocking retains reservations; recovery is read-only; resolution requires a reason",async t=>{
  const root=await fixture(t);await updateTaskStatus(root,"backend-01","assigned");
  await assert.rejects(()=>updateTaskStatus(root,"backend-01","blocked"),/Blocker reason/);
  await updateTaskStatus(root,"backend-01","blocked",{blocker:"Need API decision"});
  const dag=await loadTaskDag(root),before=await readFile(dag.file,"utf8");
  const report=await recoveryReport(dag);assert.equal(report.tasks[0].task_id,"backend-01");
  assert.equal(await readFile(dag.file,"utf8"),before);
  await assert.rejects(()=>updateTaskStatus(root,"backend-01","ready"),/reason required/);
  await updateTaskStatus(root,"backend-01","ready",{reason:"Decision recorded; old writer stopped"});
});
test("provenance gates reject missing/stale assignments and expose correct Worker checkout",async t=>{
  const root=await fixture(t,true);
  await assert.rejects(()=>updateTaskStatus(root,"backend-01","assigned"),/record required/);
  await assert.rejects(()=>updateTaskStatus(root,"backend-01","assigned",{record:assignment(root,{task_revision:2})}),/revision mismatch/);
  await assert.rejects(()=>updateTaskStatus(root,"backend-01","assigned",{expectedRevision:2,record:assignment(root)}),/revision changed/);
  const a=assignment(path.join(root,"worker"));await updateTaskStatus(root,"backend-01","assigned",{record:a});
  const context=await buildWorkerContext(root,"backend-01");assert.ok(context.context.includes(a.worktree));assert.ok(context.context.includes(a.dispatch_id));
});
test("handoff and integrated acceptance bind task, dispatch, tested commits and evidence",async t=>{
  const root=await fixture(t,true),a=assignment(root);await updateTaskStatus(root,"backend-01","assigned",{record:a});
  await updateTaskStatus(root,"backend-01","in_progress");await updateTaskStatus(root,"backend-01","handoff");
  let proof=await evidence(root,a,{task_revision:2});
  await assert.rejects(()=>updateTaskStatus(root,"backend-01","review"),/Stale/);
  proof=await evidence(root,a);await updateTaskStatus(root,"backend-01","review");
  await assert.rejects(()=>updateTaskStatus(root,"backend-01","done"),/Evidence|Acceptance|Stale/);
  const accepted={...proof,integration_commit:"c".repeat(40),reviewed_by:"Manager",review_notes:"Integration fixture observed",acceptance:[{criterion:"Endpoint responds successfully.",result:"passed",evidence:proof.checks[0].evidence}]};
  await assert.rejects(()=>updateTaskStatus(root,"backend-01","done",{record:accepted}),/stale/);
  accepted.checks=proof.checks.map(c=>({...c,commit:accepted.integration_commit}));
  await updateTaskStatus(root,"backend-01","done",{record:accepted});
  assert.equal((await loadTaskDag(root)).byId.get("backend-01").status,"done");
});
test("review repair invalidates rejected commit; redispatch IDs cannot be reused",async t=>{
  const root=await fixture(t,true),a=assignment(root);await updateTaskStatus(root,"backend-01","assigned",{record:a});
  await evidence(root,a);await updateTaskStatus(root,"backend-01","in_progress");await updateTaskStatus(root,"backend-01","handoff");await updateTaskStatus(root,"backend-01","review");
  await updateTaskStatus(root,"backend-01","in_progress",{reason:"Repair broken response"});await updateTaskStatus(root,"backend-01","handoff");
  await assert.rejects(()=>updateTaskStatus(root,"backend-01","review"),/superseded/);
  await updateTaskStatus(root,"backend-01","blocked",{blocker:"Need reassignment"});await updateTaskStatus(root,"backend-01","ready",{reason:"Old Worker stopped"});
  await assert.rejects(()=>updateTaskStatus(root,"backend-01","assigned",{record:a}),/already used/);
});
test("cancelled dependency does not become satisfied",async t=>{
  const root=await fixture(t);await updateTaskStatus(root,"backend-01","cancelled",{reason:"User changed goal"});
  await assert.rejects(()=>updateTaskStatus(root,"frontend-01","assigned"),/Dependencies/);
});
test("malformed paths/scopes fail; doctor detects unregistered module and broad coordination writes",async t=>{
  for(const p of ["C:/secret","C:relative","../escape","/abs","."]) assert.throws(()=>normalizeRelativePath(p));
  const root=await fixture(t);let dag=await loadTaskDag(root);
  dag.byId.get("backend-admin-01").owner="unregistered-admin";
  dag.byId.get("docs-01").allowed_paths=["docs/**"];
  const result=await inspectCoordination(dag);
  assert.ok(result.errors.some(e=>e.includes("unregistered owner unregistered-admin")));
  assert.ok(result.errors.some(e=>e.includes("coordination writes")));
  dag.byId.get("backend-01").raw.allowed_paths=["packages/*/api/**"];await saveTaskDag(dag);
  await assert.rejects(()=>loadTaskDag(root),/Unsupported scope/);
});
test("failed handoff CLI returns nonzero rather than a success exit",async t=>{
  const root=await fixture(t);await writeFile(path.join(root,"docs/coordination/handoffs/backend-01.md"),"incomplete");
  await assert.rejects(()=>exec(process.execPath,[cli,"--root",root,"handoff","validate","backend-01"]),e=>e.code===1);
});

test("disjoint scopes still cannot share a Worker or actual checkout",async t=>{
  const root=await fixture(t),a=assignment(root);
  await updateTaskStatus(root,"backend-01","assigned",{record:a});
  const docs=assignment(path.join(root,"docs-worker"),{task_id:"docs-01",contracts:[]});
  await assert.rejects(()=>updateTaskStatus(root,"docs-01","assigned",{record:docs}),/same_worker/);
  docs.thread_id="worker-2";docs.worktree=path.join(root,"sub","..");
  await assert.rejects(()=>updateTaskStatus(root,"docs-01","assigned",{record:docs}),/same_worktree/);
  assert.equal((await loadTaskDag(root)).byId.get("docs-01").status,"ready");
});

test("null evidence entries fail validation without crashing",async t=>{
  const root=await fixture(t,true),a=assignment(root);
  await updateTaskStatus(root,"backend-01","assigned",{record:a});
  const task=(await loadTaskDag(root)).byId.get("backend-01");
  const proof=await evidence(root,a,{checks:[null]});
  assert.equal((await validateRecord(root,task,proof)).valid,false);
  assert.equal((await validateRecord(root,task,{...proof,acceptance:[null]},"integration")).valid,false);
});

test("CLI rejects an empty root option with documented exit code",async()=>{
  await assert.rejects(()=>exec(process.execPath,[cli,"status","--root"]),e=>e.code===2 && e.stderr.includes("--root needs a value"));
});
test("Git audit finds undeclared changes even when narrative omits them",async t=>{
  const root=await fixture(t,true),git=async(...args)=>(await exec("git",["-C",root,...args])).stdout.trim();
  await git("init");await git("config","user.name","MSO test");await git("config","user.email","test@example.invalid");
  await git("add",".");await git("commit","-m","fixture base");const base=await git("rev-parse","HEAD");
  await mkdir(path.join(root,"packages/frontend"),{recursive:true});await writeFile(path.join(root,"packages/frontend/unauthorized.js"),"// outside task scope\n");
  await git("add",".");await git("commit","-m","out of scope change");const head=await git("rev-parse","HEAD");
  const a=assignment(root,{base_commit:base});await updateTaskStatus(root,"backend-01","assigned",{record:a});
  const proof=await evidence(root,a,{head_commit:head});proof.checks[0].commit=head;
  await writeFile(path.join(root,"docs/coordination/evidence/backend-01/handoff.json"),JSON.stringify(proof));
  const report=await auditGit(root,(await loadTaskDag(root)).byId.get("backend-01"),root);
  assert.equal(report.valid,false);assert.ok(report.errors.some(e=>e.includes("unauthorized.js")));
});
