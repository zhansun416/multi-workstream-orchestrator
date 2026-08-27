---
name: multi-workstream-orchestrator
description: Start and run a complex software or research-tool project through a Manager-led workflow. Use when the user asks to plan a new project, divide it into stable modules, create and coordinate long-lived development task windows, manage dependencies, or maintain cross-session project state. Do not use for one-off edits, simple bug fixes, or research-only tasks.
---

# Multi-Workstream Orchestrator (MSO)

MSO is a reusable project workflow, not a domain skill. It turns a new complex project into a stable architecture, then coordinates narrowly scoped long-lived development windows until each milestone is integrated and verified.

The objective is **visible, verified delivery with clear ownership**, not maximum agent or window count.

## Runtime-assisted operation

MSO works with or without the optional local Runtime. When Runtime is available, the Manager uses it first for deterministic coordination work:

```text
status
ready
wave
task
context
handoff validate
transition
```

Runtime, not LLM reasoning, determines whether declared dependencies are satisfied, which tasks are ready, explicit or writable-path conflicts, a declaration-ordered safe execution wave, legal state transitions, and handoff structural completeness. The Manager still decides project intent, architecture, modules, shared contracts, priority, risk, Worker creation, design changes, semantic review, and final acceptance.

`docs/coordination/task-dag.yaml` is the persisted task-status source of truth. `docs/coordination/STATE.md` is a human-readable project summary, not a second task state machine.

If Runtime is unavailable, the Manager performs the same checks manually and records the result in the coordination files. Runtime is an accelerator, never a prerequisite for using MSO.

## Operating model

```text
Manager only
  → discover and architect
  → freeze module boundaries and shared contracts
  → create formal development windows
  → schedule task waves
  → integrate, verify, archive, repeat
```

Roles:

- **Manager**: the single visible control window. Owns project direction, shared contracts, architecture, module registry, task DAG, window creation, scheduling, integration, and final acceptance. It does not implement a Worker's business module.
- **Worker**: a long-lived, visible development task window created by the Manager after module boundaries are clear. It only changes its authorized module and produces verification evidence plus a handoff.
- **Reviewer / QA**: a responsibility, not a default extra window. Use an existing QA-oriented Worker when one exists; otherwise the Manager performs cross-module review.

## Non-negotiable rules

1. Do **not** create research, experiment, prototype, or temporary-debug windows. The Manager performs those activities itself.
2. Do **not** create Worker windows before architecture, module boundaries, and shared contracts are sufficiently clear.
3. Create a Worker only when its module has stable responsibility, continuing work, a clear writable scope, defined inputs/outputs, and independently testable acceptance criteria.
4. A Worker may not modify another Worker's files, the module registry, or shared contracts. It must submit a change request to the Manager instead.
5. Do not parallelize tasks that share a writable directory, shared schema, public interface, or unresolved upstream dependency.
6. A formal Worker task is not complete until it includes reproducible validation evidence and a handoff; a verbal completion claim is insufficient. Only a lightweight/Fast Path task that explicitly sets `handoff_required: false` may omit a handoff, while still recording its validation evidence in the task card.
7. Treat project files as the source of truth. Chat history is supporting context only.
8. Use Git/worktrees before simultaneous code writes in multiple windows. Without isolation, allow only one writer in a shared working directory.

## When to activate

Use MSO for a new project or a substantial new program of work when at least one is true:

- the project needs three or more stable development modules;
- the user asks for a Manager and module task windows;
- multiple features have dependencies or integration risk;
- the work will last across several sessions or milestones.

For a simple feature or bug fix, use a short plan and normal implementation instead. Do not impose the full MSO artifact set.

## Phase 0 — Discover (Manager only)

Before creating a Worker, establish:

- problem, users, and intended outcome;
- measurable success criteria;
- non-goals and constraints;
- the smallest user-visible vertical result;
- key technical, licensing, data, or integration risks.

Ask only questions that materially affect project direction. Make reasonable, reversible assumptions when possible. Do not open child windows in this phase.

Create or update `docs/coordination/CONSTITUTION.md` and `docs/coordination/STATE.md` using the templates in [references/templates.md](references/templates.md).

## Phase 1 — Architect and register modules (Manager only)

Define:

- system boundaries and major data/control flows;
- shared entities, schemas, and interface versioning;
- candidate modules and their dependencies;
- each module's owner, writable locations, inputs, outputs, non-goals, and validation method;
- an initial vertical milestone.

Record approved modules in `docs/coordination/module-registry.yaml`.

Do not treat a label as a module merely because it sounds useful. A module earns a Worker window only when it satisfies every Worker creation rule above.

## Phase 2 — Create formal development windows

