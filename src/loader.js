import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import { DependencyError, LockError, RevisionConflictError, SchemaError } from "./errors.js";
import { normalizePathScope, normalizeRelativePath, scopeContains } from "./paths.js";

export { normalizeRelativePath } from "./paths.js";

export const statuses = new Set(["draft", "ready", "assigned", "in_progress", "handoff", "review", "done", "blocked"]);
export const coordinationPath = path.join("docs", "coordination");
export const dagRelativePath = path.join(coordinationPath, "task-dag.yaml");
export const registryRelativePath = path.join(coordinationPath, "module-registry.yaml");
export const runtimeRelativePath = path.join(coordinationPath, "runtime.yaml");

export const resolveRoot = (root = ".") => path.resolve(root);
export const coordinationFile = (root, filename) => path.join(resolveRoot(root), coordinationPath, filename);

function strings(value, field, taskId) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SchemaError(`Task '${taskId}' field '${field}' must be a list of strings.`, { code: "TASK_FIELD_INVALID" });
  }
  return [...value];
}

function taskFrom(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SchemaError("Each task must be a YAML mapping.", { code: "TASK_INVALID" });
  }
  const id = raw.id;
  if (typeof id !== "string" || !id.trim()) throw new SchemaError("Every task requires a non-empty string 'id'.", { code: "TASK_ID_INVALID" });
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id) || id.includes("..")) {
    throw new SchemaError(`Task id '${id}' must be a safe single path segment.`, { code: "TASK_ID_INVALID" });
  }
  if (typeof raw.owner !== "string" || !raw.owner.trim()) throw new SchemaError(`Task '${id}' requires an owner.`, { code: "TASK_OWNER_INVALID" });
  const status = raw.status ?? "draft";
  if (!statuses.has(status)) throw new SchemaError(`Task '${id}' has unsupported status '${status}'.`, { code: "TASK_STATUS_INVALID" });
  if (typeof (raw.parallel ?? false) !== "boolean") throw new SchemaError(`Task '${id}' parallel must be boolean.`, { code: "TASK_FIELD_INVALID" });
  if (typeof (raw.handoff_required ?? true) !== "boolean") throw new SchemaError(`Task '${id}' handoff_required must be boolean.`, { code: "TASK_FIELD_INVALID" });
  const ownerType = raw.owner_type ?? "module";
  if (!["module", "manager"].includes(ownerType)) {
    throw new SchemaError(`Task '${id}' owner_type must be 'module' or 'manager'.`, { code: "TASK_OWNER_TYPE_INVALID" });
  }
  const deliveryKind = raw.delivery?.kind;
  if (deliveryKind != null && !["code", "artifact", "manual"].includes(deliveryKind)) {
    throw new SchemaError(`Task '${id}' delivery.kind must be 'code', 'artifact', or 'manual'.`, { code: "TASK_DELIVERY_KIND_INVALID" });
  }
  if (deliveryKind === "code" && raw.handoff_required === false) {
    throw new SchemaError(`Code task '${id}' must require a handoff.`, { code: "CODE_HANDOFF_REQUIRED" });
  }
  return {
    id,
    owner: raw.owner,
    owner_type: ownerType,
    status,
    goal: raw.goal ?? "",
    allowed_paths: strings(raw.allowed_paths, "allowed_paths", id).map(normalizePathScope),
    inputs: strings(raw.inputs, "inputs", id),
    outputs: strings(raw.outputs, "outputs", id),
    depends_on: strings(raw.depends_on, "depends_on", id),
    parallel: raw.parallel ?? false,
    conflicts_with: strings(raw.conflicts_with, "conflicts_with", id),
    acceptance: strings(raw.acceptance, "acceptance", id),
    verification: strings(raw.verification, "verification", id),
    handoff_required: raw.handoff_required ?? true,
    delivery_kind: deliveryKind ?? null,
    attempt: positiveInteger(raw.attempt ?? 1, `Task '${id}' attempt`),
    raw,
  };
}

export async function readYaml(file, fallback = undefined) {
  try {
    return (await readYamlDocument(file)).data;
  } catch (error) {
    if (error?.code === "REQUIRED_FILE_MISSING" && fallback !== undefined) return fallback;
    throw error;
  }
}

