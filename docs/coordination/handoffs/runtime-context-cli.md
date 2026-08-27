# Handoff: runtime-context-cli

## Result

Implemented bounded Manager, Worker, and Reviewer context assembly plus the local Node.js CLI.

## Changed files

- src/context.js
- src/cli.js

## Contract impact

Added internal `RoleContext@v1`, including source paths and inclusion reasons.

## Validation performed

Ran `npm test` and invoked `wave`, `context worker`, `context manager`, and `handoff validate` against the sample fixture.

## Evidence locations

- test/runtime.test.js

## Known limits / risks

Budgets are character estimates, not tokenizer measurements.

## Suggested next action

Use the CLI as a local aid while retaining Manager decisions outside the Runtime.
