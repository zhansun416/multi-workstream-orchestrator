# Dispatch, recovery and integration operations

All commands use `node <skill>/src/cli.js --root <manager-checkout> ...`. Runtime output is JSON; exit 0 indicates a successful check/operation, 1 a failed validation, 2 invalid input or execution failure. Runtime does not send prompts or run verification commands.

## Existing-project migration

1. Preserve current files and read recorded/actual Worker states. Existing `task-dag.yaml` remains canonical.
2. Compare duplicate `changes/*/tasks.yaml` records with actual code/Worker reports. Resolve discrepancies explicitly; replace duplicates with task-ID links. Never silently overwrite the canonical state with an older file.
3. Run `check`. Repair unregistered owners, unsupported scopes, missing contract versions or active conflicts. Exact paths and `directory/**` are supported; bare directory scopes no longer implicitly authorize all descendants. Case-insensitive path conflicts are treated conservatively.
4. Add revision numbers, exclusive resources and real Worker bindings. For running legacy work, reconcile its base/head and evidence before adding assignment provenance. Do not invent it to satisfy a check.
5. Enable `require_provenance: true` for new projects and after existing work is reconciled. Legacy mode is backward-compatible with a visible warning; new assignments carrying a provenance record still require bound handoff/acceptance evidence.

Historical `done` tasks are retained; new tasks use the strengthened workflow. A no-Git project must use single-writer manual snapshots and explicitly document why Git provenance cannot be enabled.

## Dispatch transaction

1. `check`, `status`, `wave`: inspect declared dependencies and active reservations. `ready` means dependencies and reservations permit consideration; wave additionally respects `max_concurrent`.
2. Inspect/reuse the recorded Worker. Create a visible task only if already authorized and absent. Create it with a setup/inspection prompt that forbids implementation until assignment, then wait for a usable task ID and actual checkout. A pending setup identifier is not a live task ID.
3. Inspect actual base commit, clean/dirty state, contract files and integrated dependencies. Copy/commit required snapshots through normal reviewed Git work; new worktrees do not contain Manager's uncommitted coordination edits.
4. Prepare assignment JSON, then `transition <id> assigned --expect-revision <n> --record <assignment.json>` in the Manager checkout. This rechecks dependencies, capacity, active conflicts and provenance before saving.
5. Send the task snapshot, reporting grants, contract contents/versions and acceptance to the actual Worker. On acknowledgment, `transition <id> in_progress`. A communication failure after step 4 leaves a recoverable assignment; read the Worker before retrying. Never allocate another Worker automatically.

Only one Manager mutates canonical state. The Runtime's lock + stale-snapshot check + atomic replace prevents two CLI processes from silently losing each other's updates. It does not coordinate independent copies in different worktrees or arbitrary editor saves. Keep the authority path explicit. A crash lock requires process reconciliation; there is no automatic timeout-based lock stealing.

## Blocked or rejected work

`transition <id> blocked --blocker "reason and resume condition"` retains reservations. Stop or obtain acknowledgment from the old writer before using `transition <id> ready --reason "resolution and writer reconciliation"`; this archives its assignment and allows a new unique dispatch. Update scope/contracts/revision after resolving the old assignment, then dispatch fresh work. Merely waiting a long time is not proof that the writer stopped.

`transition <id> in_progress --reason "specific repair"` from review invalidates the prior handoff commit. A new implementation commit and rerun evidence are required. `cancelled --reason ...` is terminal and does not satisfy a dependency; Manager must revise dependent work deliberately.

## Handoff and integration

Collect only the task's reporting files from its actual Worker into canonical `handoffs/<id>.md` and `evidence/<id>/`. Preserve evidence filenames/contents and inspect any reporting-only commit after the tested implementation commit. Do not copy a Worker's stale DAG or `STATE.md` over Manager state.

```text
handoff validate <id>
audit <id> --worktree <Worker-checkout>
transition <id> handoff
transition <id> review
```

`audit` reads the recorded base/head commits with Git, checks ancestry and actual changed paths, and reports dirty state separately. It does not execute shell text from evidence or check out another revision. Review unknown/new files and the narrative alongside the diff.

Manager then integrates the accepted head onto an integration branch, records the result, and runs all specified cross-module/user-scenario checks there. A changed integration commit requires new evidence. Save acceptance JSON and use:

```text
transition <id> done --record <acceptance.json>
```

The record gate checks matching task revision, dispatch, base/head, integration commit, requirement coverage, declared results and file existence. The Manager must still verify real repository state, log content, test execution and semantic correctness. No external URL or prose-only claim substitutes for commit-bound local evidence in provenance mode.

## Recovery

`recover` lists reservations, assignment identifiers, directory existence, handoff paths and queued conflicts. It is read-only and has no task-tool access. The Manager must reconcile:

| Observation | Action |
| --- | --- |
| assigned but send outcome unknown | Read the identified task before sending anything again |
| Worker running | Keep reservation; inspect progress with bounded waits |
| Worker finished, not integrated | Collect handoff, inspect diff and integrate; do not restart implementation |
| Worker missing/failed, dirty checkout | Preserve changes, inspect evidence, stop old writer, then choose repair/reassignment |
| recorded done but acceptance/commit inconsistent | Open a corrective task; do not report the milestone complete |
| blocked | Resolve decision/dependency and writer ownership before releasing reservation |

Prefer event/status waits for a bounded set of Workers to repeated full-history polling. Save checkpoints when a turn ends. Future monitoring requires explicit user scheduling authorization and an actual automation; a document saying “wait” does not create one.

## Runtime limits

Scopes and resources are declarations, not OS enforcement. Runtime does not observe external processes, symlink aliases, network locks or unrecorded contract changes. Separate worktrees do not remove merge conflicts. Manual/command results are declarations supported by local files, not independent proof of correctness. The Manager performs the final checks.
