import { checkConflicts } from "./conflicts.js";

export const activeStatuses = new Set(["assigned", "in_progress", "handoff", "review"]);

export function getTaskStatus(dag, taskId) {
  const task = dag.byId.get(taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);
  if (task.status === "done") return { task_id: taskId, state: "done", reasons: [] };
  if (task.status === "blocked") {
    return { task_id: taskId, state: "blocked", reasons: task.raw.blocker ? [String(task.raw.blocker)] : [] };
  }
  if (["assigned", "in_progress"].includes(task.status)) return { task_id: taskId, state: "running", reasons: [] };
  if (["handoff", "review"].includes(task.status)) return { task_id: taskId, state: "review_required", reasons: [] };
  if (task.status === "draft") return { task_id: taskId, state: "waiting", reasons: ["manager_approval_required"] };
  const eligibility = getAssignmentEligibility(dag, task);
  return eligibility.eligible
    ? { task_id: taskId, state: "ready", reasons: [] }
    : { task_id: taskId, state: "blocked", reasons: eligibility.reasons };
}

export function getAssignmentEligibility(dag, taskOrId, { activeTasks } = {}) {
  const task = typeof taskOrId === "string" ? dag.byId.get(taskOrId) : taskOrId;
  if (!task) return { eligible: false, reasons: ["task_not_found"] };
  const reasons = [];
  if (task.status !== "ready") reasons.push(`status_not_ready:${task.status}`);
  for (const id of task.depends_on) {
    if (dag.byId.get(id).status !== "done") reasons.push(`dependency_not_done:${id}`);
  }
  reasons.push(...ownerAvailabilityReasons(task));
  reasons.push(...contractRequirementReasons(task));
  const occupied = activeTasks ?? dag.tasks.filter((item) => activeStatuses.has(item.status));
  for (const active of occupied) reasons.push(...activeConflictReasons(task, active));
  return { eligible: reasons.length === 0, reasons };
}

export const getReadyTasks = (dag) => dag.tasks.filter((task) => getAssignmentEligibility(dag, task).eligible);

export const getBlockedTasks = (dag) => dag.tasks
  .map((task) => getTaskStatus(dag, task.id))
  .filter((status) => status.state === "blocked");

export function analyzeExecutionWave(dag) {
  const wave = [];
  const excluded = [];
  const active = dag.tasks.filter((task) => activeStatuses.has(task.status));
  for (const candidate of dag.tasks.filter((task) => task.status === "ready")) {
    const eligibility = getAssignmentEligibility(dag, candidate, { activeTasks: active });
    if (!eligibility.eligible) {
      excluded.push({ task_id: candidate.id, reasons: eligibility.reasons });
      continue;
    }
    if (!wave.length) {
      wave.push(candidate);
      continue;
    }
    if (!candidate.parallel || wave.some((task) => !task.parallel)) {
      excluded.push({ task_id: candidate.id, reasons: ["not_parallel_with_selected_wave"] });
      continue;
    }
    const conflicts = wave.flatMap((task) => checkConflicts(candidate, task).map((reason) => `wave_conflict:${task.id}:${reason}`));
    if (conflicts.length) {
      excluded.push({ task_id: candidate.id, reasons: conflicts });
      continue;
    }
    wave.push(candidate);
  }
  return { wave, excluded };
}

export const buildExecutionWave = (dag) => analyzeExecutionWave(dag).wave;

function activeConflictReasons(candidate, active) {
  if (!candidate.parallel || !active.parallel) return [`active_serial_conflict:${active.id}`];
  return checkConflicts(candidate, active).map((reason) => `active_conflict:${active.id}:${reason}`);
}

function ownerAvailabilityReasons(task) {
  if (task.owner_type === "manager") return [];
  if (!task.module) return [`owner_not_registered:${task.owner}`];
  const status = task.module.status ?? "active";
  if (!["approved", "active"].includes(status)) return [`owner_module_unavailable:${task.owner}:${status}`];
  const executionStatus = task.module.execution?.status;
  if (executionStatus && !["active", "idle"].includes(executionStatus)) {
    return [`owner_execution_unavailable:${task.owner}:${executionStatus}`];
  }
  return [];
}

function contractRequirementReasons(task) {
  const reasons = [];
  for (const requirement of task.contract_requirements ?? []) {
    if (["file", "summary"].includes(requirement.status)) continue;
    if (requirement.status === "registry_missing") reasons.push(`contract_registry_missing:${requirement.reference}`);
    else if (requirement.status === "version_missing") {
      reasons.push(`contract_version_not_registered:${requirement.reference}:available=${requirement.available_versions.join(",")}`);
    } else if (requirement.status === "unregistered") reasons.push(`contract_not_registered:${requirement.reference}`);
    else if (requirement.status === "file_missing") reasons.push(`contract_file_missing:${requirement.reference}:${requirement.contract.path}`);
    else reasons.push(`contract_source_missing:${requirement.reference}`);
  }
  return reasons;
}
