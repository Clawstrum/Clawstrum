# Testing

There are three layers: local tests on every change, a package install check before a release, and a live Discord run. Run the scripted Discord cases regularly. Add the real model checks after changes to providers, moving context between them, MCP tools or SDK versions.

## Local and package checks

The full suite needs Node 22.16 or newer. The core CLI runs on 22.13.

```sh
npm ci
npm run check
npm run format:check
npm run test:package
```

`npm run check` type-checks and runs the test suite. It covers state and recovery, account and model routing, cancellation, research tools, hooks, gates, live steering, restarts and the SDK protocols. It uses local fixtures and fake providers, with no Discord or provider login and no model calls, and removes Jev and OpenRouter keys from its environment. `npm run test:package` installs the package archive into a fresh directory with production dependencies and runs the installed CLI, MCP server and workflow commands.

CI runs these on Linux and macOS with Node 22 and 24, for pull requests, pushes to `main` and manual runs. A newer push cancels the older run for the same branch. Run the checks locally, then push once.

## Live Discord

You need a bot in a test server with Message Content Intent, and permission to manage channels and webhooks, create threads, read message history, send messages and attach files. Use a separate test bot. Pass the token through the environment or a private env file, never on the command line.

```sh
npm run test:discord -- --guild YOUR_TEST_SERVER_ID \
  --env-file /absolute/path/to/private.env \
  --report /absolute/path/to/results/discord.json
```

- The token is read from `DISCORD_BOT_TOKEN`. `--token-env NAME` picks another variable.
- The runner creates a private channel and two webhooks, starts Clawstrum with its own temporary state, runs the cases, then deletes the channel and webhooks. Server admins can still see the channel. `--keep-channel` keeps it.
- It doesn't register application commands or touch an existing Clawstrum install.
- Messages come from a webhook. Only the test runner accepts them. No config or environment setting lets the daemon accept webhook messages.
- A scripted provider drives the real engine and MCP server through the real Discord gateway. The cases cover replies, attachments, threads, long messages, status, cancel, account switching, simulated quota fallback, scheduled wakes and recovery after a lost send or disconnect.
- The JSON report records each check, timings, Discord message IDs and cleanup. It is written with private permissions, outside the checkout by default.
- A failure or failed cleanup exits nonzero. A watchdog stops the run after 12 minutes. If the host dies, the report has the channel ID so you can delete it.

## Real model checks

`--models` adds a run on your real Claude and Codex subscriptions and uses a small amount of quota. It makes temporary login profiles, copies only Codex's `auth.json`, and removes them afterwards. Your provider settings and hooks are not used. Claude runs Haiku at low effort. Codex uses its default model unless you pass `--codex-model MODEL`.

```sh
npm run test:discord -- --guild YOUR_TEST_SERVER_ID \
  --env-file /absolute/path/to/private.env \
  --models --claude-token-env CLAUDE_CODE_OAUTH_TOKEN \
  --codex-home /absolute/path/to/authenticated/codex-profile \
  --report /absolute/path/to/results/discord-models.json
```

`--claude-token-env` defaults to `CLAUDE_CODE_OAUTH_TOKEN`. Claude saves a value with the checkpoint tool and replies. A Discord command then switches to Codex, which must recover the value from the checkpoint and reply. This tests switching between finished turns. Switching during a turn is tested only with scripted providers.

For a Claude-only install, `--claude-only` runs the scripted cases and the Claude case without Codex. `--claude-model` and `--claude-effort` default to `haiku` and `low`.

```sh
npm run test:discord -- --guild YOUR_TEST_SERVER_ID --claude-only \
  --claude-token-env CLAUDE_CODE_OAUTH_TOKEN --claude-model MODEL \
  --claude-effort high --report /absolute/private/discord.json
```

## Not covered

The live run doesn't act as a human Discord account. Slash commands typed by a person, DMs, image understanding, real rate limits, long model work with compaction and real Slurm submission need checking by hand. Research tests never submit to a real cluster.

Run the live command from your own scheduler or a trusted CI runner, with a dedicated bot and private reports. Keep it away from untrusted pull requests. The repository installs no recurring job.

References: [Discord webhooks](https://docs.discord.com/developers/resources/webhook), [Discord messages and nonces](https://docs.discord.com/developers/resources/message), [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [Codex authentication](https://learn.chatgpt.com/docs/auth).
