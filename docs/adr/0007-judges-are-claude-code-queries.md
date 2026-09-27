---
status: accepted
---
# Judges are one-turn, tool-less Claude Code queries with schema-enforced output

Because Placebo requires no API key (ADR 0003), judges cannot call the Messages API directly. They run through the same runner as the subject, as one-turn queries with tools disabled and a JSON schema for the answer, which works on any auth and costs a fraction of a run. An agentic judge that explores a config-stripped copy of the result is opt-in per grader for questions that need repo exploration.
