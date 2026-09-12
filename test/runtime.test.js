import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import YAML from "yaml";
import { buildManagerContext, buildWorkerContext, buildReviewerContext } from "../src/context.js";
import { checkConflicts, pathsMayOverlap } from "../src/conflicts.js";
import { DependencyError, RevisionConflictError, TransitionError } from "../src/errors.js";
import { validateHandoff } from "../src/handoff.js";
import { loadTaskDag, saveTaskDag } from "../src/loader.js";
import { analyzeExecutionWave, buildExecutionWave, getAssignmentEligibility, getReadyTasks, getTaskStatus } from "../src/scheduler.js";
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

test("active work occupies paths and owners through review, while independent work remains assignable", async () => {
  const root = await copiedFixture();
  await updateTaskStatus(root, "backend-01", "assigned");
  let dag = await loadTaskDag(root);
  const analysis = analyzeExecutionWave(dag);
  assert.deepEqual(analysis.wave.map((task) => task.id), ["docs-01"]);
  assert.ok(analysis.excluded.find((item) => item.task_id === "backend-admin-01")?.reasons.some((reason) => reason.startsWith("active_conflict:backend-01")));
  await assert.rejects(
    () => updateTaskStatus(root, "backend-admin-01", "assigned"),
    (error) => error.code === "TASK_NOT_ELIGIBLE",
  );
  await updateTaskStatus(root, "docs-01", "assigned");
  dag = await loadTaskDag(root);
  assert.equal(dag.byId.get("docs-01").status, "assigned");

  await updateTaskStatus(root, "backend-01", "in_progress");
  await updateTaskStatus(root, "backend-01", "handoff");
  await updateTaskStatus(root, "backend-01", "review");
  dag = await loadTaskDag(root);
  assert.ok(getAssignmentEligibility(dag, "backend-admin-01").reasons.some((reason) => reason.startsWith("active_conflict:backend-01")));
});

test("owner registration, module scope, task ids, and supported path syntax are enforced", async () => {
  const unknownOwner = await copiedFixture();
  const unknownFile = path.join(unknownOwner, "docs", "coordination", "task-dag.yaml");
  await writeFile(unknownFile, (await readFile(unknownFile, "utf8")).replace("owner: backend", "owner: misspelled"));
  await assert.rejects(() => loadTaskDag(unknownOwner), (error) => error.code === "OWNER_NOT_REGISTERED");

  const expanded = await copiedFixture();
  const expandedFile = path.join(expanded, "docs", "coordination", "task-dag.yaml");
  await writeFile(expandedFile, (await readFile(expandedFile, "utf8")).replace("      - packages/backend/**", "      - packages/frontend/**"));
  await assert.rejects(() => loadTaskDag(expanded), (error) => error.code === "TASK_SCOPE_OUTSIDE_MODULE");

  const glob = await copiedFixture();
  const globFile = path.join(glob, "docs", "coordination", "task-dag.yaml");
  await writeFile(globFile, (await readFile(globFile, "utf8")).replace("packages/backend/**", "packages/**/api/*.js"));
  await assert.rejects(() => loadTaskDag(glob), (error) => error.code === "PATH_GLOB_UNSUPPORTED");

  for (const unsafe of ["../STATE", "nested/task", "nested\\task", "task..other"]) {
    const unsafeRoot = await copiedFixture();
    const unsafeFile = path.join(unsafeRoot, "docs", "coordination", "task-dag.yaml");
    await writeFile(unsafeFile, (await readFile(unsafeFile, "utf8")).replace("id: backend-01", `id: ${JSON.stringify(unsafe)}`));
    await assert.rejects(() => loadTaskDag(unsafeRoot), (error) => error.code === "TASK_ID_INVALID");
  }

  const manager = await copiedFixture();
  const managerFile = path.join(manager, "docs", "coordination", "task-dag.yaml");
  await writeFile(managerFile, (await readFile(managerFile, "utf8"))
    .replace("owner: backend", "owner: manager\n    owner_type: manager")
    .replace("      - packages/backend/**", "      - docs/coordination/task-dag.yaml"));
  assert.equal((await loadTaskDag(manager)).byId.get("backend-01").owner_type, "manager");
});

