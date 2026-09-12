# Project state

## Current milestone

Runtime v0.2.0 reliability update implemented and locally verified.

## Current user-visible outcome

Managers can safely resume or roll scheduling forward: active work retains write occupancy, assignment rechecks eligibility under a lock, invalid handoffs fail automation, and required contract failures stay visible in Worker context.

## Decisions made

- `task-dag.yaml` remains the sole task-state authority; change-package task files contain only `task_ids` references.
- Runtime derives task views without adding alternate persisted states. `assigned`, `in_progress`, `handoff`, and `review` retain write occupancy.
- Task paths use exact files or `directory/**`. Module scopes exclude protected coordination and contract files while retaining task-specific handoff and evidence exceptions.
- A blocked task resumes to `ready`; `blocked_from` remains as provenance.
- Transitions use a project-local lock, reload and validate inside it, and atomically replace the DAG. Snapshot saves compare both revision and content.
- Review can return to `in_progress` with a reason. Runtime increments `attempt` and supersedes prior evidence.
- New code tasks bind handoff validation to immutable base/head commits and integration verification to the final integration commit. Historical done tasks remain valid without invented metadata.
- Context source records carry inclusion reasons. Required contract versions and pre-read paths remain critical under budget pressure.
- Evidence distinguishes declaration, reference syntax, and local-file existence. Manual and external evidence remain valid structural forms.

## Active tasks

None. The authoritative task DAG contains the completed Runtime v0.1 task history; its change-package `tasks.yaml` now indexes those task IDs without duplicating status.

## Blockers and risks

Runtime checks declared local records and structure. It does not execute Git, tests, or semantic acceptance. The YAML writer does not preserve comments after an explicit state write. A lock timeout requires the Manager to verify that no transition is active before removing a proven orphaned lock.

## Next Manager action

Exercise v0.2.0 on an existing coordinated project and use the documented resume audit before assigning the next wave.
