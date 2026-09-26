# Multi-Workstream Orchestrator

MSO coordinates substantial multi-module work through a Manager, stable Worker ownership, explicit dependencies and verification after integration. Runtime **v0.2.0** supplies deterministic checks; the Manager makes architectural and acceptance decisions.

## Install and run

Node.js 20+ is required for the optional JavaScript Runtime. Copy this package to your skill directory, then run `npm ci` there. The skill can operate manually if Runtime is unavailable, with its limitations recorded.

```text
npm ci
npm test
node src/cli.js --root tests/fixtures/sample_project check
node src/cli.js --root tests/fixtures/sample_project wave
node src/cli.js --root <manager-checkout> recover
```

When running outside this package, use an absolute path to `src/cli.js` and an explicit `--root`. The root is the canonical Manager checkout, not an arbitrary Worker copy.

## What changed in v0.2

- Ready waves and direct assignments check existing reservations, dependencies, exclusive resources, Worker/worktree reuse and concurrency limits.
- DAG writes use a lock, stale-snapshot check and atomic replacement. Only one Manager owns the canonical state.
- Assignments bind task revision, dispatch ID, real task ID, actual worktree, base commit and contract versions.
- Structured handoffs and integration acceptance bind verification evidence to exact code commits. Rejected handoff commits cannot be reused as repair evidence.
- `audit` checks actual Git changes against declared scope; omitted files in a narrative cannot bypass that check.
- `recover` produces a read-only reconciliation inventory; it does not automatically resend work or decide whether an agent is alive.
- Worker reporting paths are explicitly allowed per task, separate from implementation scope and Manager-owned coordination files.
- Cancellation, blocked resolution, repair reasons and assignment history are recorded.
- Validation commands return nonzero when checks fail.

## Commands

```text
status
ready
wave
task <id>
check
recover
context manager
context worker <id>
context reviewer <id>
handoff validate <id>
audit <id> --worktree <actual-checkout>
transition <id> assigned --expect-revision 1 --record <assignment.json>
transition <id> in_progress
transition <id> blocked --blocker "decision required and resume condition"
transition <id> ready --reason "decision resolved and prior writer stopped"
transition <id> handoff
transition <id> review
transition <id> done --record <acceptance.json>
```

Use `node src/cli.js --root <project> <command>`. JSON is the default; `--json` is accepted for compatibility. Exit codes: 0 success, 1 validation failure, 2 invalid input/execution failure. `ready` filters dependency/reservation conflicts; `wave` also applies capacity and chooses declaration-ordered compatible tasks. A wave is a proposal, not an atomic batch dispatch: each assignment rechecks current state.

## State and evidence

`docs/coordination/task-dag.yaml` is the sole task-state authority. `STATE.md` is a human summary; change documents link task IDs instead of duplicating statuses. Use `require_provenance: true` in new Git projects and `max_concurrent` (default 3). Existing projects without provenance mode remain readable with a warning; migrate running work by observing real assignments and commits first.

Supported write scopes are exact relative paths or `directory/**`. Broad/complex globs fail explicitly. Workers may additionally write only their own handoff and evidence directory. Conflicts are conservative and case-insensitive; actual changed-file scope checks use exact names. Shared frozen interface reads are allowed; write/contract changes require Manager coordination.

Markdown handoffs retain their existing headings. Provenance mode adds a task-specific `handoff.json` with command/manual evidence and Worker commit. Final acceptance records Manager review and the tested integration commit. Local evidence file existence and record consistency are checked; logs are not executed or judged for truth. See [templates](references/templates.md) and [operational procedure](references/operations.md).

## Boundaries

Runtime does not create tasks/worktrees, call model APIs, execute declared test commands, commit, merge, deploy or run a background service. `audit` runs fixed read-only Git commands through argument arrays. Scope declarations are not OS isolation; Manager must inspect actual Workers, dirty files, contracts and integration behavior. No-Git projects use a documented single-writer manual workflow rather than invented commit identifiers.

Context is role-scoped with explicit included/omitted sources. Critical task fields survive character-budget pressure; omitted contract contents must be retrieved before implementation. Worker context distinguishes coordination root from execution root.

## Verification

`npm test` covers schema/dependency failures, active reservations, resource/capacity conflicts, state transactions, stale evidence, repair/reassignment, context, CLI failures and a real disposable Git repository with an unauthorized change. No live Worker task is started by the tests.

The sample project has backend, frontend, documentation and admin owners. Backend and documentation can run first; frontend waits for integrated backend work, and admin waits on the conflicting backend scope. [SKILL.md](SKILL.md) is the agent workflow entry point.
