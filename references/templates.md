# MSO artifact templates

Use these templates as compact starting points. Adapt them to the project; do not add ceremony without a decision it supports.

## `CONSTITUTION.md`

```markdown
# Project constitution

## Outcome

## Users and success criteria

## Non-goals

## Non-negotiable invariants

## Quality and acceptance standards

## Technology / data / license constraints
```

## `STATE.md`

```markdown
# Project state

## Current milestone

## Current user-visible outcome

## Decisions made

## Active tasks

## Blockers and risks

## Next Manager action
```

## `module-registry.yaml`

```yaml
modules:
  - id: example-module
    name: Example module
    purpose: Stable responsibility owned by this module
    owner_window: pending-or-thread-id
    execution: # optional; fill with actual values and verify on resume
      type: codex-task
      id: task-or-thread-id
      workspace: /absolute/path/to/workspace
      status: active # active | idle | unknown | stopped
      last_confirmed_at: 2026-09-12T00:00:00Z
    writable_paths:
      - packages/example/**
    inputs:
      - SharedContract@v1
    outputs:
      - ExampleResult@v1
    dependencies: []
    non_goals: []
    validation:
      - automated tests
    status: proposed # proposed | approved | active | archived
```

## `task-dag.yaml`

```yaml
revision: 0
tasks:
  - id: milestone-01-task-01
    owner: example-module
    owner_type: module # use manager only for an explicit Manager-owned task
    status: draft
    change_id: milestone-01
    attempt: 1
    goal: A bounded result
    allowed_paths:
      - packages/example/**
    inputs: []
    outputs: []
    depends_on: []
    parallel: false
    conflicts_with: []
    acceptance: []
    verification: []
    handoff_required: true
    delivery:
      kind: code # code | artifact | manual
```

New tasks declare `delivery.kind`. Code tasks always use `handoff_required: true`. A Manager-owned task uses `owner_type: manager`; an unknown module owner never implies Manager ownership.

Use exact project-relative files or directory scopes ending in `/**`. Module tasks cannot write registered contract files or `docs/coordination/**` through a broad scope. Runtime additionally grants only the task's own handoff, `docs/coordination/evidence/<task-id>/**`, and, with `change_id`, `docs/coordination/changes/<change-id>/evidence/<task-id>/**`.

## `changes/<change-id>/tasks.yaml`

```yaml
task_ids:
  - milestone-01-task-01
```

This file is only an index into `task-dag.yaml`; do not copy task definitions or status into it.

## `handoffs/<task-id>.md`

```markdown
# Handoff: <task id>

## Result

## Changed files

## Contract impact

## Validation performed

For a code task, use:

- command: npm test
- working_directory: /absolute/path/to/worktree
- exit_code: 0
- head_commit: <full 40- or 64-hex commit id>

## Evidence locations

## Known limits / risks

## Suggested next action

## Delivery identity

For every code task and every retried task, include the current attempt. Code tasks also include the remaining fields:

- attempt: 1
- base_commit: <full 40- or 64-hex commit id>
- head_commit: <same commit tested above>
- worktree: /absolute/path/to/worktree
- branch: optional-branch-name
```

Artifact and manual tasks omit Git fields. On attempt 2 or later they still include `Delivery identity` with `attempt` so stale evidence cannot be reused.

## `runtime.yaml` contracts

Use a readable versioned file when the contract has normative detail:

```yaml
contracts:
  - id: SharedContract
    version: v1
    path: docs/contracts/shared-contract.md
    summary: Concise constraints retained under context pressure.
```

A summary-only contract is valid when the summary itself is the complete declared contract; omit `path` rather than naming a missing file.
