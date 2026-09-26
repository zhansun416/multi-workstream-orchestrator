import { loadTaskDag, saveTaskDag, statuses } from "./loader.js";
import { TransitionError } from "./errors.js";
import { validateHandoff } from "./handoff.js";
import { dispatchConflicts, getTaskStatus, reservations } from "./scheduler.js";
import { assignmentErrors, readHandoffRecord, validateRecord } from "./provenance.js";
import { inspectCoordination } from "./doctor.js";

export const allowedTransitions = {
  draft: ["ready", "cancelled"], ready: ["assigned", "cancelled"], assigned: ["in_progress", "blocked", "cancelled"], in_progress: ["handoff", "blocked", "cancelled"],
  handoff: ["review", "blocked", "cancelled"], review: ["done", "in_progress", "blocked", "cancelled"], done: [], blocked: ["ready", "cancelled"], cancelled: [],
};

export async function updateTaskStatus(root, taskId, newStatus, { blocker, reason, expectedRevision, record } = {}) {
  const dag = await loadTaskDag(root);
  const task = dag.byId.get(taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);
  if (expectedRevision !== undefined && Number(expectedRevision) !== (task.raw.revision ?? 1)) throw new TransitionError("Task revision changed; reconcile before dispatch.");
  if (!statuses.has(newStatus) || !allowedTransitions[task.status].includes(newStatus)) {
    throw new TransitionError(`Illegal transition for '${taskId}': ${task.status} -> ${newStatus}`);
  }
  if (newStatus === "assigned") {
    if (!task.goal || !task.allowed_paths.length || !task.acceptance.length || !task.verification.length) throw new TransitionError("Assignment requires goal, scope, acceptance and verification.");
    if (reservations(dag).length >= (dag.data.max_concurrent ?? 3)) throw new TransitionError("Concurrency limit reached.");
    if (getTaskStatus(dag,taskId).state !== "ready") throw new TransitionError("Dependencies are not done; task cannot be assigned.");
    if (record) {
      const errors = assignmentErrors(task,record);
      if (errors.length) throw new TransitionError(errors.join("; "));
      if (dag.tasks.some(t => t.raw.assignment?.dispatch_id === record.dispatch_id || (t.raw.assignment_history ?? []).some(a => a.dispatch_id === record.dispatch_id))) throw new TransitionError("Dispatch id already used; reconcile instead of resending.");
      task.raw.assignment = record;
    }
    if (dag.data.require_provenance && !record) throw new TransitionError("Assignment record required.");
    const conflicts = dispatchConflicts(dag,task);
    if (conflicts.length) throw new TransitionError(`Active task conflict: ${conflicts.join("; ")}`);
    if (dag.data.require_provenance) {
      const report = await inspectCoordination(dag);
      if (!report.valid) throw new TransitionError(report.errors.join("; "));
    }
  }
  if (task.status === "handoff" && newStatus === "review" && task.handoff_required) {
    const validation = await validateHandoff(dag.root, task);
    if (!validation.valid) {
      throw new TransitionError(`Handoff validation failed for '${taskId}': ${validation.errors.join("; ")}`);
    }
  }
  if (newStatus === "review" && (dag.data.require_provenance || task.raw.assignment)) {
    const handoff = await readHandoffRecord(dag.root,task);
    const report = await validateRecord(dag.root,task,handoff);
    if (!report.valid) throw new TransitionError(report.errors.join("; "));
    task.raw.handoff_commit = handoff.head_commit;
  }
  if (newStatus === "done" && (dag.data.require_provenance || task.raw.assignment)) {
    const report = await validateRecord(dag.root,task,record,"integration");
    if (!report.valid) throw new TransitionError(report.errors.join("; "));
    task.raw.integration = record;
  }
  if (newStatus === "cancelled" || task.status === "blocked" && newStatus === "ready" || task.status === "review" && newStatus === "in_progress") {
    if (!reason?.trim()) throw new TransitionError("Resolution/repair/cancellation reason required; confirm the previous writer is stopped or acknowledged before releasing it.");
    if (newStatus === "ready" || newStatus === "cancelled") {
      if (task.raw.assignment) task.raw.assignment_history = [...(task.raw.assignment_history ?? []), task.raw.assignment];
      delete task.raw.assignment;
    }
    if (task.raw.handoff_commit) task.raw.superseded_commits = [...(task.raw.superseded_commits ?? []), task.raw.handoff_commit];
    delete task.raw.handoff_commit;
    delete task.raw.integration;
  }
  if (newStatus === "blocked") {
    if (!blocker?.trim()) throw new TransitionError("Blocker reason required.");
    task.raw.blocked_from = task.status;
    if (blocker) task.raw.blocker = blocker;
  }
  if (task.status === "blocked" && newStatus === "ready") delete task.raw.blocker;
  task.raw.history = [...(task.raw.history ?? []), { from: task.status, to: newStatus, at: new Date().toISOString(), reason: reason ?? blocker ?? null }];
  task.status = newStatus;
  await saveTaskDag(dag);
  return task;
}
