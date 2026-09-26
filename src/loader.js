import { readFile, writeFile, rename, unlink, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import YAML from "yaml";
import { DependencyError, SchemaError } from "./errors.js";

export const statuses = new Set(["draft", "ready", "assigned", "in_progress", "handoff", "review", "done", "blocked", "cancelled"]);
export const coordinationPath = path.join("docs", "coordination");
export const dagRelativePath = path.join(coordinationPath, "task-dag.yaml");

export const resolveRoot = (root = ".") => path.resolve(root);
export const coordinationFile = (root, filename) => path.join(resolveRoot(root), coordinationPath, filename);

export function normalizeRelativePath(value) {
  const candidate = String(value ?? "").replaceAll("\\", "/").trim();
  if (!candidate || candidate.startsWith("/") || /^[a-z]:/i.test(candidate) || candidate.includes(":")) throw new SchemaError(`Path must be project-relative: ${value}`);
  const normalized = path.posix.normalize(candidate);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new SchemaError(`Path traversal is not allowed: ${value}`);
  return normalized;
}

function strings(value, field, taskId) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SchemaError(`Task '${taskId}' field '${field}' must be a list of strings.`);
  }
  return [...value];
}

function taskFrom(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SchemaError("Each task must be a YAML mapping.");
  const id = raw.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new SchemaError("Task id must use letters, numbers, '_' or '-'.");
  if (!Number.isInteger(raw.revision ?? 1) || (raw.revision ?? 1) < 1) throw new SchemaError(`Invalid task revision: ${id}`);
  if (typeof raw.owner !== "string" || !raw.owner.trim()) throw new SchemaError(`Task '${id}' requires an owner.`);
  const status = raw.status ?? "draft";
  if (!statuses.has(status)) throw new SchemaError(`Task '${id}' has unsupported status '${status}'.`);
  if (typeof (raw.parallel ?? false) !== "boolean") throw new SchemaError(`Task '${id}' parallel must be boolean.`);
  if (typeof (raw.handoff_required ?? true) !== "boolean") throw new SchemaError(`Task '${id}' handoff_required must be boolean.`);
  return {
    id, owner: raw.owner, status, goal: raw.goal ?? "", allowed_paths: strings(raw.allowed_paths, "allowed_paths", id).map(normalizeScope),
    resources: strings(raw.resources, "resources", id),
    inputs: strings(raw.inputs, "inputs", id), outputs: strings(raw.outputs, "outputs", id),
    depends_on: strings(raw.depends_on, "depends_on", id), parallel: raw.parallel ?? false,
    conflicts_with: strings(raw.conflicts_with, "conflicts_with", id), acceptance: strings(raw.acceptance, "acceptance", id),
    verification: strings(raw.verification, "verification", id), handoff_required: raw.handoff_required ?? true, raw,
  };
}

export async function readYaml(file, fallback = undefined) {
  try {
    const text = await readFile(file, "utf8");
    return YAML.parse(text) ?? {};
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    if (error?.name === "YAMLParseError") throw new SchemaError(`Invalid YAML in ${file}: ${error.message}`);
    throw error;
  }
}

export async function loadTaskDag(root = ".") {
  const file = path.join(resolveRoot(root), dagRelativePath);
  const snapshot = await readFile(file, "utf8");
  let data;
  try { data = YAML.parse(snapshot); } catch (error) { throw new SchemaError(`Invalid YAML in ${file}: ${error.message}`); }
  if (!data || typeof data !== "object" || !Array.isArray(data.tasks)) throw new SchemaError(`Task DAG ${file} requires a tasks list.`);
  if (data.require_provenance !== undefined && typeof data.require_provenance !== "boolean") throw new SchemaError("require_provenance must be boolean");
  if (!Number.isInteger(data.max_concurrent ?? 3) || (data.max_concurrent ?? 3) < 1) throw new SchemaError("max_concurrent must be a positive integer");
  const tasks = data.tasks.map(taskFrom);
  const byId = new Map();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new DependencyError(`Duplicate task id: ${task.id}`);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    const missing = task.depends_on.filter((id) => !byId.has(id));
    if (missing.length) throw new DependencyError(`Task '${task.id}' depends on missing task(s): ${missing.join(", ")}`);
    if (task.conflicts_with.includes(task.id)) throw new DependencyError(`Task '${task.id}' cannot conflict with itself.`);
    const missingConflicts = task.conflicts_with.filter((id) => !byId.has(id));
    if (missingConflicts.length) throw new DependencyError(`Task '${task.id}' conflicts with missing task(s): ${missingConflicts.join(", ")}`);
  }
  assertAcyclic(byId);
  return { root: resolveRoot(root), file, data, tasks, byId, snapshot };
}

export async function saveTaskDag(dag) {
  // Lock the canonical DAG, compare the loaded snapshot, then replace atomically.
  // A crash leaves a visible lock for Manager recovery; never steal a live lock.
  const lock = `${dag.file}.lock`, temporary = `${dag.file}.${randomUUID()}.tmp`;
  let handle;
  try { handle = await open(lock, "wx"); } catch (error) {
    if (error.code === "EEXIST") throw new SchemaError(`Coordination writer locked: ${lock}; reconcile the owner before retrying.`);
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
    if (await readFile(dag.file, "utf8") !== dag.snapshot) throw new SchemaError("Stale task snapshot; reload before writing.");
    dag.data.tasks = dag.tasks.map((task) => ({ ...task.raw, status: task.status }));
    const text = YAML.stringify(dag.data);
    await writeFile(temporary, text, "utf8");
    await rename(temporary, dag.file);
    dag.snapshot = text;
  } finally {
    await unlink(temporary).catch(() => {});
    await handle.close();
    await unlink(lock);
  }
}

export function normalizeScope(value) {
  const scope = normalizeRelativePath(value);
  const base = scope.endsWith("/**") ? scope.slice(0, -3) : scope;
  if (!base || /[*?\[\]{}]/.test(base)) throw new SchemaError(`Unsupported scope '${value}'; use exact paths or directory/**.`);
  return scope;
}

export function scopeContains(scope, file) {
  const s = normalizeScope(scope), f = normalizeRelativePath(file);
  return s.endsWith("/**") ? f === s.slice(0, -3) || f.startsWith(s.slice(0, -2)) : f === s;
}

function assertAcyclic(byId) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id, chain) {
    if (visiting.has(id)) {
      const start = chain.indexOf(id);
      throw new DependencyError(`Cyclic dependency: ${[...chain.slice(start), id].join(" -> ")}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on) visit(dependency, [...chain, dependency]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id, [id]);
}
