# Clawstrum documentation

## Getting started

| Guide                             | Covers                                                     |
| --------------------------------- | ---------------------------------------------------------- |
| [README](../README.md)            | What Clawstrum is, requirements and install                |
| [Setup](setup.md)                 | Guided and manual setup, the Discord bot, provider sign-in |
| [Subscriptions](subscriptions.md) | Claude, Codex and Gemini accounts, switching models, quota |

## Using it

| Guide                             | Covers                                                                 |
| --------------------------------- | ---------------------------------------------------------------------- |
| [Memory](memory-lifecycle.md)     | Instruction and memory files, history, background passes, call limits  |
| [Research tools](research.md)     | Literature search, papers, citations, research notes, Slurm jobs       |
| [Subagents](orchestration.md)     | When the lead delegates, roles, limits, steering, checker and reviewer |
| [Workflows](workflows.md)         | Condition watches, decision, prose and figure linting, research skills |
| [Channel groups](groups.md)       | Shared instructions and a board across related channels                |
| [Live steering](live-steering.md) | Messages sent while the agent is working                               |
| [Operations](operations.md)       | Running as a service, state, backups, upgrades, restarts, recovery     |

## Customizing

| Guide                                 | Covers                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Customizing](customize.md)           | Instructions, skills, tool servers, hooks, code, sandbox, voice notes, working alone, self-review |
| [Configuration](configuration.md)     | `config.json` fields, defaults and limits                                                         |
| [CLI](cli.md)                         | `clawstrum` commands                                                                              |
| [Instructions](instructions.md)       | `AGENTS.md` files, the base prompt, imports, live refresh                                         |
| [Hooks and gates](hooks-and-gates.md) | Validation modes, tool-call checks, outgoing reply review                                         |
| [Jev decisions](jev.md)               | The optional decision service, or a chat model on OpenRouter in its place                         |

## Internals

| Guide                                   | Covers                                                              |
| --------------------------------------- | ------------------------------------------------------------------- |
| [Architecture](architecture.md)         | Processes, storage, turns, accounts, delivery, scheduling, recovery |
| [System prompt](system-prompt.md)       | A run's context, its order and size limits                          |
| [Performance and usage](performance.md) | Turn timings, slow turns, stuck queues, token use and cost          |
| [Testing](testing.md)                   | Local, package, live Discord and real model checks                  |

## Maintaining these guides

When you change behavior, update its guide. Check config defaults against `src/config.ts` and `src/research/config.ts`, commands against `src/cli-main.ts` and `src/workflow-cli.ts`, and agent tools against `src/mcp.ts`. Add a new guide to the `files` list in `package.json`. Source and test links work in a checkout. The installed package has `dist/` instead.
