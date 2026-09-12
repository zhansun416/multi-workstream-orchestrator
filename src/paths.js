import path from "node:path";
import { SchemaError } from "./errors.js";

const unsupportedGlob = /[*?\[\]{}]/;

export function normalizeRelativePath(value) {
  const candidate = String(value ?? "").replaceAll("\\", "/").trim();
  if (!candidate || candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate)) {
    throw new SchemaError(`Path must be project-relative: ${value}`, { code: "PATH_NOT_RELATIVE" });
  }
  if (unsupportedGlob.test(candidate)) {
    throw new SchemaError(`Path must name an exact file and cannot contain glob syntax: ${value}`, { code: "PATH_GLOB_UNSUPPORTED" });
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new SchemaError(`Path traversal is not allowed: ${value}`, { code: "PATH_TRAVERSAL" });
  }
  return normalized;
}

export function parsePathScope(value) {
  const candidate = String(value ?? "").replaceAll("\\", "/").trim();
  const directory = candidate.endsWith("/**");
  const base = directory ? candidate.slice(0, -3) : candidate;
  const normalized = normalizeRelativePath(base);
  return { kind: directory ? "directory" : "file", path: normalized, value: directory ? `${normalized}/**` : normalized };
}

export const normalizePathScope = (value) => parsePathScope(value).value;

export function scopeContains(containerValue, candidateValue) {
  const container = scope(containerValue);
  const candidate = scope(candidateValue);
  if (container.kind === "file") return candidate.kind === "file" && candidate.path === container.path;
  return candidate.path === container.path || candidate.path.startsWith(`${container.path}/`);
}

export function scopeAllowsFile(scopeValue, fileValue) {
  const allowed = scope(scopeValue);
  const file = normalizeRelativePath(fileValue);
  return allowed.kind === "file" ? file === allowed.path : file === allowed.path || file.startsWith(`${allowed.path}/`);
}

export function scopesOverlap(leftValue, rightValue) {
  const left = scope(leftValue);
  const right = scope(rightValue);
  if (left.kind === "file" && right.kind === "file") return left.path === right.path;
  if (left.kind === "directory" && right.kind === "directory") {
    return left.path === right.path || left.path.startsWith(`${right.path}/`) || right.path.startsWith(`${left.path}/`);
  }
  const directory = left.kind === "directory" ? left : right;
  const file = left.kind === "file" ? left : right;
  return file.path === directory.path || file.path.startsWith(`${directory.path}/`);
}

function scope(value) {
  return value && typeof value === "object" && value.kind && value.path ? value : parsePathScope(value);
}
