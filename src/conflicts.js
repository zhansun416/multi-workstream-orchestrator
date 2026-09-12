import { scopesOverlap } from "./paths.js";

export function pathsMayOverlap(left, right) {
  return scopesOverlap(left, right);
}

export function checkConflicts(taskA, taskB) {
  if (taskA.id === taskB.id) return [];
  const reasons = [];
  if (taskA.conflicts_with.includes(taskB.id) || taskB.conflicts_with.includes(taskA.id)) reasons.push("explicit_conflict");
  if (taskA.owner === taskB.owner) reasons.push("same_owner");
  for (const left of taskA.allowed_paths) for (const right of taskB.allowed_paths) {
    if (pathsMayOverlap(left, right)) reasons.push(`path_conflict:${left}:${right}`);
  }
  for (const left of taskA.coordination_exceptions ?? []) {
    for (const right of taskB.coordination_exceptions ?? []) if (pathsMayOverlap(left, right)) reasons.push(`path_conflict:${left}:${right}`);
    if (taskB.owner_type === "manager") {
      for (const right of taskB.allowed_paths) if (pathsMayOverlap(left, right)) reasons.push(`path_conflict:${left}:${right}`);
    }
  }
  if (taskA.owner_type === "manager") {
    for (const left of taskA.allowed_paths) {
      for (const right of taskB.coordination_exceptions ?? []) if (pathsMayOverlap(left, right)) reasons.push(`path_conflict:${left}:${right}`);
    }
  }
  return [...new Set(reasons)];
}
