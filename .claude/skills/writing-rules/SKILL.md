---
name: writing-rules
description: Principles for writing instructions a model reads as rules. Use whenever adding or editing AGENTS.md, CLAUDE.md, rules, skills, agent definitions, hook messages, review prompts or any other instruction file.
---

# Writing rules

An instruction file is loaded on every run and trusted as true. Each rule in it must stay true while the code around it changes, and must cost no more words than its meaning needs.

## Principles

**State intent, not location.** Name the property to preserve and why it matters; leave out file names, paths, code identifiers and line numbers. Code moves and gets renamed without the rule being updated, and a rule that points at something gone misleads more than no rule.

**Be minimal and generic.** Say each thing once, in the most general sentence that is still true, and give no examples: the reader fits the rule to the example and misses every case that looks different. One sentence that covers every case beats three that cover some.

**Say only what is specific.** Write what this project requires that a capable engineer would not do by default, and nothing else. Leave out general good practice, how the rule came about and any past incident; write every rule in the present tense, as if it had always held.

## Before saving

- Every file name, path, identifier and line number is gone, unless it names a concept the project's architecture or vocabulary defines.
- No example, anecdote, date or reference to an earlier state of the code or of the rule.
- No sentence repeats another, here or in anything this file already loads.
- Every sentence changes behaviour compared with a capable agent that never read it.
- A reason accompanies each rule whose reason is not obvious, in one clause.
- Each rule says what to do; a prohibition stands alone only when no positive phrasing exists.
