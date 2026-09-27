---
status: accepted
---
# Inherit the user's local Claude Code auth; no login flow, no API-key requirement

Requiring an API key would exclude subscription users and most corporate users, who have Claude Code but no key. Placebo spawns Claude Code on the user's machine and uses whatever auth is already there: subscription, API key, Bedrock, Vertex or Foundry. It offers no login of its own, which is the thing Anthropic's policy forbids third-party products from doing. The README states that running experiments on a subscription is the user's call under their plan and points CI users to API keys.

## Consequences

No fresh config directory per run, because that would drop the credentials (see ADR 0004). Judges cannot call the API directly (see ADR 0007). If Anthropic's policy changes, this is the decision to revisit first.
