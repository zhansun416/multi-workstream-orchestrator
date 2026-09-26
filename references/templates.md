# MSO canonical templates

Use one Manager checkout as the coordination authority. Keep these files small. The DAG is the only persisted task-status store; change documents link IDs from it.

## Project documents

`CONSTITUTION.md`: outcome; users and success criteria; non-goals; invariants; quality/acceptance; technology/data constraints.

`STATE.md`: current milestone and visible outcome; decisions; task-ID links; blockers/risks; last reconciliation time and next Manager action. Status summaries are disposable views of the DAG.

## module-registry.yaml

```yaml
modules:
  - id: backend
    name: Backend
    purpose: API and persistence
    writable_paths: [packages/backend/**]
    inputs: []
    outputs: [BackendApi@v1]
    non_goals: [Frontend implementation]
    validation: [API tests]
    status: approved
    owner_window: null # Real usable task ID after successful setup
    host_id: null
    worktree: null # Actual absolute execution path, not Manager root
    branch: null # May be detached until a branch is needed
```

## runtime.yaml

```yaml
context_budget: {manager: 12000, worker: 8000, reviewer: 10000}
contracts:
  - id: BackendApi
    version: v1
    path: docs/contracts/backend-api.md
    summary: Versioned requests, responses and error semantics
```

## task-dag.yaml

```yaml
schema_version: 2
require_provenance: true
max_concurrent: 3
tasks:
  - id: backend-01
    revision: 1 # Increment when goal, scope, acceptance or contract snapshot changes
    owner: backend
    status: ready
    change_id: milestone-01
    goal: Serve the first documented API request
    allowed_paths: [packages/backend/**]
    inputs: []
    outputs: [BackendApi@v1]
    depends_on: [] # Producer must be integrated and done before consumer dispatch
    parallel: true
    conflicts_with: []
    resources: [test-db:backend-01] # Only exclusive resources; shared reads omitted
    acceptance: [A documented request returns the specified response]
    verification: [Run API tests]
    handoff_required: true
```

States: `draft → ready → assigned → in_progress → handoff → review → done`. `assigned/in_progress/handoff/review → blocked`; `blocked → ready` requires a resolution reason and releases the old assignment after the Manager confirms writer reconciliation. `review → in_progress` requires a repair reason and invalidates the previous handoff commit. Nonterminal tasks may be `cancelled` with a reason; cancellation does not satisfy downstream dependencies. `done/cancelled` are terminal; corrective work gets a new task.

## Assignment JSON (Manager records before sending)

```json
{
  "task_id": "backend-01",
  "task_revision": 1,
  "dispatch_id": "unique-uuid-per-assignment",
  "thread_id": "actual-ready-task-id",
  "worktree": "C:/project-worktrees/backend",
  "base_commit": "FULL_40_CHARACTER_GIT_SHA",
  "contracts": ["BackendApi@v1"],
  "assigned_at": "2026-09-26T00:00:00Z"
}
```

Replace sample IDs, dates, paths and SHA with observed values. Assignment/history belongs in the canonical DAG; `transition ... assigned --record <json>` persists it with status in one write.

## Worker prompt

```text
Coordination authority: <Manager root and task-DAG snapshot>
Execution root: <actual Worker worktree>
Task / revision / dispatch: <id, revision, dispatch-id>
Base commit and required integrated dependencies: <SHAs>
Module mission and non-goals: <bounded responsibility>
Allowed implementation paths: <exact paths or directories/**>
Reporting grant: docs/coordination/handoffs/<id>.md and docs/coordination/evidence/<id>/**
Contracts: <versions and supplied contents/commit references>
Acceptance and required verification: <from task card>
Rules: verify checkout before writing; do not modify shared state/contracts; report blockers to Manager.
Handoff: changed files, actual commit, commands/cwd/exit codes, evidence, limitations, next action; echo dispatch ID.
```

## Handoff files

`handoffs/<id>.md` keeps the existing headings: `# Handoff: <id>`, then `## Result`, `Changed files`, `Contract impact`, `Validation performed`, `Evidence locations`, `Known limits / risks`, `Suggested next action`. List actual changed paths (or `(none)`), and explicit verification results/omissions. Coordination reporting files are allowed only for this task.

`evidence/<id>/handoff.json` binds that narrative to code:

```json
{
  "task_id": "backend-01", "task_revision": 1,
  "dispatch_id": "same-assignment-uuid",
  "base_commit": "ASSIGNED_BASE_SHA", "head_commit": "TESTED_WORKER_SHA",
  "checks": [{
    "requirement": "Run API tests", "kind": "command",
    "command": "npm test", "cwd": "C:/project-worktrees/backend",
    "commit": "TESTED_WORKER_SHA", "exit_code": 0, "result": "passed",
    "evidence": "docs/coordination/evidence/backend-01/api-tests.log"
  }]
}
```

For manual verification use `kind: manual` with `observation` instead of command/exit_code. Evidence must be a local regular file. Snapshot/test the implementation commit first, then write its SHA into reporting files; avoid a self-referential commit SHA. Transfer reporting files separately or in a subsequent reporting-only commit, inspect that extra diff, and never hide implementation changes in the reporting commit.

## Integration acceptance JSON

Use the same task/revision/dispatch/base/head fields; add `integration_commit`, `reviewed_by`, `review_notes` and `acceptance: [{criterion, result: "passed", evidence: "relative/file"}]`. Every `checks[].commit` must equal the integration commit, and every task verification/acceptance requirement must be covered. Store Manager acceptance evidence in the canonical project after testing the integration commit. Pass this file to `transition <id> done --record <acceptance.json>`.

## Blocker / interface-change request

Record task/revision/dispatch, failed observation and evidence, affected producer/consumers, requested decision, compatibility impact, proposed contract version, migrations/tests and resume condition. Manager records the decision, updates affected tasks/contracts, increments revisions, collects acknowledgment/stops old assignments, then redispatches. Do not edit in-flight task semantics without that reconciliation.