export async function loadTaskDag(root = ".") {
  const project = resolveRoot(root);
  const file = path.join(project, dagRelativePath);
  const registryFile = path.join(project, registryRelativePath);
  const runtimeFile = path.join(project, runtimeRelativePath);
  const [dagDocument, registry, runtimeConfig] = await Promise.all([
    readYamlDocument(file),
    readYaml(registryFile),
    readOptionalYaml(runtimeFile),
  ]);
  const data = dagDocument.data;
  if (!data || typeof data !== "object" || !Array.isArray(data.tasks)) {
    throw new SchemaError(`Task DAG ${file} requires a tasks list.`, { code: "TASK_DAG_INVALID" });
  }
  const revision = revisionOf(data);
  const modules = loadModules(registry, registryFile);
  const contracts = await loadContracts(project, runtimeConfig);
  const tasks = data.tasks.map(taskFrom);
  const byId = new Map();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new DependencyError(`Duplicate task id: ${task.id}`, { code: "TASK_ID_DUPLICATE" });
    byId.set(task.id, task);
  }
  for (const task of tasks) validateTaskReferences(task, byId);
  assertAcyclic(byId);
  for (const task of tasks) validateTaskProjectScope(task, modules, contracts);
  return {
    root: project,
    file,
    data,
    snapshot_hash: digest(dagDocument.text),
    revision,
    tasks,
    byId,
    modules,
    contracts,
    runtime_config: runtimeConfig.data,
    runtime_file_present: runtimeConfig.present,
  };
}

export async function saveTaskDag(dag) {
  return withTaskDagLock(dag.root, async () => saveTaskDagUnlocked(dag));
}

export async function saveTaskDagUnlocked(dag) {
  const diskDocument = await readYamlDocument(dag.file);
  const diskRevision = revisionOf(diskDocument.data);
  const diskHash = digest(diskDocument.text);
  if (diskRevision !== dag.revision || diskHash !== dag.snapshot_hash) {
    throw new RevisionConflictError(
      `Task DAG changed after this snapshot was loaded; reload before saving.`,
      { details: { expected_revision: dag.revision, actual_revision: diskRevision, content_changed: diskHash !== dag.snapshot_hash } },
    );
  }
  const nextRevision = dag.revision + 1;
  const nextData = {
    ...dag.data,
    revision: nextRevision,
    tasks: dag.tasks.map((task) => ({ ...task.raw, status: task.status, attempt: task.attempt })),
  };
  const text = await atomicWriteYaml(dag.file, nextData);
  dag.data = nextData;
  dag.revision = nextRevision;
  dag.snapshot_hash = digest(text);
  return dag;
}

export async function withTaskDagLock(root, operation, { timeoutMs = 5000, retryMs = 20 } = {}) {
  const lockFile = path.join(resolveRoot(root), `${dagRelativePath}.lock`);
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try {
      handle = await open(lockFile, "wx");
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => {});
        handle = undefined;
        await unlink(lockFile).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new LockError(`Timed out waiting for task DAG lock: ${lockFile}`, { details: { path: lockFile, timeout_ms: timeoutMs } });
      }
      await delay(retryMs);
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockFile).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
}

function validateTaskReferences(task, byId) {
  const missing = task.depends_on.filter((id) => !byId.has(id));
  if (missing.length) throw new DependencyError(`Task '${task.id}' depends on missing task(s): ${missing.join(", ")}`, { code: "TASK_DEPENDENCY_MISSING" });
  if (task.conflicts_with.includes(task.id)) throw new DependencyError(`Task '${task.id}' cannot conflict with itself.`, { code: "TASK_CONFLICT_SELF" });
  const missingConflicts = task.conflicts_with.filter((id) => !byId.has(id));
  if (missingConflicts.length) throw new DependencyError(`Task '${task.id}' conflicts with missing task(s): ${missingConflicts.join(", ")}`, { code: "TASK_CONFLICT_MISSING" });

}

function validateTaskProjectScope(task, modules, contracts) {
  let module = null;
  if (task.owner_type === "module") {
    module = modules.get(task.owner);
    if (!module) {
      throw new SchemaError(`Task '${task.id}' owner '${task.owner}' is not registered.`, {
        code: "OWNER_NOT_REGISTERED",
        details: { task_id: task.id, owner: task.owner },
      });
    }
    for (const allowed of task.allowed_paths) {
      if (!module.writable_paths.some((scope) => scopeContains(scope, allowed))) {
        throw new SchemaError(`Task '${task.id}' allowed path '${allowed}' is outside module '${task.owner}' writable_paths.`, {
          code: "TASK_SCOPE_OUTSIDE_MODULE",
          details: { task_id: task.id, owner: task.owner, path: allowed },
        });
      }
    }
  }

  task.module = module;
  task.contract_requirements = [...new Set([...task.inputs, ...task.outputs])].map((reference) => contractRequirement(reference, contracts));
  task.protected_paths = ["docs/coordination/**", ...[...contracts.values()].filter((item) => item.path).map((item) => item.path)];
  task.coordination_exceptions = coordinationExceptions(task);
}

