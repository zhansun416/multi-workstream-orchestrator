import { loadTaskDag, saveTaskDag, statuses } from "./loader.js";
import { TransitionError } from "./errors.js";
import { validateHandoff } from "./handoff.js";

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
  if (task.status === "handoff" && newStatus === "review" && task.handoff_required) {
    const validation = await validateHandoff(dag.root, task);
    if (!validation.valid) {
      throw new TransitionError(`Handoff validation failed for '${taskId}': ${validation.errors.join("; ")}`);
    }
  }
  if (newStatus === "blocked") {
    task.raw.blocked_from = task.status;
    if (blocker) task.raw.blocker = blocker;
  }
  if (task.status === "blocked" && newStatus === "ready") delete task.raw.blocker;
  task.status = newStatus;
  await saveTaskDag(dag);
  return task;
}
