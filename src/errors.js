export class RuntimeError extends Error {
  constructor(message, { code = "RUNTIME_ERROR", details } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class SchemaError extends RuntimeError {
  constructor(message, options = {}) { super(message, { code: "SCHEMA_INVALID", ...options }); }
}

export class DependencyError extends SchemaError {
  constructor(message, options = {}) { super(message, { code: "DAG_DEPENDENCY_INVALID", ...options }); }
}

export class TransitionError extends RuntimeError {
  constructor(message, options = {}) { super(message, { code: "TRANSITION_INVALID", ...options }); }
}

export class RevisionConflictError extends RuntimeError {
  constructor(message, options = {}) { super(message, { code: "REVISION_CONFLICT", ...options }); }
}

export class LockError extends RuntimeError {
  constructor(message, options = {}) { super(message, { code: "DAG_LOCK_TIMEOUT", ...options }); }
}
