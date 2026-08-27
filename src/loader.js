import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { DependencyError, SchemaError } from "./errors.js";

export const statuses = new Set(["draft", "ready", "assigned", "in_progress", "handoff", "review", "done", "blocked"]);
export const coordinationPath = path.join("docs", "coordination");
export const dagRelativePath = path.join(coordinationPath, "task-dag.yaml");

export const resolveRoot = (root = ".") => path.resolve(root);
export const coordinationFile = (root, filename) => path.join(resolveRoot(root), coordinationPath, filename);

export function normalizeRelativePath(value) {
  const candidate = String(value ?? "").replaceAll("\\", "/").trim();
  if (!candidate || candidate.startsWith("/")) throw new SchemaError(`Path must be project-relative: ${value}`);
  const normalized = path.posix.normalize(candidate);
  if (normalized === ".." || normalized.startsWith("../")) throw new SchemaError(`Path traversal is not allowed: ${value}`);
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
  if (typeof id !== "string" || !id.trim()) throw new SchemaError("Every task requires a non-empty string 'id'.");
  if (typeof raw.owner !== "string" || !raw.owner.trim()) throw new SchemaError(`Task '${id}' requires an owner.`);
  const status = raw.status ?? "draft";
  if (!statuses.has(status)) throw new SchemaError(`Task '${id}' has unsupported status '${status}'.`);
  if (typeof (raw.parallel ?? false) !== "boolean") throw new SchemaError(`Task '${id}' parallel must be boolean.`);
  if (typeof (raw.handoff_required ?? true) !== "boolean") throw new SchemaError(`Task '${id}' handoff_required must be boolean.`);
  return {
    id, owner: raw.owner, status, goal: raw.goal ?? "", allowed_paths: strings(raw.allowed_paths, "allowed_paths", id),
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
  const data = await readYaml(file);
  if (!data || typeof data !== "object" || !Array.isArray(data.tasks)) throw new SchemaError(`Task DAG ${file} requires a tasks list.`);
  const tasks = data.tasks.map(taskFrom);
  const byId = new Map();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new DependencyError(`Duplicate task id: ${task.id}`);
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    const missing = task.depends_on.filter((id) => !byId.has(id));
    if (missing.length) throw new DependencyError(`Task '${task.id}' depends on missing task(s): ${missing.join(", ")}`);
  }
  assertAcyclic(byId);
  return { root: resolveRoot(root), file, data, tasks, byId };
}

export async function saveTaskDag(dag) {
  dag.data.tasks = dag.tasks.map((task) => ({ ...task.raw, status: task.status }));
  await writeFile(dag.file, YAML.stringify(dag.data), "utf8");
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
