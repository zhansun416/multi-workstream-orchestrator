# Project state

## Current milestone

Runtime v0.2.0: recoverable dispatch and commit-bound evidence.

## Current user-visible outcome

The skill now supplies operational dispatch, recovery, integration and migration rules. The JavaScript Runtime rejects conflicts with reserved work, stale DAG writes and mismatched evidence, and can inspect actual committed file scope.

## Decisions made

- Preserve and extend the existing JavaScript implementation; no parallel Python runtime.
- Only the Manager checkout owns task status. Change packages link IDs.
- Blocked/review work retains reservations until the writer is reconciled.
- New Git projects use provenance mode. Legacy completed history is preserved; running work requires explicit migration before enabling strict gates.
- Runtime checks declarations and observed Git diffs; the Manager verifies execution, semantics and integration.

## Active tasks

The historical implementation tasks remain in `task-dag.yaml`. The v0.2 maintenance change is reviewed through its Git diff and automated tests; it did not create additional development task windows.

## Blockers and risks

No implementation blocker. YAML comments are not round-tripped. Locks protect one canonical DAG only. Runtime does not detect actual agent liveness, execute evidence commands or prove the content of logs. Separate worktrees require explicit snapshot/handoff transfer.

## Next Manager action

Install the updated skill and dependency lockfile, verify its installed CLI, and push the reviewed change for repository review. Future project adoption should begin with `recover` and the migration procedure.
