import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { buildManagerContext, buildWorkerContext, buildReviewerContext } from "../src/context.js";
import { checkConflicts, pathsMayOverlap } from "../src/conflicts.js";
import { DependencyError, TransitionError } from "../src/errors.js";
import { validateHandoff } from "../src/handoff.js";
import { loadTaskDag } from "../src/loader.js";
import { buildExecutionWave, getReadyTasks, getTaskStatus } from "../src/scheduler.js";
import { updateTaskStatus } from "../src/state.js";

const fixture = path.resolve("tests", "fixtures", "sample_project");
const exec = promisify(execFile);

async function copiedFixture() {
  const root = await mkdir(path.join(os.tmpdir(), "mso-runtime-"), { recursive: true }).then(() => path.join(os.tmpdir(), `mso-runtime-${crypto.randomUUID()}`));
  await cp(fixture, root, { recursive: true });
  return root;
}

test("scheduler computes ready work, dependencies, and a safe wave", async () => {
  const root = await copiedFixture(); const dag = await loadTaskDag(root);
  assert.deepEqual(getReadyTasks(dag).map((task) => task.id), ["backend-01", "docs-01", "backend-admin-01"]);
  assert.equal(getTaskStatus(dag, "frontend-01").state, "blocked");
  assert.deepEqual(buildExecutionWave(dag).map((task) => task.id), ["backend-01", "docs-01"]);
});

test("conflicts cover parent-child paths, explicit conflicts, same owners, and independent paths", async () => {
  const root = await copiedFixture(); const dag = await loadTaskDag(root);
  assert.equal(pathsMayOverlap("packages/backend/**", "packages/backend/api/**"), true);
  assert.equal(pathsMayOverlap("packages/backend/**", "packages/frontend/**"), false);
  assert.ok(checkConflicts(dag.byId.get("backend-01"), dag.byId.get("backend-admin-01")).some((reason) => reason.startsWith("path_conflict")));
  const clone = { ...dag.byId.get("docs-01").raw, id: "docs-02", allowed_paths: ["guides/**"] };
  const sameOwner = { ...dag.byId.get("docs-01"), id: clone.id, allowed_paths: clone.allowed_paths, raw: clone };
  assert.ok(checkConflicts(dag.byId.get("docs-01"), sameOwner).includes("same_owner"));
  const explicit = { ...dag.byId.get("docs-01"), id: "explicit-01", owner: "independent", allowed_paths: ["guides/**"], conflicts_with: ["backend-01"], raw: { ...clone, id: "explicit-01", owner: "independent", conflicts_with: ["backend-01"] } };
  assert.ok(checkConflicts(dag.byId.get("backend-01"), explicit).includes("explicit_conflict"));
  const independent = { ...explicit, id: "independent-01", conflicts_with: [], raw: { ...explicit.raw, id: "independent-01", conflicts_with: [] } };
  assert.deepEqual(checkConflicts(dag.byId.get("backend-01"), independent), []);
});

test("invalid missing, duplicate, and cyclic dependencies fail explicitly", async () => {
  const root = await copiedFixture(); const file = path.join(root, "docs", "coordination", "task-dag.yaml");
  await writeFile(file, "tasks:\n  - id: a\n    owner: x\n    status: ready\n    depends_on: [missing]\n");
  await assert.rejects(() => loadTaskDag(root), DependencyError);
  await writeFile(file, "tasks:\n  - id: a\n    owner: x\n    status: ready\n    depends_on: [b]\n  - id: b\n    owner: x\n    status: ready\n    depends_on: [a]\n");
  await assert.rejects(() => loadTaskDag(root), /Cyclic dependency/);
  await writeFile(file, "tasks:\n  - id: a\n    owner: x\n    status: ready\n    depends_on: []\n  - id: a\n    owner: y\n    status: ready\n    depends_on: []\n");
  await assert.rejects(() => loadTaskDag(root), /Duplicate task id/);
  await writeFile(file, "tasks:\n  - id: a\n    owner: x\n    status: ready\n    depends_on: []\n    conflicts_with: [missing]\n");
  await assert.rejects(() => loadTaskDag(root), /conflicts with missing/);
  await writeFile(file, "tasks:\n  - id: a\n    owner: x\n    status: ready\n    depends_on: []\n    conflicts_with: [a]\n");
  await assert.rejects(() => loadTaskDag(root), /cannot conflict with itself/);
});

