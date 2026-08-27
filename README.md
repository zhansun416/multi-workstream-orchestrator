# Multi-Workstream Orchestrator

MSO is a governance workflow for substantial multi-module work. Runtime v0.1.1 is its intentionally small, local implementation aid.

```text
Skill   = Policy
Runtime = Deterministic Execution Layer
Agent   = Intelligent Worker
```

## What each layer does

- The [MSO Skill](SKILL.md) defines governance: Manager ownership, module boundaries, task handoffs, validation, and acceptance.
- **Runtime v0.1.1** deterministically reads and checks project coordination files: task dependencies, task state, execution conflicts, handoff completeness, and bounded context assembly. When available, the MSO Manager uses it first for these mechanical checks.
- **Agents** make the decisions Runtime must not make: project interpretation, architecture, priorities, contracts, risk, worker creation, design changes, and final acceptance.

Runtime v0.1.1 does **not** start Agents, call model APIs, create worktrees, execute arbitrary shell commands, modify Git, merge work, run a service, or provide a web UI.

## Requirements and install

Node.js 20 or newer is required.

```bash
npm install
npm test
```

## Coordination contract

Runtime reads the target project's coordination files. `docs/coordination/task-dag.yaml` is the sole authority for persisted task state. `STATE.md` remains a human-readable summary rather than a second state machine.

Persisted statuses are:

```text
draft → ready → assigned → in_progress → handoff → review → done
                              ↘ blocked → ready
```

When a task enters `blocked`, Runtime stores `blocked_from` in its task record. In v0.1.1, unblocking always returns it to `ready` and clears the resolved `blocker`, while retaining provenance as the future extension point for a policy that restores the prior state.

`parallel: true` permits a task to share a wave only after dependency, explicit-conflict, writable-path, and owner checks pass. `parallel: false` produces a single-task wave according to declaration order, which is the Manager's priority order.

`conflicts_with` entries must name existing, distinct task IDs. Recommended `allowed_paths` forms are conservative directory scopes such as `src/**`, `packages/backend/**`, and `docs/**`. Runtime v0.1.1 does not claim support for broad `**`, filename-only patterns such as `*.md`, brace expansion, or complex glob semantics.

## CLI

Run commands from a target project root, or pass `--root` explicitly.

```bash
node src/cli.js status
node src/cli.js ready
node src/cli.js wave
node src/cli.js task <task-id>
node src/cli.js context manager
node src/cli.js context worker <task-id>
node src/cli.js context reviewer <task-id>
node src/cli.js handoff validate <task-id>
node src/cli.js transition <task-id> handoff
node src/cli.js --root ../another-project --json status
```

The CLI emits JSON by default in v0.1.1, making it usable by both people and future tool callers. `--json` remains an accepted no-op compatibility flag; no human-readable formatter is provided.

## Context Builder

Manager, Worker, and Reviewer contexts are assembled from only role-relevant sources. Output includes `included_sources` and `omitted_sources`; every included source includes one or more explicit reasons such as `current_task`, `direct_dependency`, `relevant_contract`, or `shared_contract`.

Budgets are character estimates configured in `docs/coordination/runtime.yaml`. Lower-priority sources are omitted first. Acceptance and writable paths are never silently omitted; exceeding a budget to retain a critical source returns a warning.

## Handoff evidence

The validator checks headings, task identity, changed-file scope, verification declarations, and evidence in three distinct layers:

1. **Declared:** at least one evidence item is listed.
2. **Reference-valid:** each item is a safe relative path, an HTTPS/HTTP URL, or `manual: <description>`.
3. **Entity-file exists:** only declared local file references are checked for an existing regular file.

Manual checks and external URLs are valid evidence types; they do not require a local file. URLs are not fetched in v0.1.1.

For a task with `handoff_required: true`, the `handoff → review` transition automatically runs this structural validation and rejects invalid handoffs. With `handoff_required: false`, the transition proceeds without the gate. Runtime never accepts work on this basis; the Manager still decides whether `review → done` is warranted.

## Development

The sample project under `tests/fixtures/sample_project` exercises a backend, frontend, and documentation module. Its expected first wave contains `backend-01` and `docs-01`; `frontend-01` waits on `backend-01`, while a nested backend task is excluded by writable-path conflict.
