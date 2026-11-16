# Clawstrum documentation

## Getting started

- [README](../README.md): what Clawstrum is, requirements and install.
- [Setup](setup.md): `clawstrum setup`, the Discord bot, accounts and manual setup.
- [Subscriptions](subscriptions.md): Claude, Codex and Gemini accounts, switching and quota.

## Using it

- [Operations](operations.md): running the daemon as a service, state, inspection, backup and recovery.
- [Workflows](workflows.md): live snapshots, planned restarts, linting, condition watches and self-review.
- [Research](research.md): papers and citations, research notes, subagents, Slurm jobs and their configuration.
- [Research continuity](research-continuity.md): resource accounting, steering subagents, compaction recovery and note revisions.
- [Subagent orchestration](orchestration.md): when and how the lead delegates, and how subagents report back.
- [Channel groups](groups.md): shared instructions and boards across related channels.
- [Live steering](live-steering.md): how messages sent during a running turn reach the agent.

## Customizing

- [Customizing Clawstrum](customize.md): instructions, skills, tool servers, hooks, code, sandbox, voice notes and working alone.
- [Configuration](configuration.md): every `config.json` field, default and limit.
- [CLI](cli.md): every `clawstrum` command.
- [Instructions](instructions.md): `AGENTS.md` files shared by Claude, Codex and Gemini, and live refresh.
- [Hooks and gates](hooks-and-gates.md): citation checks, reply review and validation modes.
- [Jev](jev.md): the optional decision service.

## Internals

- [Architecture](architecture.md): processes, ownership, accounts, delivery and recovery.
- [System prompt](system-prompt.md): what the agent's context contains and in what order.
- [Provider instructions](provider-instructions.md): exact composition of the instructions sent to each provider.
- [Memory lifecycle](memory-lifecycle.md): `AGENTS.md` memory, raw history, compaction, consolidation and consistency review.
- [Performance](performance.md): queue, preparation, compaction and delivery timing.
- [Usage](usage.md): token use by role, activity and day.
- [Testing](testing.md): local, package and live Discord tests.

## Maintaining these guides

When changing behavior, update its guide. Check config defaults against `src/config.ts` and `src/research/config.ts`, commands against `src/cli-main.ts` and `src/workflow-cli.ts`, and tool inventories against `src/mcp.ts`. Add distributable guides to the `package.json` files allowlist. Source and test links work in a checkout; the installed package has `dist/` instead.
