# Automated testing

Use three layers: deterministic regression tests on every change, a clean package installation before release, and an explicit live Discord acceptance run. Run the scripted Discord cases regularly; add the authenticated model checks after changes to providers, context transfer, MCP tools, or SDK versions. No person needs to send test messages.

The checks below establish engineering behavior, not task quality.

## Local and package checks

From a source checkout with Node 22.16 or newer for the complete suite (core CLI minimum: 22.13):

```sh
npm ci
npm run check
npm run format:check
npm run test:package
```

The default suite covers state transitions, recovery, account and model routing, cancellation, research tools, hooks, gates, and SDK protocol behavior. It uses controlled subprocesses and local fixtures, without Discord or provider credentials. The package check installs the archive into a fresh directory with production dependencies and nested dependency resolution, then exercises the installed runtime. The normal CI matrix runs these checks on Linux/macOS with Node 22/24.

CI runs for pull requests, pushes to `main`, and explicit manual dispatch. Feature-branch and deployment-branch pushes do not duplicate the PR matrix. A newer revision cancels the older run for the same PR/ref. Batch related changes, run local checks, then push once; retry only failed jobs on the latest relevant run. The PR check verifies the proposed merge and the main check verifies the merged repository; both retain the full platform matrix.

[research-continuity.test.ts](../test/research-continuity.test.ts) covers resource snapshots/limits, note revisions, continuation, durable steering, compaction fallback, citation fallback and scheduler classifications. The Claude and Codex steering suites additionally run research subagents through compiled supervisor IPC, with no paid model calls.

## Unattended live Discord

Use a bot installed in a test server, with Message Content Intent enabled and permission to create channels, webhooks and threads, read message history, send messages and attach files. A dedicated test bot avoids sharing a production bot's gateway session budget. Supply its token through the environment or an existing private environment file; do not put token values on the command line.

```sh
npm run test:discord -- --guild YOUR_TEST_SERVER_ID \
  --env-file /absolute/path/to/private.env \
  --report /absolute/path/to/results/discord.json
```

`DISCORD_BOT_TOKEN` is the default credential name; `--token-env NAME` selects another. The command creates a temporary private channel and two webhooks, starts Clawstrum with isolated local state, runs the checks, and deletes the channel and its webhooks afterward. Server administrators can still see the channel. `--keep-channel` retains it for inspection. The runner does not register or overwrite the bot's application commands. It does not change existing Clawstrum or predecessor state.

The sender is a Discord webhook. The default Clawstrum configuration rejects bot and webhook messages. Only the test runner passes an explicit constructor option accepting the exact webhook, server and channel (including child threads), with DMs and command registration disabled and a single test owner. Unit tests enforce these constraints and exercise normal human input separately. There is no configuration-file or environment switch that enables the isolated test-ingress exception in the daemon.

The scripted provider deterministically drives the real engine and MCP server. Inputs arrive through the real Discord gateway; output assertions read messages and attachment bytes back from Discord. Cases cover:

- Input, automatic replies, rejection of another webhook, and prevention of reply loops.
- Incoming attachments, outgoing MCP files, ordered long-response messages, and child threads.
- Quiet intake without a queue message or empty thread; useful notices create and reuse a real thread on the input message, with the answer in the parent channel.
- Escaped prose paragraphs through MCP and automatic replies, with inline escape examples preserved.
- Status, active-turn cancellation, checkpoint-preserving account switching, and synthetic quota fallback.
- A scheduled wake, silent completion of a quiet follow-up, retry after losing a real send acknowledgement, and recovery of input sent while disconnected.

The lost-acknowledgement case sends the message to Discord, hides the acknowledgement from the outbox, and verifies that the retry returns the same remote message ID. This checks Discord nonce deduplication in addition to local database idempotency. Quota rejection is injected; the runner does not exhaust a subscription to manufacture a rate limit.

The JSON report records each assertion, duration and remote message IDs, run/account outcomes, usage events when available, and cleanup status. It is written with private permissions outside the checkout by default. The retained temporary state contains synthetic test messages and diagnostics. Failure or cleanup failure returns a nonzero exit code; a 12-minute watchdog requests shutdown. Abrupt host loss or SIGKILL can prevent cleanup; the report records the unique channel ID/topic for removal.

## Real subscription execution and provider handoff

