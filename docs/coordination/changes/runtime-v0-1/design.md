# Runtime v0.1 design

The package uses one task loader/model boundary, deterministic scheduler and conflict functions, a state writer, a Markdown handoff validator, and a bounded context assembler. The CLI is a thin adapter. The YAML writer rewrites the explicitly transitioned DAG using stable readable block YAML; comments are not a v0.1 preservation guarantee.
