import { readFile } from "node:fs/promises";
import path from "node:path";
import { coordinationFile, loadTaskDag, readYaml, resolveRoot } from "./loader.js";
import { getBlockedTasks, getReadyTasks, getTaskStatus } from "./scheduler.js";
import { markdownSections } from "./handoff.js";

const defaults = { manager: 12000, worker: 8000, reviewer: 10000 };

export async function buildManagerContext(root, budget) {
  const project = resolveRoot(root); const dag = await loadTaskDag(project);
  const segments = await projectSegments(project, true);
  const active = dag.tasks.filter((task) => task.status !== "done").map((task) => `- ${task.id}: ${getTaskStatus(dag, task.id).state} — ${task.goal}`).join("\n") || "- None";
  segments.push(segment("Current tasks", active, "docs/coordination/task-dag.yaml", ["current_task_summary"], true));
  segments.push(segment("Scheduling", `Ready: ${getReadyTasks(dag).map((task) => task.id).join(", ") || "None"}\nBlocked: ${getBlockedTasks(dag).map((item) => item.task_id).join(", ") || "None"}`, "docs/coordination/task-dag.yaml", ["ready_and_blocked_tasks"], true));
  segments.push(...await contractSegments(project, null, "shared_contract"));
  return assemble(segments, await getBudget(project, "manager", budget));
}

export async function buildWorkerContext(root, taskId, budget) {
  const project = resolveRoot(root); const dag = await loadTaskDag(project); const task = dag.byId.get(taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);
  const segments = [segment("Worker assignment", taskText(project, task), "docs/coordination/task-dag.yaml", ["current_task"], true)];
  segments.push(...await moduleSegments(project, task)); segments.push(...await contractSegments(project, [...task.inputs, ...task.outputs], "relevant_contract")); segments.push(...await upstreamSegments(project, task.depends_on));
  return assemble(segments, await getBudget(project, "worker", budget));
}

export async function buildReviewerContext(root, taskId, budget) {
  const project = resolveRoot(root); const dag = await loadTaskDag(project); const task = dag.byId.get(taskId);
  if (!task) throw new Error(`Unknown task id: ${taskId}`);
  const handoff = path.join(project, "docs", "coordination", "handoffs", `${task.id}.md`);
  let handoffText = "Handoff is not present."; try { handoffText = await readFile(handoff, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const segments = [segment("Review task", taskText(project, task), "docs/coordination/task-dag.yaml", ["current_task"], true), segment("Worker handoff", handoffText, `docs/coordination/handoffs/${task.id}.md`, ["worker_handoff"], true)];
  segments.push(...await contractSegments(project, [...task.inputs, ...task.outputs], "relevant_contract")); segments.push(...await upstreamSegments(project, task.depends_on));
  return assemble(segments, await getBudget(project, "reviewer", budget));
}

function segment(title, text, source, reasons, critical = false) { return { title, text, source: { path: source.replaceAll("\\", "/"), reasons }, critical }; }
async function projectSegments(root, includeDecisions) {
  const segments = [];
  for (const [file, headings] of [["CONSTITUTION.md", ["Outcome"]], ["STATE.md", ["Current milestone", "Current user-visible outcome", ...(includeDecisions ? ["Decisions made"] : []), "Blockers and risks", "Next Manager action"]]]) {
    try { const sections = markdownSections(await readFile(coordinationFile(root, file), "utf8")); for (const heading of headings) if (sections.get(heading)) segments.push(segment(heading, sections.get(heading), `docs/coordination/${file}`, [heading.toLowerCase().replaceAll(" ", "_")], heading !== "Decisions made")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return segments;
}
async function moduleSegments(root, task) {
  const registry = await readYaml(coordinationFile(root, "module-registry.yaml"), {}); const module = registry.modules?.find((item) => item.id === task.owner);
  const text = module ? Object.entries(module).filter(([key]) => ["id", "name", "purpose", "writable_paths", "inputs", "outputs", "non_goals", "validation"].includes(key)).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") : `Owner module '${task.owner}' is not registered.`;
  return [segment("Module", text, "docs/coordination/module-registry.yaml", ["owner_module"], true)];
}
async function contractSegments(root, ids, reason) {
  const config = await readYaml(coordinationFile(root, "runtime.yaml"), {}); const wanted = ids ? new Set(ids) : null; const segments = [];
  for (const contract of config.contracts ?? []) { const full = contract.version ? `${contract.id}@${contract.version}` : contract.id; if (wanted && !wanted.has(full) && !wanted.has(contract.id)) continue; let text = contract.summary ?? "No contract summary available."; if (contract.path) try { text = await readFile(path.join(root, contract.path), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; } segments.push(segment(`Contract ${full}`, text, contract.path ?? "docs/coordination/runtime.yaml", [reason])); }
  return segments;
}
async function upstreamSegments(root, dependencies) {
  const segments = [];
  for (const id of dependencies) { const relative = `docs/coordination/handoffs/${id}.md`; try { const sections = markdownSections(await readFile(path.join(root, relative), "utf8")); segments.push(segment(`Upstream handoff: ${id}`, [sections.get("Result"), sections.get("Contract impact")].filter(Boolean).join("\n") || "Handoff present; see path.", relative, ["direct_dependency"])); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  return segments;
}
function taskText(root, task) { return [`Project root: ${root}`, `Module: ${task.owner}`, `Task: ${task.id}`, `Mission: ${task.goal}`, `Allowed paths: ${JSON.stringify(task.allowed_paths)}`, `Inputs: ${JSON.stringify(task.inputs)}`, `Outputs: ${JSON.stringify(task.outputs)}`, `Dependencies: ${JSON.stringify(task.depends_on)}`, `Acceptance: ${JSON.stringify(task.acceptance)}`, `Verification: ${JSON.stringify(task.verification)}`, "Handoff requirements: Result; Changed files; Contract impact; Validation performed; Evidence locations; Known limits / risks; Suggested next action."].join("\n"); }
async function getBudget(root, role, override) { if (override != null) return override; const config = await readYaml(coordinationFile(root, "runtime.yaml"), {}); return Number(config.context_budget?.[role] ?? defaults[role]); }
function assemble(segments, budget) { const included = []; const omitted = []; const warnings = []; const chunks = []; let size = 0; for (const item of segments) { const chunk = `## ${item.title}\n${item.text.trim()}\n`; if (size + chunk.length <= budget || item.critical) { chunks.push(chunk); included.push(item.source); size += chunk.length; if (size > budget) warnings.push(`Context budget exceeded because critical fields were retained: ${item.source.path}`); } else { omitted.push(item.source); warnings.push(`Omitted lower-priority source due to budget: ${item.source.path}`); } } const context = `${chunks.join("\n").trim()}\n`; return { context, included_sources: mergeSources(included), omitted_sources: mergeSources(omitted), warnings, estimated_size: context.length }; }
function mergeSources(sources) { const output = new Map(); for (const source of sources) { const current = output.get(source.path) ?? { path: source.path, reasons: [] }; for (const reason of source.reasons) if (!current.reasons.includes(reason)) current.reasons.push(reason); output.set(source.path, current); } return [...output.values()]; }
