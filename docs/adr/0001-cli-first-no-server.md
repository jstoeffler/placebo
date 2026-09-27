---
status: accepted
---
# CLI first, single-file HTML report, no server in v1

The original brief specified both a CLI and a compose stack: API, worker, Postgres, queue, Docker socket and a web UI. We ship only the CLI, with the React report built as one self-contained HTML file and results kept as JSON plus SQLite, because adoption and CI gating both need the CLI and neither needs a service. The Executor, Runner and RunStore ports keep a server possible later as a composition root reusing the same report components.

## Considered options

Both in parallel, as the brief said. Server first. Both rejected because nobody can try or gate with a four-service stack, and every hour on the stack is an hour before the first measurement exists.
