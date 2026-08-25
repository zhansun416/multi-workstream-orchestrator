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
tasks:
  - id: milestone-01-task-01
    owner: example-module
    status: draft
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
```

## `handoffs/<task-id>.md`

```markdown
# Handoff: <task id>

## Result

## Changed files

## Contract impact

## Validation performed

## Evidence locations

## Known limits / risks

## Suggested next action
```
