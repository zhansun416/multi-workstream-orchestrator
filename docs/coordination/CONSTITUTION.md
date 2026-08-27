# Project constitution

## Outcome

Deliver a small, local Runtime v0.1 that deterministically handles the mechanical parts of MSO governance while leaving design, priority, risk, and acceptance decisions to the Manager Agent.

## Users and success criteria

MSO Managers can inspect a task DAG, derive safe execution waves, make legal state transitions, validate handoff completeness, and assemble bounded role-specific context using a Node.js CLI. Every result is reproducible from project files.

## Non-goals

No Agent lifecycle management, OpenAI API calls, worktree or Git automation, shell execution, service process, database, queue, web UI, or distributed Runtime belongs in v0.1.

## Non-negotiable invariants

- `SKILL.md` remains the policy source of truth.
- `docs/coordination/task-dag.yaml` is the sole Runtime authority for task state.
- Runtime makes deterministic checks only; Manager judgment remains outside the code.
- Runtime never silently drops acceptance criteria or writable paths from role context.

## Quality and acceptance standards

The CLI is testable with fixtures, invalid DAGs fail explicitly, and all writes are limited to the task DAG state fields requested by the user.

## Technology / data / license constraints

Node.js 20+ with the `yaml` package. Runtime operates only on local project files.