When the user has explicitly requested multi-window development (including an explicit MSO invocation for that purpose) and the module registry is ready, create one visible Codex task window for each approved Worker.

The initial Worker prompt must include, verbatim in substance:

```text
Project root: <absolute path>
Module: <module name>
Mission: <what it owns>
Writable scope: <directories/files>
Inputs: <contract names and versions>
Outputs: <contract names and versions>
Dependencies: <modules or tasks>
Non-goals: <explicit exclusions>
Rules: do not modify shared contracts or other modules; submit a change request when blocked.
First task: <a ready, bounded task or “read and wait for Manager assignment”>
Acceptance: <tests, visual checks, fixtures, or other evidence>
Handoff: changed files, validation commands/results, known limits, follow-up needs.
```

If the user has not explicitly authorized visible task creation, create the registry and show the proposed Worker list for approval instead. Never create experimental windows as a workaround.

## Phase 3 — Specify and schedule a change

For each substantial feature, the Manager creates `docs/coordination/changes/<feature-id>/` containing:

- `proposal.md`: purpose, scope, non-goals, success conditions;
- `spec.md`: user scenarios and acceptance conditions;
- `design.md`: technical approach, interface changes, risks;
- `tasks.yaml`: tasks and dependencies;
- `evidence/`: tests, screenshots, exports, and acceptance records.

Small, isolated fixes may use **Fast Path**: a task card with scope, allowed paths, verification, and rollback/undo information. Do not require a full change package for a trivial, low-risk correction.

Every task must define:

```yaml
id: feature-01-task-01
owner: module-name
goal: user-visible or contract-level result
allowed_paths: []
inputs: []
outputs: []
depends_on: []
parallel: false
conflicts_with: []
acceptance: []
verification: []
handoff_required: true
```

Task state is:

```text
draft → ready → assigned → in_progress → handoff → review → done
                                   ↘ blocked
```

The Manager constructs implementation waves from `depends_on`, `parallel`, and `conflicts_with`. Prefer a small number of ready tasks over waking every Worker.

When Runtime is available, use its `status`, `ready`, `wave`, and `task` commands instead of independently reasoning through this mechanical DAG calculation.

## Phase 4 — Worker execution

When assigning a ready task, the Manager sends its task card and relevant contract references. The Worker follows this cycle:

1. Read the task, owned boundaries, dependencies, and contract version.
2. Write a concise local implementation plan before changing code.
3. Implement only inside the allowed scope.
4. Run the specified automated, visual, fixture, or manual checks.
5. Review first for specification compliance, then for implementation quality.
6. Write a handoff using the template.
7. Use `handoff validate <task-id>` when Runtime is available; it checks structure, declared evidence, and allowed paths, not semantic correctness.
8. Report `handoff` or `blocked`.

Workers do not choose project priority, expand scope, or silently alter shared contracts.

## Phase 5 — Integrate, verify, and archive

The Manager:

1. reviews Worker handoffs and checks that evidence exists;
2. performs cross-module and user-scenario verification;
3. opens a bounded repair task for failures rather than giving vague feedback;
4. marks the change `done` only when its specification has converged;
5. archives completed change evidence and updates `STATE.md` with decisions, risks, and the next milestone.

When Runtime is available, use `transition` for task state changes. In particular, a `handoff → review` transition validates any required handoff before it proceeds. Runtime does not decide whether review passes: `review → done` remains a Manager decision.

## Keeping the workflow fast

- Keep research and uncertainty resolution in the Manager window.
- Create formal Worker windows once per stable module, not once per task.
- Work toward one small user-visible vertical result per milestone.
- Use Fast Path for narrow work.
- Parallelize only independent, contract-frozen work.
- Put durable decisions and a concise task summary in `STATE.md`; keep persisted task status only in the task DAG so Workers do not repeatedly need background briefings.
- If a task does not produce verifiable progress within its agreed timebox, the Manager reduces scope, resolves the dependency, or stops it.

## What MSO borrows—and deliberately does not require

- From **Spec Kit**: project principles, requirements, plans, tasks, and a final convergence check.
- From **OpenSpec**: a stable baseline separated from in-flight change packages.
- From **CCPM**: dependency-aware tasks, conflicts, blocked status, and Manager tracking.
- From **Superpowers**: plan before implementation, verification evidence, and two-pass review for Worker tasks.
- From **GSD Core**: milestone loops and durable project memory.

MSO does not require installing any of those skills, GitHub Issues, a particular model, Superpowers scripts, or a dedicated QA task window.

## Output at a successful MSO milestone

Report succinctly:

- the milestone and user-visible outcome;
- which modules/windows were created or used;
- completed, blocked, and next tasks;
- verification evidence and unresolved risks;
- links to the updated project state and change package.
