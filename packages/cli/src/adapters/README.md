Cli-side adapters core must not import: the Agent SDK runner, the installed-CLI runner, the `node:sqlite` run store, and the model resolver `placebo init` uses to ask Claude Code for full model IDs.
