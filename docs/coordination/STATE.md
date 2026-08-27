# Project state

## Current milestone

Runtime v0.1.1 complete and verified.

## Current user-visible outcome

Managers can use a local CLI to derive safe work from the coordination files without asking an LLM to evaluate DAG dependencies or write conflicts.

## Decisions made

- `task-dag.yaml` is the Runtime state authority; `STATE.md` is a human-readable summary.
- Runtime derives `runnable`, `running`, `waiting`, `blocked`, and `review_required` views without adding alternate persisted states.
- A blocked task resumes to `ready` in v0.1.1. `blocked_from` is retained as provenance and as the future hook for restoring a prior state.
- Context source records include one or more inclusion reasons.
- Evidence distinguishes declaration, syntactic reference validity, and local-file existence. Manual and external evidence do not require a local file.
- Runtime v0.1.1 makes the Skill Runtime-aware, gates required handoffs before review, validates conflict references, and clears resolved blocker text while retaining `blocked_from`.

## Active tasks

See `task-dag.yaml` and `changes/runtime-v0-1/tasks.yaml`.

## Blockers and risks

The YAML writer preserves readable data but does not round-trip comments. v0.1.1 avoids broad file rewriting and only writes the task DAG on explicit transitions.

## Next Manager action

Use the Runtime on a real coordination project and retain findings as input to a deliberately scoped v0.2 proposal.
