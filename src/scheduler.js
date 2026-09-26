import { checkConflicts } from "./conflicts.js";

export function getTaskStatus(dag, taskId) {
  const task = dag.byId.get(taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);
  if (task.status === "done") return { task_id: taskId, state: "done", reasons: [] };
  if (task.status === "cancelled") return { task_id: taskId, state: "cancelled", reasons: [] };
  if (task.status === "blocked") return { task_id: taskId, state: "blocked", reasons: task.raw.blocker ? [String(task.raw.blocker)] : [] };
  if (["assigned", "in_progress"].includes(task.status)) return { task_id: taskId, state: "running", reasons: [] };
  if (["handoff", "review"].includes(task.status)) return { task_id: taskId, state: "review_required", reasons: [] };
  if (task.status === "draft") return { task_id: taskId, state: "waiting", reasons: ["manager_approval_required"] };
  const unmet = task.depends_on.filter((id) => dag.byId.get(id).status !== "done");
  return unmet.length ? { task_id: taskId, state: "blocked", reasons: unmet.map((id) => `dependency_not_done:${id}`) } : { task_id: taskId, state: "ready", reasons: [] };
}

export const reservations = (dag) => dag.tasks.filter((task) => ["assigned", "in_progress", "handoff", "review", "blocked"].includes(task.status));
export function dispatchConflicts(dag, candidate) {
  return reservations(dag).filter(t => t.id !== candidate.id).flatMap(t => {
    const conflicts = checkConflicts(candidate, t);
    if (!candidate.parallel || !t.parallel) conflicts.push("serial_task");
    return conflicts.map(reason => `${t.id}:${reason}`);
  });
}
export const getReadyTasks = (dag) => dag.tasks.filter((task) => getTaskStatus(dag, task.id).state === "ready" && !dispatchConflicts(dag, task).length);
export const getBlockedTasks = (dag) => dag.tasks.map((task) => getTaskStatus(dag, task.id)).filter((status) => status.state === "blocked");

export function buildExecutionWave(dag) {
  const wave = [];
  for (const candidate of getReadyTasks(dag)) {
    if (wave.length + reservations(dag).length >= (dag.data.max_concurrent ?? 3)) break;
    if (!wave.length) { wave.push(candidate); continue; }
    if (!candidate.parallel || wave.some((task) => !task.parallel)) continue;
    if (wave.some((task) => checkConflicts(candidate, task).length)) continue;
    wave.push(candidate);
  }
  return wave;
}
