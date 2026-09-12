#!/usr/bin/env node
import { buildManagerContext, buildReviewerContext, buildWorkerContext } from "./context.js";
import { RuntimeError } from "./errors.js";
import { loadTaskDag } from "./loader.js";
import { analyzeExecutionWave, getAssignmentEligibility, getReadyTasks, getTaskStatus } from "./scheduler.js";
import { updateTaskStatus } from "./state.js";
import { validateHandoff } from "./handoff.js";

try {
  const [root, args] = parseGlobal(process.argv.slice(2));
  const output = await run(root, args);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (output?.valid === false) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: serializeError(error) }, null, 2)}\n`);
  process.exitCode = 2;
}

async function run(projectRoot, argv) {
  const [command, ...rest] = argv;
  if (!command) throw new RuntimeError("Usage: mso-runtime [--root PATH] [--json] status|ready|wave|task|context|handoff|transition", { code: "USAGE_ERROR" });
  const dag = await loadTaskDag(projectRoot);
  if (command === "status") return { tasks: dag.tasks.map((task) => getTaskStatus(dag, task.id)) };
  if (command === "ready") {
    const ready = getReadyTasks(dag);
    const readyIds = new Set(ready.map((task) => task.id));
    const excluded = dag.tasks
      .filter((task) => task.status === "ready" && !readyIds.has(task.id))
      .map((task) => ({ task_id: task.id, reasons: getAssignmentEligibility(dag, task).reasons }));
    return { ready: ready.map((task) => task.raw), excluded };
  }
  if (command === "wave") {
    const wave = analyzeExecutionWave(dag);
    return { wave: wave.wave.map((task) => task.raw), excluded: wave.excluded };
  }
  if (command === "task") {
    const task = requireTask(dag, rest[0]);
    return { task: task.raw, derived_status: getTaskStatus(dag, task.id), assignment: getAssignmentEligibility(dag, task) };
  }
  if (command === "context") {
    if (rest[0] === "manager") return buildManagerContext(projectRoot);
    if (rest[0] === "worker") return buildWorkerContext(projectRoot, rest[1]);
    if (rest[0] === "reviewer") return buildReviewerContext(projectRoot, rest[1]);
    throw new RuntimeError("Usage: context manager|worker <task-id>|reviewer <task-id>", { code: "USAGE_ERROR" });
  }
  if (command === "handoff" && rest[0] === "validate") return validateHandoff(dag.root, requireTask(dag, rest[1]));
  if (command === "transition") {
    if (!rest[0] || !rest[1]) throw new RuntimeError("Usage: transition <task-id> <status> [options]", { code: "USAGE_ERROR" });
    const task = await updateTaskStatus(projectRoot, rest[0], rest[1], {
      blocker: option(rest.slice(2), "--blocker"),
      reason: option(rest.slice(2), "--reason"),
      integrationCommit: option(rest.slice(2), "--integration-commit"),
      verificationCommit: option(rest.slice(2), "--verification-commit"),
      integrationVerification: option(rest.slice(2), "--integration-verification"),
      validationEvidence: option(rest.slice(2), "--validation-evidence"),
    });
    return { task: task.raw };
  }
  throw new RuntimeError(`Unknown command: ${command}`, { code: "UNKNOWN_COMMAND" });
}

function requireTask(dag, id) {
  const task = dag.byId.get(id);
  if (!task) throw new RuntimeError(`Unknown task id: ${id}`, { code: "TASK_NOT_FOUND", details: { task_id: id } });
  return task;
}

function parseGlobal(argv) {
  let root = ".";
  const remaining = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") {
      if (!argv[index + 1]) throw new RuntimeError("--root requires a path.", { code: "USAGE_ERROR" });
      root = argv[++index];
    } else if (argv[index] !== "--json") {
      remaining.push(argv[index]);
    }
  }
  return [root, remaining];
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function serializeError(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details !== undefined ? { details: error.details } : {}),
  };
}