function loadModules(registry, file) {
  if (!registry || typeof registry !== "object" || !Array.isArray(registry.modules)) {
    throw new SchemaError(`Module registry ${file} requires a modules list.`, { code: "MODULE_REGISTRY_INVALID" });
  }
  const modules = new Map();
  for (const raw of registry.modules) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
      throw new SchemaError(`Module registry ${file} contains a module without a valid id.`, { code: "MODULE_INVALID" });
    }
    if (modules.has(raw.id)) throw new SchemaError(`Duplicate module id: ${raw.id}`, { code: "MODULE_ID_DUPLICATE" });
    if (!Array.isArray(raw.writable_paths) || raw.writable_paths.some((item) => typeof item !== "string")) {
      throw new SchemaError(`Module '${raw.id}' writable_paths must be a list of paths.`, { code: "MODULE_PATHS_INVALID" });
    }
    modules.set(raw.id, { ...raw, writable_paths: raw.writable_paths.map(normalizePathScope) });
  }
  return modules;
}

async function loadContracts(root, runtimeConfig) {
  const rawContracts = runtimeConfig.data.contracts ?? [];
  if (!Array.isArray(rawContracts)) throw new SchemaError("runtime.yaml contracts must be a list.", { code: "CONTRACT_REGISTRY_INVALID" });
  const contracts = new Map();
  for (const raw of rawContracts) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id.trim()) {
      throw new SchemaError("Every contract requires a non-empty string id.", { code: "CONTRACT_INVALID" });
    }
    const key = raw.version ? `${raw.id}@${raw.version}` : raw.id;
    if (contracts.has(key)) throw new SchemaError(`Duplicate contract registration: ${key}`, { code: "CONTRACT_DUPLICATE" });
    const contract = { ...raw, key, path: null, content: null, source_status: "missing" };
    if (raw.path != null) {
      contract.path = normalizeRelativePath(raw.path);
      try {
        contract.content = await readFile(path.join(root, contract.path), "utf8");
        contract.source_status = "file";
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        contract.source_status = "file_missing";
      }
    } else if (typeof raw.summary === "string" && raw.summary.trim()) {
      contract.source_status = "summary";
    }
    contracts.set(key, contract);
  }
  Object.defineProperty(contracts, "runtimeFilePresent", { value: runtimeConfig.present });
  return contracts;
}

function contractRequirement(reference, contracts) {
  const exact = contracts.get(reference);
  if (exact) return { reference, contract: exact, status: exact.source_status };
  const separator = reference.lastIndexOf("@");
  const id = separator > 0 ? reference.slice(0, separator) : reference;
  const versions = [...contracts.values()].filter((item) => item.id === id).map((item) => item.version ?? "unversioned");
  return {
    reference,
    contract: null,
    status: !contracts.runtimeFilePresent ? "registry_missing" : versions.length ? "version_missing" : "unregistered",
    available_versions: versions,
  };
}

function coordinationExceptions(task) {
  const paths = [
    `docs/coordination/handoffs/${task.id}.md`,
    `docs/coordination/evidence/${task.id}/**`,
  ];
  if (typeof task.raw.change_id === "string" && task.raw.change_id.trim()) {
    const changeId = normalizeRelativePath(task.raw.change_id.trim());
    if (changeId.includes("/") || changeId.includes("..")) throw new SchemaError(`Task '${task.id}' change_id must be one safe path segment.`, { code: "CHANGE_ID_INVALID" });
    paths.push(`docs/coordination/changes/${changeId}/evidence/${task.id}/**`);
  }
  return paths.map(normalizePathScope);
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new SchemaError(`${label} must be a positive integer.`, { code: "POSITIVE_INTEGER_REQUIRED" });
  return value;
}

function revisionOf(data) {
  const revision = data.revision ?? 0;
  if (!Number.isInteger(revision) || revision < 0) throw new SchemaError("Task DAG revision must be a non-negative integer.", { code: "DAG_REVISION_INVALID" });
  return revision;
}

async function readOptionalYaml(file) {
  try {
    return { data: await readYaml(file), present: true };
  } catch (error) {
    if (error?.code === "REQUIRED_FILE_MISSING") return { data: {}, present: false };
    throw error;
  }
}

async function readYamlDocument(file) {
  try {
    const text = await readFile(file, "utf8");
    return { data: YAML.parse(text) ?? {}, text };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new SchemaError(`Required coordination file does not exist: ${file}`, {
        code: "REQUIRED_FILE_MISSING",
        details: { path: file },
      });
    }
    if (error?.name === "YAMLParseError") throw new SchemaError(`Invalid YAML in ${file}: ${error.message}`, { code: "YAML_INVALID" });
    throw error;
  }
}

async function atomicWriteYaml(file, data) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const text = YAML.stringify(data);
  try {
    await writeFile(temporary, text, "utf8");
    await rename(temporary, file);
    return text;
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function assertAcyclic(byId) {
  const visiting = new Set();
  const visited = new Set();
  function visit(id, chain) {
    if (visiting.has(id)) {
      const start = chain.indexOf(id);
      throw new DependencyError(`Cyclic dependency: ${[...chain.slice(start), id].join(" -> ")}`, { code: "TASK_DEPENDENCY_CYCLE" });
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on) visit(dependency, [...chain, dependency]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id, [id]);
}
