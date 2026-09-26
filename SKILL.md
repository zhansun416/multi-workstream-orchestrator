---
name: multi-workstream-orchestrator
description: Plan and coordinate substantial multi-module software or research-tool projects with a Manager, stable module ownership, dependency-aware tasks, isolated worktrees, recoverable assignments, and integrated acceptance. Use for explicitly requested multi-window development or long-running project coordination; not for one-off edits, simple fixes, or research-only tasks.
---

# Multi-Workstream Orchestrator

Deliver a small user-visible milestone through stable module ownership, bounded assignments and verification after integration. The Manager owns architecture, contracts, priority, dispatch, coordination records, integration and acceptance. Workers implement within their assigned scopes and provide evidence. Reviewer/QA is a responsibility; it does not require another task window.

## Start with the right amount of coordination

Use this workflow when dependencies, multiple modules or cross-session continuity justify it. Do not invent three modules or create idle windows merely to follow a template. For a narrow correction use one task card with scope, acceptance and verification; omit separate proposal/design files unless they support an actual decision.

Research, prototypes and uncertainty resolution stay with the Manager. Create a formal Worker only when its module has stable responsibility, continuing work, explicit inputs/outputs, a writable scope and testable acceptance. Preserve existing user authorization. Merely asking to inspect or edit this skill does not authorize starting development task windows.

## Runtime and authoritative state

The bundled **JavaScript Runtime** requires Node.js 20+ and `npm ci` in the skill directory. Use an absolute CLI path and explicit target root:

```text
node <skill>/src/cli.js --root <manager-checkout> check
node <skill>/src/cli.js --root <manager-checkout> status
node <skill>/src/cli.js --root <manager-checkout> wave
```

Runtime checks declared dependencies, reservations, conflicts, transitions, handoffs and commit-bound records. It never creates agents, executes verification commands, writes Git history, merges code, or grants publication authorization. The Manager reviews meaning and actual results. If Runtime is unavailable, perform the same checks manually and record the limitation; do not claim automatic enforcement.

- `docs/coordination/task-dag.yaml` in the **Manager checkout** is the sole task status authority. Only the Manager writes it.
- `module-registry.yaml` records module ownership and Worker bindings. `runtime.yaml` indexes versioned contract files.
- `STATE.md` summarizes outcomes, decisions, blockers and the next action. Link task IDs; do not maintain another status machine.
- Change directories contain requirements/design and a list of task IDs. Do not create another independently maintained `changes/*/tasks.yaml`.
- Worktrees contain separate file copies. A Worker reads the dispatched task/contract snapshot, not an assumed live copy of Manager state.

Read [templates.md](references/templates.md) for the canonical schema and worker prompt. Existing v0.1 projects remain readable; [operations.md](references/operations.md) explains upgrading without losing running assignments.

## 1. Discover and define the first milestone

Establish outcome, users, measurable success, constraints/non-goals, uncertain decisions and the smallest end-to-end result. Ask only questions that affect direction; use reversible assumptions where appropriate. Inspect existing coordination files before creating new ones. Keep reusable decisions in `CONSTITUTION.md` and current facts in `STATE.md`.

Define modules, ownership, shared contracts and the initial dependency graph. Stabilize enough of each interface to implement the first milestone; later contract changes follow an explicit change request. The Manager handles shared glue/configuration and contract changes. A Worker reports cross-module work instead of silently expanding scope.

## 2. Register and reuse Workers

Visible development tasks require an explicit user request for separate/multiple tasks. When authorized, first look for the module's recorded Worker and reuse it if its scope and state still match. Create only Workers needed by ready work. Use available task tools according to their actual schemas: discover the saved project before creating a task, record the real returned task ID, and distinguish setup-pending IDs from usable task IDs. Do not infer creation succeeded from a request alone.

For Git projects use isolated worktrees before concurrent writes. Record each actual execution directory, branch when applicable and starting commit. A new worktree must contain the relevant contracts and integrated prerequisites; Manager's uncommitted files are not automatically available there. For non-Git projects permit only one writer and use documented artifact snapshots with manual verification; commit-bound Runtime gates require Git and must not be filled with invented SHAs.