test("state transitions reject jumps and retain blocked provenance", async () => {
  const root = await copiedFixture();
  await assert.rejects(() => updateTaskStatus(root, "backend-01", "done"), TransitionError);
  await updateTaskStatus(root, "backend-01", "assigned");
  await updateTaskStatus(root, "backend-01", "in_progress");
  await updateTaskStatus(root, "backend-01", "blocked", { blocker: "fixture blocker" });
  let dag = await loadTaskDag(root); assert.equal(dag.byId.get("backend-01").raw.blocked_from, "in_progress");
  await updateTaskStatus(root, "backend-01", "ready");
  dag = await loadTaskDag(root); assert.equal(dag.byId.get("backend-01").raw.blocked_from, "in_progress"); assert.equal(dag.byId.get("backend-01").raw.blocker, undefined);
  await updateTaskStatus(root, "backend-01", "assigned"); await updateTaskStatus(root, "backend-01", "in_progress");
  await updateTaskStatus(root, "backend-01", "handoff"); await updateTaskStatus(root, "backend-01", "review"); await updateTaskStatus(root, "backend-01", "done");
  dag = await loadTaskDag(root); assert.equal(dag.byId.get("backend-01").status, "done");
});

test("handoff to review is gated only when the task requires a handoff", async () => {
  const invalidRoot = await copiedFixture();
  await updateTaskStatus(invalidRoot, "backend-01", "assigned"); await updateTaskStatus(invalidRoot, "backend-01", "in_progress"); await updateTaskStatus(invalidRoot, "backend-01", "handoff");
  const invalidHandoff = path.join(invalidRoot, "docs", "coordination", "handoffs", "backend-01.md");
  await writeFile(invalidHandoff, "# Handoff: backend-01\n\n## Result\n\nIncomplete\n");
  await assert.rejects(() => updateTaskStatus(invalidRoot, "backend-01", "review"), /Handoff validation failed/);

  const optionalRoot = await copiedFixture(); const dagFile = path.join(optionalRoot, "docs", "coordination", "task-dag.yaml");
  await writeFile(dagFile, (await readFile(dagFile, "utf8")).replace("handoff_required: true", "handoff_required: false"));
  await updateTaskStatus(optionalRoot, "backend-01", "assigned"); await updateTaskStatus(optionalRoot, "backend-01", "in_progress"); await updateTaskStatus(optionalRoot, "backend-01", "handoff");
  await writeFile(path.join(optionalRoot, "docs", "coordination", "handoffs", "backend-01.md"), "not a valid handoff");
  await updateTaskStatus(optionalRoot, "backend-01", "review");
  const dag = await loadTaskDag(optionalRoot); assert.equal(dag.byId.get("backend-01").status, "review");
});

test("handoff validation supports manual evidence and flags missing files and unauthorized changes", async () => {
  const root = await copiedFixture(); const dag = await loadTaskDag(root); const task = dag.byId.get("backend-01");
  let result = await validateHandoff(root, task); assert.equal(result.valid, true); assert.equal(result.evidence.declared, true); assert.equal(result.evidence.manual_verifications.length, 1);
  const handoff = path.join(root, "docs", "coordination", "handoffs", "backend-01.md");
  let text = await readFile(handoff, "utf8");
  await writeFile(handoff, text.replace("manual: Manager observed a passing backend test suite.", "evidence/missing.txt"));
  result = await validateHandoff(root, task); assert.ok(result.errors.some((error) => error.includes("Evidence file does not exist")));
  text = text.replace("packages/backend/api/endpoint.py", "packages/frontend/app.js"); await writeFile(handoff, text);
  result = await validateHandoff(root, task); assert.ok(result.errors.some((error) => error.includes("outside allowed_paths")));
  await writeFile(handoff, text.replace("## Result", "## Outcome"));
  result = await validateHandoff(root, task); assert.ok(result.errors.some((error) => error.includes("Result")));
  const noVerification = { ...task, verification: [], raw: { ...task.raw, verification: [] } };
  result = await validateHandoff(root, noVerification); assert.ok(result.errors.some((error) => error.includes("no verification")));
});

test("context is role-scoped, sources carry reasons, and critical fields survive budget pressure", async () => {
  const root = await copiedFixture();
  const worker = await buildWorkerContext(root, "frontend-01");
  assert.match(worker.context, /Task: frontend-01/); assert.doesNotMatch(worker.context, /docs-01/);
  assert.ok(worker.included_sources.some((source) => source.reasons.includes("current_task")));
  assert.ok(worker.included_sources.some((source) => source.reasons.includes("direct_dependency")));
  const constrained = await buildWorkerContext(root, "frontend-01", 20);
  assert.match(constrained.context, /Allowed paths:/); assert.match(constrained.context, /Acceptance:/); assert.ok(constrained.warnings.some((warning) => /budget exceeded/i.test(warning)));
  const reviewer = await buildReviewerContext(root, "backend-01"); assert.match(reviewer.context, /Handoff: backend-01/);
  const manager = await buildManagerContext(root); assert.doesNotMatch(manager.context, /Implemented the backend endpoint/);
});

test("CLI emits status JSON", async () => {
  const root = await copiedFixture();
  const { stdout } = await exec(process.execPath, ["src/cli.js", "--root", root, "status"], { cwd: path.resolve(".") });
  const output = JSON.parse(stdout); assert.equal(output.tasks.length, 4);
});