test("protected files stay excluded from broad documentation scope while own coordination output remains writable", async () => {
  const root = await copiedFixture();
  const dag = await loadTaskDag(root);
  const task = dag.byId.get("docs-01");
  const handoff = path.join(root, "docs", "coordination", "handoffs", "docs-01.md");
  const handoffText = (changedFile) => `# Handoff: docs-01

## Result

Updated documentation.

## Changed files

- ${changedFile}

## Contract impact

None.

## Validation performed

Manual documentation review.

## Evidence locations

- manual: Reviewed the rendered text.

## Known limits / risks

None.

## Suggested next action

Review.
`;
  await writeFile(handoff, handoffText("docs/coordination/STATE.md"));
  let validation = await validateHandoff(root, task);
  assert.ok(validation.error_details.some((item) => item.code === "CHANGED_FILE_PROTECTED"));
  await writeFile(handoff, handoffText("docs/coordination/handoffs/docs-01.md"));
  validation = await validateHandoff(root, task);
  assert.equal(validation.valid, true);
});

test("snapshot saves reject stale revisions and same-revision manual edits", async () => {
  const root = await copiedFixture();
  const first = await loadTaskDag(root);
  const stale = await loadTaskDag(root);
  first.byId.get("backend-01").status = "assigned";
  await saveTaskDag(first);
  stale.byId.get("docs-01").status = "assigned";
  await assert.rejects(() => saveTaskDag(stale), RevisionConflictError);

  const manuallyStale = await loadTaskDag(root);
  const file = path.join(root, "docs", "coordination", "task-dag.yaml");
  await writeFile(file, `${await readFile(file, "utf8")}\n`);
  manuallyStale.byId.get("docs-01").status = "assigned";
  await assert.rejects(
    () => saveTaskDag(manuallyStale),
    (error) => error.code === "REVISION_CONFLICT" && error.details.content_changed === true,
  );
});

test("required contract diagnostics survive budget pressure and block assignment", async () => {
  const root = await copiedFixture();
  const file = path.join(root, "docs", "coordination", "task-dag.yaml");
  const data = YAML.parse(await readFile(file, "utf8"));
  data.tasks.find((task) => task.id === "frontend-01").inputs = ["BackendApi@v9"];
  await writeFile(file, YAML.stringify(data));
  const context = await buildWorkerContext(root, "frontend-01", 20);
  assert.match(context.context, /Required contract BackendApi@v9/);
  assert.match(context.context, /Dispatch is blocked/);
  assert.ok(context.warnings.some((warning) => /version is not registered/i.test(warning)));
  await assert.rejects(
    () => updateTaskStatus(root, "frontend-01", "assigned"),
    (error) => error.code === "TASK_NOT_ELIGIBLE" && error.details.reasons.some((reason) => reason.startsWith("contract_version_not_registered")),
  );

  const missingFileRoot = await copiedFixture();
  const runtimeFile = path.join(missingFileRoot, "docs", "coordination", "runtime.yaml");
  await writeFile(runtimeFile, (await readFile(runtimeFile, "utf8")).replace("docs/contracts/backend-api.md", "docs/contracts/missing.md"));
  const missingContext = await buildWorkerContext(missingFileRoot, "backend-01");
  assert.ok(missingContext.warnings.some((warning) => /does not exist/i.test(warning)));
});

test("CLI returns stable JSON errors and nonzero status for invalid handoffs", async () => {
  const root = await copiedFixture();
  await writeFile(path.join(root, "docs", "coordination", "handoffs", "backend-01.md"), "# Handoff: backend-01\n\n## Result\n\nIncomplete\n");
  let failure;
  try {
    await exec(process.execPath, ["src/cli.js", "--root", root, "handoff", "validate", "backend-01"], { cwd: path.resolve(".") });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, 1);
  const output = JSON.parse(failure.stdout);
  assert.equal(output.valid, false);
  assert.equal(output.error.code, "HANDOFF_INVALID");
  assert.ok(output.error.details.every((item) => typeof item.code === "string"));
});

test("concurrent CLI transitions preserve independent updates and admit only one conflicting writer", async () => {
  const independentRoot = await copiedFixture();
  const independent = await Promise.allSettled([
    exec(process.execPath, ["src/cli.js", "--root", independentRoot, "transition", "backend-01", "assigned"], { cwd: path.resolve(".") }),
    exec(process.execPath, ["src/cli.js", "--root", independentRoot, "transition", "docs-01", "assigned"], { cwd: path.resolve(".") }),
  ]);
  assert.equal(independent.filter((item) => item.status === "fulfilled").length, 2);
  let dag = await loadTaskDag(independentRoot);
  assert.equal(dag.byId.get("backend-01").status, "assigned");
  assert.equal(dag.byId.get("docs-01").status, "assigned");

  const conflictRoot = await copiedFixture();
  const conflicting = await Promise.allSettled([
    exec(process.execPath, ["src/cli.js", "--root", conflictRoot, "transition", "backend-01", "assigned"], { cwd: path.resolve(".") }),
    exec(process.execPath, ["src/cli.js", "--root", conflictRoot, "transition", "backend-admin-01", "assigned"], { cwd: path.resolve(".") }),
  ]);
  assert.equal(conflicting.filter((item) => item.status === "fulfilled").length, 1);
  dag = await loadTaskDag(conflictRoot);
  assert.equal([dag.byId.get("backend-01"), dag.byId.get("backend-admin-01")].filter((task) => task.status === "assigned").length, 1);
});

