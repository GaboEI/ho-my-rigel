---
name: rigel-session-start
description: Mandatory session bootstrap for any work in the Ho My Rigel repository, including requests that mention Ho My Rigel, Rigel, profiles/gabo, OpenCode V2, the V2 laboratory, or /home/gabodev/Projects/ho-my-rigel. Invoke before commands, edits, tests, planning, or resumed work so the agent loads the permanent V1-protection and V2-isolation rules.
---

# Rigel session start

Use this skill before taking any project action. It applies again after context compaction, a long pause, or a resumed session when the mandatory rules may no longer be present in working context.

## Mandatory reading order

From the repository root, read these files completely:

1. `AGENTS.rigel.md`
2. `.omo/rules/rigel.md`
3. `.omo/rules/protect-opencode-v1.md`

Also obey the root `AGENTS.md` and every more-specific `AGENTS.md` governing files in scope. If the task will launch, test, configure, refresh, or inspect an OpenCode runtime, read `profiles/gabo/README.md` before acting.

Do not delegate this reading. Do not rely on a summary from another agent or an earlier session. If a mandatory file is missing or unreadable, stop project work and report the missing path.

## Binding boundary

Treat `.omo/rules/protect-opencode-v1.md` as an absolute safety constraint:

- V1 is production and must remain operational and unchanged.
- Docker and every container-based runner are prohibited for this project.
- All live experiments and QA run only through `opencode-v2-lab.service`, refreshed only by `profiles/gabo/apply-v2-runtime-service.sh`.
- A temporary working directory, `--standalone`, a different port, or a V2 binary does not establish isolation.
- Never launch OpenCode until the complete `HOME`, XDG, goal-state, process, service, socket, port, plugin, and database separation required by the rule has been positively verified.
- Never invent a container, runner, subprocess, service, or fallback when the laboratory cannot execute a test.
- If isolation or compatibility with the V2 laboratory is ambiguous, stop before execution and explain the exact uncertainty to Gabo.

This skill provides no authorization to repair, restart, inspect through a mutating interface, or otherwise touch V1. A separate, explicit, task-specific instruction from Gabo is required for any V1 operation.

## Continue the task

After loading the rules, continue the user's requested Ho My Rigel work without asking for ritual confirmation. State briefly that `rigel-session-start` was loaded and identify `opencode-v2-lab.service` as the runtime path before the first runtime experiment. Do not ask Gabo to choose Docker or another runner.

For OpenCode QA, invoke the repository's `opencode-qa` skill as required by `AGENTS.md`; this bootstrap remains active alongside it.
