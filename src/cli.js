#!/usr/bin/env node
import { buildManagerContext, buildReviewerContext, buildWorkerContext } from "./context.js";
import { RuntimeError } from "./errors.js";
import { loadTaskDag } from "./loader.js";
import { buildExecutionWave, getReadyTasks, getTaskStatus } from "./scheduler.js";
import { updateTaskStatus } from "./state.js";
import { validateHandoff } from "./handoff.js";
import { readFile } from "node:fs/promises";
import { inspectCoordination, recoveryReport } from "./doctor.js";
import { auditGit } from "./provenance.js";

try {
  const [root, args] = parseGlobal(process.argv.slice(2));
  const result = await run(root, args);
  console.log(JSON.stringify(result, null, 2));
  if (result.valid === false) process.exitCode = 1;
} catch (error) { console.error(`error: ${error.message}`); process.exitCode = 2; }

async function run(projectRoot, argv) {
  const [command, ...rest] = argv;
  if (!command) throw new RuntimeError("Usage: mso-runtime [--root PATH] status|ready|wave|task|context|check|recover|audit|handoff|transition");
  const dag = await loadTaskDag(projectRoot);
  if (command === "check") return inspectCoordination(dag);
  if (command === "recover") return recoveryReport(dag);
  if (command === "audit") {
    const task = dag.byId.get(rest[0]), worktree = option(rest.slice(1), "--worktree");
    if (!task || !worktree) throw new RuntimeError("Usage: audit <task-id> --worktree <actual-checkout>");
    return auditGit(dag.root, task, worktree);
  }
  if (command === "status") return { tasks: dag.tasks.map((task) => getTaskStatus(dag, task.id)) };
  if (command === "ready") return { ready: getReadyTasks(dag).map((task) => task.raw) };
  if (command === "wave") return { wave: buildExecutionWave(dag).map((task) => task.raw) };
  if (command === "task") { const task = dag.byId.get(rest[0]); if (!task) throw new Error(`Unknown task id: ${rest[0]}`); return { task: task.raw, derived_status: getTaskStatus(dag, task.id) }; }
  if (command === "context") { if (rest[0] === "manager") return buildManagerContext(projectRoot); if (rest[0] === "worker") return buildWorkerContext(projectRoot, rest[1]); if (rest[0] === "reviewer") return buildReviewerContext(projectRoot, rest[1]); throw new Error("Usage: context manager|worker <task-id>|reviewer <task-id>"); }
  if (command === "handoff" && rest[0] === "validate") { const task = dag.byId.get(rest[1]); if (!task) throw new Error(`Unknown task id: ${rest[1]}`); return validateHandoff(dag.root, task); }
  if (command === "transition") {
    const options = rest.slice(2), recordFile = option(options, "--record");
    const task = await updateTaskStatus(projectRoot, rest[0], rest[1], {
      blocker: option(options, "--blocker"), reason: option(options, "--reason"), expectedRevision: option(options, "--expect-revision"),
      record: recordFile ? JSON.parse(await readFile(recordFile,"utf8")) : undefined,
    });
    return { task: { ...task.raw, status: task.status } };
  }
  throw new Error(`Unknown command: ${command}`);
}
function parseGlobal(argv) {
  let root = ".";
  const remaining = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root") {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new RuntimeError("--root needs a value");
      root = argv[++index];
    } else if (argv[index] !== "--json") remaining.push(argv[index]);
  }
  return [root, remaining];
}
function option(argv, name) { const index = argv.indexOf(name); if (index < 0) return undefined; if (!argv[index+1] || argv[index+1].startsWith("--")) throw new RuntimeError(`${name} needs a value`); return argv[index+1]; }
