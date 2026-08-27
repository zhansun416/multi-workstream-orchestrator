import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath } from "./loader.js";

const requiredSections = ["Result", "Changed files", "Contract impact", "Validation performed", "Evidence locations", "Known limits / risks", "Suggested next action"];

export async function validateHandoff(root, task) {
  const file = path.join(root, "docs", "coordination", "handoffs", `${task.id}.md`);
  let content;
  try { content = await readFile(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return result([`Handoff does not exist: ${file}`], [], emptyEvidence());
    throw error;
  }
  const errors = [];
  const warnings = [];
  if (!new RegExp(`^# Handoff: ${escapeRegex(task.id)}\\s*$`, "m").test(content)) errors.push(`Handoff title must be exactly '# Handoff: ${task.id}'.`);
  const sections = markdownSections(content);
  for (const section of requiredSections) if (!sections.get(section)?.trim()) errors.push(`Missing or empty required section: ${section}`);
  const changed = listEntries(sections.get("Changed files") ?? "");
  if (!changed.length) errors.push("Changed files must explicitly list paths or '(none)'.");
  for (const item of changed.filter((item) => item !== "(none)")) {
    try {
      const filePath = normalizeRelativePath(item);
      if (!task.allowed_paths.some((scope) => isAllowed(filePath, scope))) errors.push(`Changed file outside allowed_paths: ${filePath}`);
    } catch (error) { errors.push(`Invalid changed file '${item}': ${error.message}`); }
  }
  if (!task.verification.length) errors.push(`Task '${task.id}' has no verification requirements.`);
  if (!task.acceptance.length) warnings.push(`Task '${task.id}' has no acceptance criteria.`);
  const evidence = await validateEvidence(root, listEntries(sections.get("Evidence locations") ?? ""));
  if (!evidence.declared) errors.push("Evidence locations must declare at least one path, URL, or manual verification.");
  errors.push(...evidence.invalid_references);
  errors.push(...evidence.missing_files.map((item) => `Evidence file does not exist: ${item}`));
  if (evidence.external_references.length) warnings.push("External evidence URLs are syntactically valid but were not fetched.");
  return result(errors, warnings, evidence);
}

function result(errors, warnings, evidence) { return { valid: errors.length === 0, errors, warnings, evidence }; }
function emptyEvidence() { return { declared: false, references_valid: false, files_checked: [], missing_files: [], external_references: [], manual_verifications: [], invalid_references: [] }; }

export function markdownSections(content) {
  const matches = [...content.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections = new Map();
  matches.forEach((match, index) => sections.set(match[1].trim(), content.slice(match.index + match[0].length, matches[index + 1]?.index ?? content.length).trim()));
  return sections;
}

function listEntries(section) {
  return section.split("\n").map((line) => line.trim().replace(/^(?:[-*+] |\d+\. )/, "").trim().replaceAll("`", "")).filter(Boolean);
}

function isAllowed(file, scope) {
  const prefix = normalizeRelativePath(scope).split("*")[0].replace(/\/$/, "");
  return file === prefix || file.startsWith(`${prefix}/`);
}

async function validateEvidence(root, references) {
  const evidence = emptyEvidence();
  evidence.declared = references.length > 0;
  evidence.references_valid = true;
  for (const reference of references) {
    if (reference.toLowerCase().startsWith("manual:")) {
      const detail = reference.slice(reference.indexOf(":") + 1).trim();
      if (detail) evidence.manual_verifications.push(detail);
      else { evidence.references_valid = false; evidence.invalid_references.push("Manual evidence must include a description."); }
    } else if (/^https?:\/\/[^/]+/i.test(reference)) evidence.external_references.push(reference);
    else {
      try {
        const relative = normalizeRelativePath(reference);
        evidence.files_checked.push(relative);
        if (!(await stat(path.join(root, relative))).isFile()) throw new Error("reference is not a file");
      } catch (error) {
        const candidate = String(reference);
        if (!evidence.files_checked.includes(candidate)) { evidence.references_valid = false; evidence.invalid_references.push(`Invalid evidence reference '${reference}': ${error.message}`); }
        else evidence.missing_files.push(candidate);
      }
    }
  }
  return evidence;
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
