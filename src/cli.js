#!/usr/bin/env node
import { buildManagerContext, buildReviewerContext, buildWorkerContext } from "./context.js";
import { RuntimeError } from "./errors.js";
import { loadTaskDag } from "./loader.js";
import { buildExecutionWave, getReadyTasks, getTaskStatus } from "./scheduler.js";
import { updateTaskStatus } from "./state.js";
import { validateHandoff } from "./handoff.js";

const [root, asJson, args] = parseGlobal(process.argv.slice(2));
try { console.log(JSON.stringify(await run(root, args), null, 2)); } catch (error) { console.error(`error: ${error.message}`); process.exitCode = 2; }

async function run(projectRoot, argv) {
  const [command, ...rest] = argv;
  if (!command) throw new RuntimeError("Usage: mso-runtime [--root PATH] [--json] status|ready|wave|task|context|handoff|transition");
  const dag = await loadTaskDag(projectRoot);
  if (command === "status") return { tasks: dag.tasks.map((task) => getTaskStatus(dag, task.id)) };
  if (command === "ready") return { ready: getReadyTasks(dag).map((task) => task.raw) };
  if (command === "wave") return { wave: buildExecutionWave(dag).map((task) => task.raw) };
  if (command === "task") { const task = dag.byId.get(rest[0]); if (!task) throw new Error(`Unknown task id: ${rest[0]}`); return { task: task.raw, derived_status: getTaskStatus(dag, task.id) }; }
  if (command === "context") { if (rest[0] === "manager") return buildManagerContext(projectRoot); if (rest[0] === "worker") return buildWorkerContext(projectRoot, rest[1]); if (rest[0] === "reviewer") return buildReviewerContext(projectRoot, rest[1]); throw new Error("Usage: context manager|worker <task-id>|reviewer <task-id>"); }
  if (command === "handoff" && rest[0] === "validate") { const task = dag.byId.get(rest[1]); if (!task) throw new Error(`Unknown task id: ${rest[1]}`); return validateHandoff(dag.root, task); }
  if (command === "transition") { const task = await updateTaskStatus(projectRoot, rest[0], rest[1], { blocker: option(rest.slice(2), "--blocker") }); return { task: task.raw }; }
  throw new Error(`Unknown command: ${command}`);
}
function parseGlobal(argv) { let root = "."; let asJson = false; const remaining = []; for (let index = 0; index < argv.length; index += 1) { if (argv[index] === "--root") root = argv[++index]; else if (argv[index] === "--json") asJson = true; else remaining.push(argv[index]); } return [root, asJson, remaining]; }
function option(argv, name) { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; }
