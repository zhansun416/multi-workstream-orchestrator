import { readFile } from "node:fs/promises";
import path from "node:path";
import { RuntimeError } from "./errors.js";
import { coordinationFile, loadTaskDag, readYaml, resolveRoot } from "./loader.js";
import { getBlockedTasks, getReadyTasks, getTaskStatus } from "./scheduler.js";
import { markdownSections } from "./handoff.js";

const defaults = { manager: 12000, worker: 8000, reviewer: 10000 };

export async function buildManagerContext(root, budget) {
  const project = resolveRoot(root);
  const dag = await loadTaskDag(project);
  const segments = await projectSegments(project, true);
  const active = dag.tasks
    .filter((task) => task.status !== "done")
    .map((task) => `- ${task.id}: ${getTaskStatus(dag, task.id).state} — ${task.goal}`)
    .join("\n") || "- None";
  segments.push(segment("Current tasks", active, "docs/coordination/task-dag.yaml", ["current_task_summary"], true));
  segments.push(segment(
    "Scheduling",
    `Ready: ${getReadyTasks(dag).map((task) => task.id).join(", ") || "None"}\nBlocked: ${getBlockedTasks(dag).map((item) => item.task_id).join(", ") || "None"}`,
    "docs/coordination/task-dag.yaml",
    ["ready_and_blocked_tasks"],
    true,
  ));
  segments.push(...allContractSegments(dag));
  return assemble(segments, await getBudget(project, "manager", budget));
}

export async function buildWorkerContext(root, taskId, budget) {
  const project = resolveRoot(root);
  const dag = await loadTaskDag(project);
  const task = requireTask(dag, taskId);
  const segments = [segment("Worker assignment", taskText(project, task), "docs/coordination/task-dag.yaml", ["current_task"], true)];
  segments.push(...moduleSegments(task));
  const contracts = requirementContractSegments(task);
  segments.push(...contracts.segments);
  segments.push(...await upstreamSegments(project, task.depends_on));
  return assemble(segments, await getBudget(project, "worker", budget), contracts.warnings);
}

