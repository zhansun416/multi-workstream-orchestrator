# Multi-Workstream Orchestrator

MSO is a governance workflow for substantial multi-module work. Runtime v0.2.0 is its intentionally small, local implementation aid.

```text
Skill   = Policy
Runtime = Deterministic execution checks
Agent   = Intelligent Manager or Worker
```

The [MSO Skill](SKILL.md) defines Manager ownership, stable Worker windows, module boundaries, task handoffs, integration, and acceptance. Runtime reads the coordination files and mechanically checks dependencies, owners, path scopes, active conflicts, state transitions, contracts, handoffs, and bounded context. The Manager still decides intent, architecture, priority, risk, semantic correctness, and final acceptance.

Runtime does not start Agents, call model APIs, create worktrees, run Git or arbitrary commands, merge work, run a service, or provide a web UI.

## Requirements and local development

Node.js 20 or newer is required.

```bash
npm install
npm test
```

When the skill is installed elsewhere, invoke the Runtime by its absolute installed path and pass the target project explicitly. Do not assume the target project contains `src/cli.js`.

```bash
MSO_RUNTIME=/absolute/path/to/multi-workstream-orchestrator/src/cli.js
PROJECT_ROOT=/absolute/path/to/target-project
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" status
```

If Runtime cannot be loaded, the Manager may perform the same checks manually and record them. Once Runtime runs and reports an error, the error is a failed gate to resolve; it is not an “unavailable Runtime” fallback case.

## Coordination contract

`docs/coordination/task-dag.yaml` is the sole persisted task-state authority. Change-package `tasks.yaml` files contain only `task_ids` that reference this DAG. `STATE.md` is a human-readable summary.

The DAG has a monotonically increasing `revision`. State transitions acquire a project-local lock, reload and validate inside the lock, then write a temporary file and atomically rename it. The public snapshot save also checks the numeric revision and an exact content hash, so a stale snapshot cannot overwrite a Runtime transition or an unversioned manual edit. MSO still assumes a single Manager serializes coordination writes; this is not a distributed store. After a lock timeout, confirm that no Manager or transition is still running before removing a proven orphaned `.lock` file; Runtime never deletes a contended lock automatically.

Persisted status transitions are:

```text
draft → ready → assigned → in_progress → handoff → review → done
                              ↘ blocked → ready       ↘ in_progress (reasoned rework)
```

`assigned`, `in_progress`, `handoff`, and `review` all retain their task's write occupancy. A `ready → assigned` transition rechecks the same eligibility used by `ready` and `wave`: dependencies, owner availability, required contracts, `parallel`, explicit conflicts, owner conflicts, and effective write paths. An active `parallel: false` task excludes every new assignment; a ready `parallel: false` task can form a wave only when no task is active.

`wave` returns both the selected tasks and excluded task IDs with reasons. A wave is a current recommendation, so assignment always rechecks eligibility under the lock.

## Owners and path permissions

Task owners use one of two explicit forms:

- `owner_type: module` is the default. `owner` must name a registered module, that module must be available for assignment, and every task `allowed_paths` entry must fit inside its `writable_paths`.
- `owner_type: manager` is an explicit Manager task. It does not turn an unknown or misspelled module name into a Manager exception; its writable scope is still limited by its task card.

Paths support only exact project-relative files such as `README.md` and directory scopes ending in `/**`, such as `packages/backend/**`. Other glob syntax is rejected. Task IDs are safe single path segments because they are used to derive coordination output paths.

For module tasks, registered contract files and `docs/coordination/**` are protected even when a broad scope such as `docs/**` contains them. Each task receives only these protected-path exceptions:

- `docs/coordination/handoffs/<task-id>.md`
- `docs/coordination/evidence/<task-id>/**`
- when `change_id` is present, `docs/coordination/changes/<change-id>/evidence/<task-id>/**`

These effective exceptions participate in conflict checking. A Manager task that writes the same coordination area therefore conflicts with the Worker task.

## Contracts and context budgets

Every task input and output names a registered contract and version. A contract is usable when its registered file exists or the registry declares a non-empty summary form. Missing registries, versions, files, and sources appear as distinct assignment reasons and Worker-context warnings.

Worker context always keeps a critical contract reference with its version, source status, summary when available, source path, and a required pre-read instruction. The full body may be omitted under a tight character budget, but the obligation and path remain. Acceptance criteria, effective writable boundaries, and coordination exceptions are also critical.

## Handoffs, rework, and integration

The validator checks the handoff title and sections, changed-file permissions, declared verification, and evidence. Evidence reports three separate facts: declaration, reference syntax, and local-file existence. Manual evidence and external URLs remain allowed structural evidence; URLs are not fetched.

An invalid standalone validation returns JSON with `error.code: HANDOFF_INVALID` and exits with status 1. Runtime or usage failures return a stable JSON error object and status 2.

Review failure returns the same task to `in_progress` with `--reason`. Runtime increments `attempt`, marks prior evidence superseded, and requires the next handoff to identify the current attempt. A separate repair task is reserved for genuinely separate scope.

New task cards must declare `delivery.kind` as `code`, `artifact`, or `manual`. A code task must require a handoff. Its first and later handoffs add:

```markdown
## Delivery identity

- attempt: 1
- base_commit: <full 40- or 64-hex commit id>
- head_commit: <full 40- or 64-hex commit id>
- worktree: /absolute/path/to/worktree
- branch: optional-branch-name
```

Its `Validation performed` section uses these structured entries:

```markdown
- command: npm test
- working_directory: /absolute/path/to/worktree
- exit_code: 0
- head_commit: <same delivered head_commit>
```

Before `review → done`, the Manager integrates the delivery, verifies the integrated version, and records both against the same immutable commit:

```bash
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" transition <task-id> done \
  --integration-commit <full-commit-id> \
  --verification-commit <same-full-commit-id> \
  --integration-verification "npm test passed in the integration worktree"
```

Runtime checks this record's structure and version equality. It does not inspect Git or run the command. The Manager checks the actual diff and decides whether the evidence meets acceptance.

For `artifact` or `manual` Fast Path tasks with `handoff_required: false`, `handoff → review` records current evidence with `--validation-evidence "<summary>"`. Legacy task cards remain readable; historical done tasks are not forced to invent delivery metadata.

## CLI

```bash
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" status
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" ready
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" wave
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" task <task-id>
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" context manager
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" context worker <task-id>
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" context reviewer <task-id>
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" handoff validate <task-id>
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" transition <task-id> assigned
node "$MSO_RUNTIME" --root "$PROJECT_ROOT" transition <task-id> in_progress --reason "review finding"
```

The CLI emits JSON by default. `--json` remains an accepted compatibility flag.

## Development fixture

The sample project under `tests/fixtures/sample_project` exercises backend, frontend, admin, and documentation modules. Its expected first wave contains `backend-01` and `docs-01`; `frontend-01` waits on `backend-01`, while the nested admin task is excluded by its backend path conflict. The fixture keeps legacy task cards deliberately so backwards compatibility remains covered.
