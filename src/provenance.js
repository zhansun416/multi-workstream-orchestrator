import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeRelativePath, scopeContains } from "./loader.js";

const exec = promisify(execFile);
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const filled = value => typeof value === "string" && value.trim().length > 0;
export const evidencePath = (root, id) => path.join(root, "docs/coordination/evidence", id, "handoff.json");

export function assignmentErrors(task, record) {
  const errors = [];
  if (!record || record.task_id !== task.id || record.task_revision !== (task.raw.revision ?? 1)) errors.push("Assignment task/revision mismatch");
  for (const key of ["dispatch_id", "thread_id", "worktree", "assigned_at"]) if (!filled(record?.[key])) errors.push(`Missing assignment ${key}`);
  if (!sha(record?.base_commit)) errors.push("Assignment needs full base_commit SHA");
  if (record?.worktree && !path.isAbsolute(record.worktree)) errors.push("Assignment worktree must be absolute");
  if (!Array.isArray(record?.contracts) || JSON.stringify([...record.contracts].sort()) !== JSON.stringify([...new Set([...task.inputs, ...task.outputs])].sort())) errors.push("Assignment contracts differ from task input/output versions");
  return errors;
}

export async function validateRecord(root, task, record, stage = "handoff") {
  const errors = [];
  const assignment = task.raw.assignment;
  errors.push(...assignmentErrors(task, assignment));
  if (!record || record.task_id !== task.id || record.task_revision !== (task.raw.revision ?? 1) || !record.dispatch_id || record.dispatch_id !== assignment?.dispatch_id) errors.push("Stale or mismatched evidence task/revision/dispatch");
  if (!sha(record?.head_commit)) errors.push("Evidence needs full head_commit SHA");
  if ((task.raw.superseded_commits ?? []).includes(record?.head_commit)) errors.push("Evidence refers to a superseded/rejected handoff commit");
  if (record?.base_commit !== assignment?.base_commit) errors.push("Evidence base_commit differs from assignment");
  if (stage === "integration") {
    if (!sha(record?.integration_commit)) errors.push("Acceptance needs integration_commit SHA");
    if (record?.head_commit !== task.raw.handoff_commit) errors.push("Acceptance refers to a different Worker commit");
    if (!filled(record?.reviewed_by) || !filled(record?.review_notes)) errors.push("Manager review identity and notes are required");
  }
  const expectedCommit = stage === "integration" ? record?.integration_commit : record?.head_commit;
  const checks = record?.checks;
  if (!Array.isArray(checks) || !checks.length) errors.push("Evidence requires nonempty checks");
  else {
    for (const requirement of task.verification) if (!checks.some(c => c?.requirement === requirement && c.result === "passed")) errors.push(`Unverified requirement: ${requirement}`);
    for (const c of checks) {
      if (!c || c.commit !== expectedCommit || c.result !== "passed" || !filled(c.cwd)) errors.push("Check result/commit/cwd is missing, failed or stale");
      if (c?.kind === "command") {
        if (!filled(c.command) || c.exit_code !== 0) errors.push("Command check must record command and zero exit_code");
      } else if (c?.kind === "manual") {
        if (!filled(c.observation)) errors.push("Manual check requires observation");
      } else errors.push("Check kind must be command or manual");
      if (!filled(c?.evidence)) errors.push("Each check requires a local evidence file");
      else try {
        const relative = normalizeRelativePath(c.evidence);
        if (!(await stat(path.join(root, relative))).isFile()) throw new Error("not a file");
      } catch (e) { errors.push(`Evidence file invalid: ${c.evidence}: ${e.message}`); }
    }
  }
  if (stage === "integration") {
    const acceptance = record?.acceptance;
    if (!Array.isArray(acceptance)) errors.push("Acceptance records required");
    else for (const criterion of task.acceptance) {
      const item = acceptance.find(c => c?.criterion === criterion && c.result === "passed" && filled(c.evidence));
      if (!item) errors.push(`Acceptance criterion not verified: ${criterion}`);
      else try { if (!(await stat(path.join(root,normalizeRelativePath(item.evidence)))).isFile()) throw new Error("not a file"); }
      catch (e) { errors.push(`Acceptance evidence missing/invalid: ${item.evidence}`); }
    }
  }
  return { valid: !errors.length, errors, note: "Declarations and evidence files are checked; commands are not executed and semantic correctness remains a Manager review." };
}

export async function readHandoffRecord(root, task) {
  try { return JSON.parse(await readFile(evidencePath(root, task.id), "utf8")); }
  catch (error) { throw new Error(`Cannot read structured handoff for '${task.id}': ${error.message}`); }
}

export async function auditGit(root, task, worktree) {
  const record = await readHandoffRecord(root, task);
  const result = await validateRecord(root, task, record);
  if (!result.valid) return result;
  const git = async (...args) => (await exec("git", ["-C", path.resolve(worktree), ...args], { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  await git("cat-file", "-e", `${record.head_commit}^{commit}`);
  await git("merge-base", "--is-ancestor", record.base_commit, record.head_commit);
  const files = (await git("diff", "--name-only", "--no-renames", "-z", record.base_commit, record.head_commit)).split("\0").filter(Boolean);
  const scopes = [...task.allowed_paths, `docs/coordination/handoffs/${task.id}.md`, `docs/coordination/evidence/${task.id}/**`];
  for (const file of files) if (!scopes.some(scope => scopeContains(scope, file))) result.errors.push(`Git change outside scope: ${file}`);
  result.valid = !result.errors.length;
  return { ...result, changed_files: files, audited_commit: record.head_commit, working_tree_status: await git("status", "--porcelain"), note: "Audits the recorded commit range only. Uncommitted changes are reported separately; no checkout, commit or merge is performed." };
}
