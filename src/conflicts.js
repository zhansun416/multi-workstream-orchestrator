import { normalizeRelativePath } from "./loader.js";
import path from "node:path";

export function pathsMayOverlap(left, right) {
  const a = staticPrefix(normalizeRelativePath(left)).toLowerCase();
  const b = staticPrefix(normalizeRelativePath(right)).toLowerCase();
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function checkConflicts(taskA, taskB) {
  if (taskA.id === taskB.id) return [];
  const reasons = [];
  if (taskA.conflicts_with.includes(taskB.id) || taskB.conflicts_with.includes(taskA.id)) reasons.push("explicit_conflict");
  if (taskA.owner === taskB.owner) reasons.push("same_owner");
  for (const resource of taskA.resources ?? []) if ((taskB.resources ?? []).includes(resource)) reasons.push(`resource_conflict:${resource}`);
  const a = taskA.raw?.assignment, b = taskB.raw?.assignment;
  if (a?.thread_id && a.thread_id === b?.thread_id) reasons.push("same_worker");
  if (a?.worktree && b?.worktree && canonical(a.worktree) === canonical(b.worktree)) reasons.push("same_worktree");
  for (const left of taskA.allowed_paths) for (const right of taskB.allowed_paths) {
    if (pathsMayOverlap(left, right)) reasons.push(`path_conflict:${left}:${right}`);
  }
  return reasons;
}

function canonical(value) { const p = path.resolve(value); return process.platform === "win32" ? p.toLowerCase() : p; }

function staticPrefix(pattern) {
  const parts = [];
  for (const part of pattern.split("/")) {
    if (/[?*[]/.test(part)) break;
    parts.push(part);
  }
  return parts.join("/");
}
