---
status: accepted
---
# Isolation through project-only settings and unique run folders, not a temp HOME

`claude plugin eval` isolates each run with a temporary HOME and config directory, which also drops subscription credentials. Because of ADR 0003 we instead load only project settings, enable strict MCP config so personal MCP servers stay out, and give each run a unique folder so Claude's auto-memory starts empty. The residual leaks this leaves open, the global config file, managed policy settings and claude.ai connectors, are documented in the brief and README rather than closed.

## Consequences

Revisit if a way appears to keep auth while using a fresh config directory. Until then the README's "how experiments lie" section names the leaks.
