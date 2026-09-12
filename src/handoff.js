import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath } from "./paths.js";
import { checkTaskFilePermission } from "./permissions.js";

const requiredSections = [
  "Result",
  "Changed files",
  "Contract impact",
  "Validation performed",
  "Evidence locations",
  "Known limits / risks",
  "Suggested next action",
];

export async function validateHandoff(root, task) {
  const file = path.join(root, "docs", "coordination", "handoffs", `${task.id}.md`);
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return result([detail("HANDOFF_FILE_MISSING", `Handoff does not exist: ${file}`)], [], emptyEvidence(), null);
    }
    throw error;
  }

  const errors = [];
  const warnings = [];
  if (!new RegExp(`^# Handoff: ${escapeRegex(task.id)}\\s*$`, "m").test(content)) {
    errors.push(detail("HANDOFF_TITLE_INVALID", `Handoff title must be exactly '# Handoff: ${task.id}'.`));
  }
  const sections = markdownSections(content);
  for (const section of requiredSections) {
    if (!sections.get(section)?.trim()) errors.push(detail("HANDOFF_SECTION_MISSING", `Missing or empty required section: ${section}`, { section }));
  }

  const changed = listEntries(sections.get("Changed files") ?? "");
  if (!changed.length) errors.push(detail("HANDOFF_CHANGED_FILES_MISSING", "Changed files must explicitly list paths or '(none)'."));
  for (const item of changed.filter((entry) => entry !== "(none)")) {
    try {
      const permission = checkTaskFilePermission(task, item);
      if (!permission.allowed) {
        const code = permission.reason === "protected_project_path" ? "CHANGED_FILE_PROTECTED" : "CHANGED_FILE_OUT_OF_SCOPE";
        const message = permission.reason === "protected_project_path"
          ? `Changed file is a protected project path: ${permission.file}`
          : `Changed file outside allowed_paths: ${permission.file}`;
        errors.push(detail(code, message, {
          path: permission.file,
          reason: permission.reason,
        }));
      }
    } catch (error) {
      errors.push(detail("CHANGED_FILE_INVALID", `Invalid changed file '${item}': ${error.message}`, { path: item }));
    }
  }

  if (!task.verification.length) {
    errors.push(detail("TASK_VERIFICATION_MISSING", `Task '${task.id}' has no verification requirements.`));
  }
  if (!task.acceptance.length) warnings.push(`Task '${task.id}' has no acceptance criteria.`);
  const evidence = await validateEvidence(root, listEntries(sections.get("Evidence locations") ?? ""));
  if (!evidence.declared) errors.push(detail("EVIDENCE_NOT_DECLARED", "Evidence locations must declare at least one path, URL, or manual verification."));
  errors.push(...evidence.error_details);
  if (evidence.external_references.length) warnings.push("External evidence URLs are syntactically valid but were not fetched.");

  const delivery = validateDelivery(task, sections, errors);
  return result(errors, warnings, evidence, delivery);
}

function validateDelivery(task, sections, errors) {
  const identityText = sections.get("Delivery identity");
  if (!identityText?.trim() && (task.delivery_kind === "code" || task.attempt > 1)) {
    errors.push(detail("DELIVERY_IDENTITY_MISSING", `${task.delivery_kind === "code" ? "Code delivery" : "A retried task"} requires a non-empty Delivery identity section.`));
    return null;
  }
  if (!identityText?.trim()) return null;
  const identity = keyValues(identityText);
  const attempt = Number(identity.attempt);
  if (!identity.attempt) errors.push(detail("DELIVERY_FIELD_MISSING", "Delivery identity requires 'attempt'.", { field: "attempt" }));
  else if (!Number.isInteger(attempt) || attempt !== task.attempt) {
    errors.push(detail("DELIVERY_ATTEMPT_MISMATCH", `Handoff attempt must equal current task attempt ${task.attempt}.`, {
      expected_attempt: task.attempt,
      actual_attempt: identity.attempt,
    }));
  }
  if (task.delivery_kind !== "code") {
    return errors.some((item) => item.code.startsWith("DELIVERY_")) ? null : { attempt };
  }

  const validation = keyValues(sections.get("Validation performed") ?? "");
  for (const key of ["base_commit", "head_commit", "worktree"]) {
    if (!identity[key]) errors.push(detail("DELIVERY_FIELD_MISSING", `Delivery identity requires '${key}'.`, { field: key }));
  }
  for (const key of ["command", "working_directory", "exit_code", "head_commit"]) {
    if (!validation[key]) errors.push(detail("VALIDATION_FIELD_MISSING", `Validation performed requires '${key}' for a code delivery.`, { field: key }));
  }
  for (const key of ["base_commit", "head_commit"]) {
    if (identity[key] && !isCommitHash(identity[key])) {
      errors.push(detail("DELIVERY_COMMIT_INVALID", `Delivery ${key} must be a complete 40- or 64-character hexadecimal commit id.`, { field: key }));
    }
  }
  if (validation.head_commit && !isCommitHash(validation.head_commit)) {
    errors.push(detail("VALIDATION_COMMIT_INVALID", "Validation head_commit must be a complete 40- or 64-character hexadecimal commit id."));
  }
  if (identity.worktree && !path.isAbsolute(identity.worktree)) {
    errors.push(detail("DELIVERY_WORKTREE_NOT_ABSOLUTE", "Code delivery worktree must be an absolute path."));
  }
  if (validation.working_directory && !path.isAbsolute(validation.working_directory)) {
    errors.push(detail("VALIDATION_DIRECTORY_NOT_ABSOLUTE", "Validation working_directory must be an absolute path."));
  }
  if (validation.exit_code && !/^-?\d+$/.test(validation.exit_code)) {
    errors.push(detail("VALIDATION_EXIT_CODE_INVALID", "Validation exit_code must be an integer."));
  }
  if (identity.head_commit && validation.head_commit && identity.head_commit !== validation.head_commit) {
    errors.push(detail("VALIDATION_VERSION_MISMATCH", "Validation must target the delivered head_commit.", {
      delivery_head_commit: identity.head_commit,
      validation_head_commit: validation.head_commit,
    }));
  }
  if (errors.some((item) => item.code.startsWith("DELIVERY_") || item.code.startsWith("VALIDATION_"))) return null;
  return {
    attempt,
    base_commit: identity.base_commit,
    head_commit: identity.head_commit,
    worktree: identity.worktree,
    ...(identity.branch ? { branch: identity.branch } : {}),
    validation: {
      command: validation.command,
      working_directory: validation.working_directory,
      exit_code: Number(validation.exit_code),
      head_commit: validation.head_commit,
    },
  };
}

