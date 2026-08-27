# Runtime v0.1 specification

`task-dag.yaml` is the single task-state authority. Runtime derives views but does not write derived labels. A blocked task returns to `ready`; `blocked_from` remains as provenance for a later policy that restores the prior status.

Context sources carry their inclusion reasons. Evidence uses three independent facts: it was declared, its reference syntax is valid, and local files (when declared) exist. `manual:` evidence and HTTPS URLs are valid non-file evidence.
