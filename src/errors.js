export class RuntimeError extends Error {}
export class SchemaError extends RuntimeError {}
export class DependencyError extends SchemaError {}
export class TransitionError extends RuntimeError {}