Maintain one current assignment per Worker. A task returning a response does not prove its assignment is complete. Reuse idle Workers; replace stale Workers only after reconciling pending edits and recording the handover. Do not change the user's chosen model or reasoning settings unless requested.

## 3. Dispatch ready work

Tasks must have a goal, module owner, revision, explicit scope, acceptance, verification, dependencies and conflict/resource declarations. Native supported scopes are exact paths or `directory/**`; no broad wildcard or guessed glob behavior.

Two modules may read the same frozen interface. Prevent simultaneous conflicting **writes**, use of exclusive runtime resources (ports, databases, output directories), duplicate Worker/worktree ownership, and unresolved upstream dependencies. Runtime checks candidates against both the new wave and existing reservations, including blocked/review tasks. Worktree isolation does not eliminate semantic merge conflicts.

Use the workflow in [operations.md](references/operations.md): check → choose wave → verify real execution environment → persist assignment → send task snapshot. The assignment contains a unique dispatch ID, task revision, actual task ID/worktree, base commit and contract versions. A lost response is reconciled against the saved dispatch; do not resend blindly. Set a small project `max_concurrent` and preserve capacity for integration.

Workers may write only task `allowed_paths`, plus their own `docs/coordination/handoffs/<id>.md` and `docs/coordination/evidence/<id>/**`. These reporting grants do not permit editing the DAG, registry, another task's evidence or shared contracts.

## 4. Execute and handle blockers

Workers read the exact assignment and contracts, verify the actual checkout/base, plan briefly, implement, run required checks, inspect the result, then hand off. They do not reprioritize the project or dispatch other Workers. Report the dispatch ID with every handoff/blocker so stale messages can be recognized.

A blocker records what failed, evidence, affected tasks, the required decision and a concrete resume condition. Keep its reservation until the prior writer is confirmed stopped or acknowledges the handoff. Manager resolves it, revises contracts/tasks when needed, increments affected task revisions, and dispatches a fresh assignment. Interface changes name producer/consumers, compatibility/migration, new version and affected tests. Reusing a superseded assignment or evidence is not allowed.

Review failure returns to a bounded repair task/assignment with a reason and updated evidence; it must not cycle indefinitely without a concrete failing acceptance condition. Record a checkpoint and next action if work cannot continue. Do not promise unattended monitoring after the current turn without an explicitly requested, configured automation.

## 5. Integrate and accept

Read [operations.md](references/operations.md) for handoff and integration records. Require a concrete Worker commit and evidence bound to the task revision/dispatch/commit. Record commands, cwd, exit codes, observations and local evidence paths, including checks not run. A markdown heading or a passing log from an old commit is insufficient.

1. Collect the task's handoff/evidence from its actual worktree into the canonical coordination record, without overwriting unrelated records.
2. Run structural handoff validation and `audit <id> --worktree <actual-checkout>`. Inspect the real diff against allowed paths; scope declarations are not a filesystem sandbox.
3. Integrate approved commits in dependency order onto the Manager's integration branch. Record the chosen merge/cherry-pick method and resulting commit. Resolve conflicts as explicit integration work; never replace one Worker's directory wholesale with another copy.
4. Run cross-module tests and the user scenario on the resulting integration commit. Record accepted criteria, verification evidence, Worker head and integration commit.
5. Only the Manager transitions `review → done`. Runtime checks record consistency and file existence; it cannot prove commands were honestly run or judge semantic correctness.

Completion requires integrated, verified work. Pushing, creating PRs, merging a public branch and deployment follow the user's actual authorization; this skill itself grants none. Retain evidence and update the next milestone. Archive a Worker only when its work is integrated or safely handed over; do not delete dirty worktrees to clear a task status.

## Resume an interrupted project

Start with `recover`, not a new planning cycle. Read the canonical DAG/registry, inspect recorded task status through task tools, check actual worktrees, HEADs and dirty files, and reconcile handoffs/contract revisions. Pending assignment, running Worker, finished Worker awaiting integration and missing Worker are different cases. Runtime recovery output is a read-only inventory, not a liveness detector. Remove a stale writer lock only after confirming its process no longer owns the write; preserve a copy first.

Report the milestone outcome, completed/blocked/next tasks, integrated commit and evidence links. Mention concrete limitations; keep internal dispatch mechanics out of routine user summaries.
