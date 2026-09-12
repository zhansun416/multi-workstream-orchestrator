import { normalizeRelativePath, scopeAllowsFile } from "./paths.js";

export function checkTaskFilePermission(task, value) {
  const file = normalizeRelativePath(value);
  if (task.coordination_exceptions?.some((scope) => scopeAllowsFile(scope, file))) {
    return { allowed: true, file, reason: "task_coordination_exception" };
  }
  if (!task.allowed_paths.some((scope) => scopeAllowsFile(scope, file))) {
    return { allowed: false, file, reason: "outside_task_allowed_paths" };
  }
  if (task.owner_type !== "manager" && task.protected_paths?.some((scope) => scopeAllowsFile(scope, file))) {
    return { allowed: false, file, reason: "protected_project_path" };
  }
  return { allowed: true, file, reason: "task_allowed_path" };
}
