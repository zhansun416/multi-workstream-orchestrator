import { normalizeRelativePath } from "./loader.js";

export function pathsMayOverlap(left, right) {
  const a = staticPrefix(normalizeRelativePath(left));
  const b = staticPrefix(normalizeRelativePath(right));
  if (!a || !b) return true;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function checkConflicts(taskA, taskB) {
  if (taskA.id === taskB.id) return [];
  const reasons = [];
  if (taskA.conflicts_with.includes(taskB.id) || taskB.conflicts_with.includes(taskA.id)) reasons.push("explicit_conflict");
  if (taskA.owner === taskB.owner) reasons.push("same_owner");
  for (const left of taskA.allowed_paths) for (const right of taskB.allowed_paths) {
    if (pathsMayOverlap(left, right)) reasons.push(`path_conflict:${left}:${right}`);
  }
  return reasons;
}

function staticPrefix(pattern) {
  const parts = [];
  for (const part of pattern.split("/")) {
    if (/[?*[]/.test(part)) break;
    parts.push(part);
  }
  return parts.join("/");
}
