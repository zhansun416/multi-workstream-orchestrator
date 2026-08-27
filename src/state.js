import { loadTaskDag, saveTaskDag, statuses } from "./loader.js";
import { TransitionError } from "./errors.js";

export const allowedTransitions = {
  draft: ["ready"], ready: ["assigned"], assigned: ["in_progress", "blocked"], in_progress: ["handoff", "blocked"],
  handoff: ["review"], review: ["done"], done: [], blocked: ["ready"],
};

export async function updateTaskStatus(root, taskId, newStatus, { blocker } = {}) {
  const dag = await loadTaskDag(root);
  const task = dag.byId.get(taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);
  if (!statuses.has(newStatus) || !allowedTransitions[task.status].includes(newStatus)) {
    throw new TransitionError(`Illegal transition for '${taskId}': ${task.status} -> ${newStatus}`);
  }
  if (newStatus === "blocked") {
    task.raw.blocked_from = task.status;
    if (blocker) task.raw.blocker = blocker;
  }
  task.status = newStatus;
  await saveTaskDag(dag);
  return task;
}