The optional model phase uses the installed official SDKs and existing subscription credentials. It creates temporary authentication profiles, copies only Codex's `auth.json`, and removes those profiles afterward. Existing provider settings and hooks are not imported. Claude uses Haiku at low effort; Codex uses its default model unless `--codex-model MODEL` is supplied. This phase consumes a small amount of subscription quota.

```sh
npm run test:discord -- --guild YOUR_TEST_SERVER_ID \
  --env-file /absolute/path/to/private.env \
  --models --claude-token-env CLAUDE_CODE_OAUTH_TOKEN \
  --codex-home /absolute/path/to/authenticated/codex-profile \
  --report /absolute/path/to/results/discord-models.json
```

First, Claude receives a Discord request, saves a unique value through the checkpoint MCP tool, and sends an exact reply using the message MCP tool. A Discord control command switches the conversation to Codex. Codex must recover the value from the checkpoint and send the corresponding reply; its new request does not repeat the value. The runner checks the actual executing account, completion state and Discord message. This proves a completed-turn handoff with real providers; the active-turn switch case uses deterministic adapters.

## What remains separate

Webhook input exercises real network delivery but does not impersonate a human Discord account. Human slash-command invocation, DM behavior, image understanding, real rate-limit timing, multi-hour model work and compaction, and real cluster submission need additional acceptance evidence. Automated tests cover several underlying code paths, but that is not equivalent to live verification. Research fixtures deliberately avoid submitting jobs to a real cluster.

Use the live command from your existing scheduler or trusted CI runner with a dedicated bot and private reports. Keep credentialed live tests separate from untrusted pull requests. The repository does not install a recurring job automatically.

Protocol references: [Discord webhook execution](https://docs.discord.com/developers/resources/webhook), [Discord message fields and nonce behavior](https://docs.discord.com/developers/resources/message), [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), and [Codex authentication](https://learn.chatgpt.com/docs/auth).

## Claude-only deployment verification

For a Claude deployment, `--claude-only` runs the scripted cases and the real Claude checkpoint/message case without requiring Codex credentials. `--claude-model` and `--claude-effort` choose the tested route; defaults remain Haiku and low effort. Example:

```sh
npm run test:discord -- --guild YOUR_TEST_SERVER_ID --claude-only \
  --claude-token-env CLAUDE_CODE_OAUTH_TOKEN --claude-model MODEL \
  --claude-effort high --report /absolute/private/discord.json
```

This mode does not claim a real Claude-to-Codex handoff. The same temporary-channel isolation and cleanup apply.

## Operational workflows

The package check installs the archive into a fresh directory and runs the installed backup/verify, watch, decisions, review and backup-service commands alongside the runtime and MCP checks.

The restart regression runs two compiled daemon processes with controlled Discord/provider adapters. It verifies exit 75 after current work and deliveries drain, preservation of a newly queued input, a different replacement PID, the readiness receipt and completion of that queued input. This is deterministic lifecycle verification, not a new authenticated Discord test. Snapshot tests verify restoration, integrity, retention, failures and host-pinned source selection. Review tests cover 23/25-hour dates, delivery timestamps, missing-date holes and concurrent collection. See [the workflow guide](workflows.md) for behavior and operational limits.

## Live user steering

`test/steering.test.ts` exercises the streaming-input lifecycle, ordered attachment/retry barriers, prompt and batch bounds, debounce/typing, acknowledgment validation, closed or missing acknowledgments, cancellation, crash recovery, and Claude-to-Codex quota handoff. It also starts the compiled engine and supervisor with the real installed Claude SDK and a local JSONL executable fixture. That contract test verifies two inputs reach the same subprocess, accepted input joins one durable run, and the later SDK result reaches the outbox.

These tests use temporary state and synthetic messages. They do not contact Discord, log in to a provider, or execute a real model. They establish the harness/SDK transport contract, not the model's timing or interpretation of mid-turn instructions.

The Codex steering suite includes real compiled-worker IPC with a protocol fixture, rejected/late acknowledgments and transport-loss recovery, plus an actual bundled-runtime initialization/guard check using an empty temporary profile and no model call. The installed-package fixture exercises the App Server lead path and the SDK research-subagent path. These checks do not claim an authenticated Codex model run or a live Discord steering conversation.

## Cross-feature regressions

`test/pr-integration.test.ts` covers concurrency, validation and upgrade interactions between features.
