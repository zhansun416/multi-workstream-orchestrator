import path from "node:path";
import { stat } from "node:fs/promises";
import { coordinationFile, readYaml, normalizeScope, scopeContains } from "./loader.js";
import { checkConflicts } from "./conflicts.js";
import { reservations, dispatchConflicts } from "./scheduler.js";
import { assignmentErrors } from "./provenance.js";

export async function inspectCoordination(dag) {
  const errors = [], warnings = [];
  const registry = await readYaml(coordinationFile(dag.root, "module-registry.yaml"), {});
  const modules = new Map();
  for (const module of registry.modules ?? []) {
    if (!module.id || modules.has(module.id)) errors.push(`Missing/duplicate module id: ${module.id}`);
    modules.set(module.id, module);
  }
  const config = await readYaml(coordinationFile(dag.root, "runtime.yaml"), {});
  const versions = new Set((config.contracts ?? []).map(c => c.version ? `${c.id}@${c.version}` : c.id));
  for (const task of dag.tasks) {
    if (["done", "cancelled"].includes(task.status)) continue;
    const module = modules.get(task.owner);
    if (!module) errors.push(`${task.id}: unregistered owner ${task.owner}`);
    if (task.status !== "draft" && (!task.goal || !task.allowed_paths.length || !task.acceptance.length || !task.verification.length)) errors.push(`${task.id}: executable task needs goal, scope, acceptance and verification`);
    for (const scope of task.allowed_paths) {
      if (module && !(module.writable_paths ?? []).some(p => {
        const s = normalizeScope(scope), m = normalizeScope(p);
        return s === m || m.endsWith("/**") && scopeContains(m, s.endsWith("/**") ? s.slice(0,-3) : s);
      })) errors.push(`${task.id}: scope outside module ${scope}`);
      if (scopeContains(scope, "docs/coordination/task-dag.yaml") || scope.startsWith("docs/coordination/")) errors.push(`${task.id}: coordination writes must use its implicit handoff/evidence grant, not broad scope ${scope}`);
    }
    for (const contract of [...task.inputs, ...task.outputs]) if (!versions.has(contract)) errors.push(`${task.id}: unregistered contract version ${contract}`);
    if (task.raw.assignment) errors.push(...assignmentErrors(task, task.raw.assignment).map(e => `${task.id}: ${e}`));
    else if (reservations(dag).includes(task)) warnings.push(`${task.id}: no recorded dispatch; reconcile actual Worker before continuing`);
    if (task.status === "blocked" && !task.raw.blocker) errors.push(`${task.id}: missing blocker`);
  }
  const active = reservations(dag);
  for (let i=0;i<active.length;i++) for (let j=i+1;j<active.length;j++) {
    const conflicts = checkConflicts(active[i], active[j]);
    if (!active[i].parallel || !active[j].parallel) conflicts.push("serial_task");
    if (conflicts.length) errors.push(`${active[i].id}/${active[j].id}: ${conflicts.join(", ")}`);
  }
  if (!dag.data.require_provenance) warnings.push("Legacy project: commit-bound evidence gates disabled; use require_provenance: true for new projects.");
  return { valid: !errors.length, errors, warnings };
}

export async function recoveryReport(dag) {
  const tasks = [];
  for (const task of reservations(dag)) {
    const a = task.raw.assignment;
    let exists = false;
    if (a?.worktree) exists = await stat(a.worktree).then(s => s.isDirectory()).catch(() => false);
    tasks.push({ task_id: task.id, status: task.status, assignment: a ?? null, worktree_exists: exists,
      handoff: path.join(dag.root, "docs/coordination/handoffs", `${task.id}.md`),
      next_action: "Read the recorded thread status; inspect Git HEAD/dirty files; compare task revision, contract versions and handoff. Do not infer liveness or resend from file state alone." });
  }
  return { ...(await inspectCoordination(dag)), tasks,
    waiting: dag.tasks.filter(t => t.status === "ready").map(t => ({ task_id: t.id, reservations: dispatchConflicts(dag,t) })),
    note: "Read-only recovery inventory. No task restart, thread creation, lock removal or reassignment is automatic." };
}