export async function buildReviewerContext(root, taskId, budget) {
  const project = resolveRoot(root);
  const dag = await loadTaskDag(project);
  const task = requireTask(dag, taskId);
  const handoffPath = `docs/coordination/handoffs/${task.id}.md`;
  let handoffText = "Handoff is not present.";
  try {
    handoffText = await readFile(path.join(project, handoffPath), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const segments = [
    segment("Review task", taskText(project, task), "docs/coordination/task-dag.yaml", ["current_task"], true),
    segment("Worker handoff", handoffText, handoffPath, ["worker_handoff"], true),
  ];
  const contracts = requirementContractSegments(task);
  segments.push(...contracts.segments);
  segments.push(...await upstreamSegments(project, task.depends_on));
  return assemble(segments, await getBudget(project, "reviewer", budget), contracts.warnings);
}

function requireTask(dag, taskId) {
  const task = dag.byId.get(taskId);
  if (!task) throw new RuntimeError(`Unknown task id: ${taskId}`, { code: "TASK_NOT_FOUND", details: { task_id: taskId } });
  return task;
}

function segment(title, text, source, reasons, critical = false) {
  return { title, text, source: { path: source.replaceAll("\\", "/"), reasons }, critical };
}

async function projectSegments(root, includeDecisions) {
  const segments = [];
  const files = [
    ["CONSTITUTION.md", ["Outcome"]],
    ["STATE.md", ["Current milestone", "Current user-visible outcome", ...(includeDecisions ? ["Decisions made"] : []), "Blockers and risks", "Next Manager action"]],
  ];
  for (const [file, headings] of files) {
    try {
      const sections = markdownSections(await readFile(coordinationFile(root, file), "utf8"));
      for (const heading of headings) {
        if (sections.get(heading)) {
          segments.push(segment(
            heading,
            sections.get(heading),
            `docs/coordination/${file}`,
            [heading.toLowerCase().replaceAll(" ", "_")],
            heading !== "Decisions made",
          ));
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return segments;
}

function moduleSegments(task) {
  const module = task.module;
  const text = module
    ? Object.entries(module)
      .filter(([key]) => ["id", "name", "purpose", "writable_paths", "inputs", "outputs", "non_goals", "validation", "status", "execution", "owner_window"].includes(key))
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n")
    : `Manager-owned task '${task.id}'.`;
  return [segment("Owner", text, "docs/coordination/module-registry.yaml", ["owner_module"], true)];
}

function requirementContractSegments(task) {
  const segments = [];
  const warnings = [];
  for (const requirement of task.contract_requirements ?? []) {
    const contract = requirement.contract;
    const source = contract?.path ?? "docs/coordination/runtime.yaml";
    if (requirement.status === "file") {
      const summary = typeof contract.summary === "string" && contract.summary.trim()
        ? contract.summary.trim()
        : "No declared summary; the full contract must be read before editing.";
      segments.push(segment(
        `Required contract ${requirement.reference}`,
        `Version: ${requirement.reference}\nSource status: file\nSource: ${contract.path}\nSummary: ${summary}\nRequired action: read the full source before modifying code.`,
        source,
        ["relevant_contract_reference", "required_pre_read"],
        true,
      ));
      segments.push(segment(
        `Contract body ${requirement.reference}`,
        contract.content,
        source,
        ["relevant_contract_body"],
      ));
    } else if (requirement.status === "summary") {
      segments.push(segment(
        `Required contract ${requirement.reference}`,
        `Version: ${requirement.reference}\nSource status: declared summary\nSummary: ${contract.summary.trim()}`,
        source,
        ["relevant_contract", "declared_contract_summary"],
        true,
      ));
    } else {
      const diagnostic = contractDiagnostic(requirement);
      segments.push(segment(
        `Required contract ${requirement.reference}`,
        `Version: ${requirement.reference}\nSource status: ${requirement.status}\nDispatch is blocked until the Manager resolves this contract requirement.`,
        source,
        ["required_contract_diagnostic"],
        true,
      ));
      warnings.push(diagnostic);
    }
  }
  return { segments, warnings };
}

function allContractSegments(dag) {
  const segments = [];
  for (const contract of dag.contracts.values()) {
    const text = contract.source_status === "file"
      ? `Source: ${contract.path}\nSummary: ${contract.summary ?? "No declared summary."}`
      : contract.source_status === "summary"
        ? `Declared summary: ${contract.summary}`
        : `Source status: ${contract.source_status}${contract.path ? `\nSource: ${contract.path}` : ""}`;
    segments.push(segment(`Contract ${contract.key}`, text, contract.path ?? "docs/coordination/runtime.yaml", ["shared_contract"]));
  }
  return segments;
}

function contractDiagnostic(requirement) {
  if (requirement.status === "registry_missing") return `Required contract registry is missing for ${requirement.reference}.`;
  if (requirement.status === "version_missing") {
    return `Required contract version is not registered: ${requirement.reference}; available: ${requirement.available_versions.join(", ") || "none"}.`;
  }
  if (requirement.status === "unregistered") return `Required contract is not registered: ${requirement.reference}.`;
  if (requirement.status === "file_missing") return `Required contract file does not exist: ${requirement.contract.path}.`;
  return `Required contract ${requirement.reference} has neither a readable file nor a declared summary.`;
}

async function upstreamSegments(root, dependencies) {
  const segments = [];
  for (const id of dependencies) {
    const relative = `docs/coordination/handoffs/${id}.md`;
    try {
      const sections = markdownSections(await readFile(path.join(root, relative), "utf8"));
      segments.push(segment(
        `Upstream handoff: ${id}`,
        [sections.get("Result"), sections.get("Contract impact")].filter(Boolean).join("\n") || "Handoff present; see path.",
        relative,
        ["direct_dependency"],
      ));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return segments;
}

function taskText(root, task) {
  return [
    `Project root: ${root}`,
    `Module: ${task.owner}`,
    `Owner type: ${task.owner_type}`,
    `Task: ${task.id}`,
    `Attempt: ${task.attempt}`,
    `Delivery kind: ${task.delivery_kind ?? "legacy/unspecified"}`,
    `Mission: ${task.goal}`,
    `Allowed paths: ${JSON.stringify(task.allowed_paths)}`,
    `Protected paths excluded from module permissions: ${JSON.stringify(task.protected_paths)}`,
    `Task-only coordination exceptions: ${JSON.stringify(task.coordination_exceptions)}`,
    `Inputs: ${JSON.stringify(task.inputs)}`,
    `Outputs: ${JSON.stringify(task.outputs)}`,
    `Dependencies: ${JSON.stringify(task.depends_on)}`,
    `Acceptance: ${JSON.stringify(task.acceptance)}`,
    `Verification: ${JSON.stringify(task.verification)}`,
    "Handoff requirements: Result; Changed files; Contract impact; Validation performed; Evidence locations; Known limits / risks; Suggested next action. Retried tasks also record Delivery identity with the current attempt.",
    ...(task.delivery_kind === "code" ? ["Code delivery fields: Delivery identity must include attempt, base_commit, head_commit, and absolute worktree; Validation performed must include command, absolute working_directory, integer exit_code, and the same head_commit."] : []),
  ].join("\n");
}

async function getBudget(root, role, override) {
  if (override != null) return override;
  const config = await readYaml(coordinationFile(root, "runtime.yaml"), {});
  return Number(config.context_budget?.[role] ?? defaults[role]);
}

function assemble(segments, budget, initialWarnings = []) {
  const included = [];
  const omitted = [];
  const warnings = [...initialWarnings];
  const chunks = [];
  let size = 0;
  for (const item of segments) {
    const chunk = `## ${item.title}\n${item.text.trim()}\n`;
    if (size + chunk.length <= budget || item.critical) {
      chunks.push(chunk);
      included.push(item.source);
      size += chunk.length;
      if (size > budget) warnings.push(`Context budget exceeded because critical fields were retained: ${item.source.path}`);
    } else {
      omitted.push(item.source);
      warnings.push(`Omitted lower-priority source due to budget: ${item.source.path}`);
    }
  }
  const context = `${chunks.join("\n").trim()}\n`;
  return {
    context,
    included_sources: mergeSources(included),
    omitted_sources: mergeSources(omitted),
    warnings,
    estimated_size: context.length,
  };
}

function mergeSources(sources) {
  const output = new Map();
  for (const source of sources) {
    const current = output.get(source.path) ?? { path: source.path, reasons: [] };
    for (const reason of source.reasons) if (!current.reasons.includes(reason)) current.reasons.push(reason);
    output.set(source.path, current);
  }
  return [...output.values()];
}