function result(errorDetails, warnings, evidence, delivery) {
  const valid = errorDetails.length === 0;
  return {
    valid,
    errors: errorDetails.map((item) => item.message),
    error_details: errorDetails,
    warnings,
    evidence,
    delivery,
    error: valid ? null : {
      code: "HANDOFF_INVALID",
      message: "Handoff validation failed.",
      details: errorDetails,
    },
  };
}

function emptyEvidence() {
  return {
    declared: false,
    references_valid: false,
    files_checked: [],
    missing_files: [],
    external_references: [],
    manual_verifications: [],
    invalid_references: [],
    error_details: [],
  };
}

export function markdownSections(content) {
  const matches = [...content.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections = new Map();
  matches.forEach((match, index) => {
    sections.set(match[1].trim(), content.slice(match.index + match[0].length, matches[index + 1]?.index ?? content.length).trim());
  });
  return sections;
}

function listEntries(section) {
  return section
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*+] |\d+\. )/, "").trim().replaceAll("`", ""))
    .filter(Boolean);
}

async function validateEvidence(root, references) {
  const evidence = emptyEvidence();
  evidence.declared = references.length > 0;
  evidence.references_valid = true;
  for (const reference of references) {
    if (reference.toLowerCase().startsWith("manual:")) {
      const description = reference.slice(reference.indexOf(":") + 1).trim();
      if (description) evidence.manual_verifications.push(description);
      else addEvidenceError(evidence, "EVIDENCE_MANUAL_DESCRIPTION_MISSING", "Manual evidence must include a description.");
    } else if (/^https?:\/\/[^/]+/i.test(reference)) {
      evidence.external_references.push(reference);
    } else {
      let relative;
      try {
        relative = normalizeRelativePath(reference);
      } catch (error) {
        addEvidenceError(evidence, "EVIDENCE_REFERENCE_INVALID", `Invalid evidence reference '${reference}': ${error.message}`, { reference });
        continue;
      }
      evidence.files_checked.push(relative);
      try {
        if (!(await stat(path.join(root, relative))).isFile()) throw new Error("reference is not a file");
      } catch {
        evidence.missing_files.push(relative);
        evidence.error_details.push(detail("EVIDENCE_FILE_MISSING", `Evidence file does not exist: ${relative}`, { path: relative }));
      }
    }
  }
  return evidence;
}

function addEvidenceError(evidence, code, message, details) {
  evidence.references_valid = false;
  evidence.invalid_references.push(message);
  evidence.error_details.push(detail(code, message, details));
}

function keyValues(section) {
  const values = {};
  for (const line of section.split("\n")) {
    const match = line.trim().match(/^(?:[-*+]\s+)?([a-z][a-z0-9_]*)\s*:\s*(.+?)\s*$/i);
    if (match) values[match[1].toLowerCase()] = match[2].replaceAll("`", "").trim();
  }
  return values;
}

function detail(code, message, details) {
  return details === undefined ? { code, message } : { code, message, details };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCommitHash(value) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}