test("rework increments attempt and supersedes old evidence for non-code tasks", async () => {
  const root = await copiedFixture();
  await updateTaskStatus(root, "backend-01", "assigned");
  await updateTaskStatus(root, "backend-01", "in_progress");
  await updateTaskStatus(root, "backend-01", "handoff");
  await updateTaskStatus(root, "backend-01", "review");
  await assert.rejects(
    () => updateTaskStatus(root, "backend-01", "in_progress"),
    (error) => error.code === "REWORK_REASON_REQUIRED",
  );
  await updateTaskStatus(root, "backend-01", "in_progress", { reason: "Acceptance case failed." });
  let dag = await loadTaskDag(root);
  assert.equal(dag.byId.get("backend-01").attempt, 2);
  assert.equal(dag.byId.get("backend-01").raw.evidence_status, "superseded");
  await updateTaskStatus(root, "backend-01", "handoff");
  await assert.rejects(
    () => updateTaskStatus(root, "backend-01", "review"),
    (error) => error.code === "HANDOFF_INVALID",
  );

  const handoff = path.join(root, "docs", "coordination", "handoffs", "backend-01.md");
  await writeFile(handoff, `${await readFile(handoff, "utf8")}\n## Delivery identity\n\n- attempt: 2\n`);
  await updateTaskStatus(root, "backend-01", "review");
  await updateTaskStatus(root, "backend-01", "done");
  dag = await loadTaskDag(root);
  assert.equal(dag.byId.get("backend-01").status, "done");
  assert.equal(dag.byId.get("backend-01").raw.evidence_status, "current");
});

test("code delivery and integration evidence bind to immutable commits", async () => {
  const root = await copiedFixture();
  const dagFile = path.join(root, "docs", "coordination", "task-dag.yaml");
  await writeFile(dagFile, (await readFile(dagFile, "utf8")).replace(
    "    handoff_required: true",
    "    handoff_required: true\n    delivery:\n      kind: code",
  ));
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const integrated = "c".repeat(40);
  const handoff = path.join(root, "docs", "coordination", "handoffs", "backend-01.md");
  const original = await readFile(handoff, "utf8");
  const structured = `${original}\n## Delivery identity\n\n- attempt: 1\n- base_commit: ${base}\n- head_commit: ${head}\n- worktree: ${root}\n`;
  await writeFile(handoff, structured.replace(
    "Ran the backend test suite.",
    `- command: npm test\n- working_directory: ${root}\n- exit_code: 0\n- head_commit: ${head}`,
  ));
  await updateTaskStatus(root, "backend-01", "assigned");
  await updateTaskStatus(root, "backend-01", "in_progress");
  await updateTaskStatus(root, "backend-01", "handoff");
  await updateTaskStatus(root, "backend-01", "review");
  await assert.rejects(
    () => updateTaskStatus(root, "backend-01", "done", {
      integrationCommit: "HEAD",
      verificationCommit: "HEAD",
      integrationVerification: "npm test passed",
    }),
    (error) => error.code === "INTEGRATION_COMMIT_INVALID",
  );
  await assert.rejects(
    () => updateTaskStatus(root, "backend-01", "done", {
      integrationCommit: integrated,
      verificationCommit: "d".repeat(40),
      integrationVerification: "npm test passed",
    }),
    (error) => error.code === "INTEGRATION_VERSION_MISMATCH",
  );
  await updateTaskStatus(root, "backend-01", "done", {
    integrationCommit: integrated,
    verificationCommit: integrated,
    integrationVerification: "npm test passed in the integration worktree",
  });
  const dag = await loadTaskDag(root);
  assert.equal(dag.byId.get("backend-01").raw.delivery_record.head_commit, head);
  assert.equal(dag.byId.get("backend-01").raw.integration_record.verification_commit, integrated);
});
