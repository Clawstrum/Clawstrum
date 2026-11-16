# Subscriptions

Claude runs through the Claude Agent SDK, Codex through the Codex SDK and app server, and Gemini through Antigravity CLI over the Agent Client Protocol (ACP), each on your own sign-in. Clawstrum never switches to API billing.

Claude uses your Claude login through the bundled Claude Code runtime. Codex uses ChatGPT subscription login, which Clawstrum forces, with a separate `CODEX_HOME` per account ([Codex authentication](https://learn.chatgpt.com/docs/auth)). Gemini uses your Google login ([Gemini](#gemini)).

## Accounts

```json
"accounts": [
  { "id": "personal", "provider": "codex", "home": "accounts/personal/codex" },
  { "id": "second", "provider": "codex", "home": "accounts/second/codex" },
  { "id": "claude", "provider": "claude", "home": "accounts/claude/claude" }
]
```

```sh
clawstrum account add second codex
clawstrum account login second
clawstrum switch SESSION second
```

Each account has its own home with its own login and native transcripts. Relative homes resolve against `CLAWSTRUM_HOME`. Fields are in the [configuration reference](configuration.md#accounts), commands in the [CLI reference](cli.md#accounts-and-conversations).

For a Claude OAuth token, `tokenEnv` names a variable in `.env`. Never put the token in `config.json`. An account with a token runs on it, so `account login` refuses it unless `--force`. Check it with `clawstrum account test ID [--model MODEL]`.

Agent shells, subagents, watches and cluster commands get no provider-routing variables, no configured `tokenEnv` and no variable whose name looks like a credential (token, secret, password, API, access or private key, or ending in `_KEY`). Research and decision keys reach only Clawstrum's tool server, so a script that needs one must read it from a file such as `~/.netrc`. This keeps keys out of transcripts and logs. It doesn't stop an agent with full host access from reading `.env`.

## Routing

With no account chosen for a channel, Clawstrum picks a route for each run:

- Higher `priority` first (default 0). Priority never overrides sign-in, cooldowns, failed attempts, concurrency limits or an explicit subagent account or model.
- Then primary models on all accounts, then each fallback tier in order. Order fallbacks the same way on every account.
- Within a tier, routes below `runtime.quotaWarningThreshold` first, then the lowest observed usage. Unknown usage ranks after known and never counts as zero. The active account stays while within five percentage points of the best.
- If every route is strained, work still runs.

A chosen account (`clawstrum switch`, or a configured subagent account) is tried first, then the other routes. A quota rejection blocks the account, or just the model if its bucket is mapped, and moves to another route, possibly on another provider. When all are exhausted, work waits until a known reset, or for `runtime.unknownQuotaCooldownMs`. `clawstrum account reset ACCOUNT` clears a cooldown early. Running turns aren't interrupted to reorder accounts.

The same account resumes its native session. Another account, provider or model starts a fresh session with recent history carried over. Several accounts on the same underlying subscription share its limits.

## Model fallback

An account can fall back to other models on the same login and concurrency cap. Use model IDs your subscription offers and the bucket names its runtime reports:

```json
{
  "id": "claude-main",
  "provider": "claude",
  "home": "accounts/claude-main/claude",
  "model": "YOUR_PRIMARY_MODEL",
  "quotaBuckets": ["seven_day_overage_included"],
  "modelFallbacks": [{ "model": "YOUR_FALLBACK_MODEL", "quotaBuckets": ["seven_day_opus"] }]
}
```

Only map a bucket you have seen your runtime report for that model. Five-hour, weekly and unidentified limits always cover the whole account, as does any limit without a mapping. When you change a primary model, check its `quotaBuckets` too.

## Quota warnings

At `runtime.quotaWarningThreshold` (0.9) Clawstrum warns at most once per account, bucket and reset window, or hourly when no reset is known. At `runtime.proactiveThreshold` (0.95) it stops using a route with a known reset. A warning alone never moves work to a lower model tier.

Warnings and actual account or model switches for the lead agent go to `discord.noticeChannelId` if set, which the bot must be allowed to post in. Otherwise fallback warnings go to the conversation and other switches to its notice thread. A fallback is announced once, before the run.

| Path                                        | Quota data                                                 |
| ------------------------------------------- | ---------------------------------------------------------- |
| Claude Agent SDK                            | Usage, bucket and reset when supplied                      |
| Codex lead and subagents via the app server | Windows named `<limitId>:primary` or `<limitId>:secondary` |
| Codex scheduled lead runs via the SDK       | Recognized quota errors only                               |
| Gemini over ACP                             | Quota errors only, from text and status code               |

Missing values stay unknown. Codex windows aren't mapped to Claude's buckets. Clawstrum doesn't poll quota or send probe prompts.

## Per-conversation model

```sh
clawstrum switch SESSION ACCOUNT                   # this account, its own model
clawstrum switch SESSION ACCOUNT --model MODEL     # this account, this model here
clawstrum switch SESSION ACCOUNT --model default   # clear the model choice
```

In Discord: `!clawstrum switch ACCOUNT [--model] MODEL` or `/clawstrum action:switch account:ID model:MODEL`. If the account refuses the model or hits its limit, routing falls back to the account's own models with a notice. A model not in the account's configuration has no bucket mapping, so a limit on it cools the whole account.

## Account registry

When `runtime/accounts.json` exists, its accounts replace `accounts` in `config.json`. Clawstrum refuses it unless only you can read it (`chmod 600`). It takes the same fields plus `token`, a Claude OAuth token used instead of `tokenEnv`, never both:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "WORK",
      "provider": "claude",
      "home": "provider-profiles/WORK",
      "priority": 100,
      "tokenEnv": "CLAUDE_TOKEN_WORK"
    },
    {
      "id": "HOME",
      "provider": "claude",
      "home": "provider-profiles/HOME",
      "token": "sk-ant-oat01-FAKE-EXAMPLE-NOT-A-REAL-TOKEN"
    }
  ]
}
```

A token reaches the provider as `CLAUDE_CODE_OAUTH_TOKEN` and never appears in logs, `account list`, `status`, the dashboard or prompts. `account list` shows the credential source: `token in accounts.json`, `env VAR (set)`, `env VAR (missing)` or `profile login at HOME`.

The daemon checks `config.json` and the registry every few seconds and applies account changes at the next routing decision, without interrupting running turns. It logs `accounts_reloaded`, or `accounts_reload_failed` and keeps the old list.

`clawstrum account import` creates the registry from `config.json`. `--move-tokens` copies each `tokenEnv` value into `token`. Neither `config.json` nor `.env` changes.

`runtime/ACCOUNTS.md` holds your rules in plain words, such as "Use WORK while it has quota, then HOME." `account import` writes a template. Each lead agent's prompt gets an Accounts section of at most 1,600 characters with the accounts and your rules, minus anything that looks like a Claude token. The `model-router` skill has the same rules.

## Gemini

Clawstrum runs Google's Antigravity CLI (`agy acp`, the successor of Gemini CLI for subscription accounts) as an [ACP](https://agentclientprotocol.com) agent. Nothing from it is bundled. Download `agy_cli_<os>_<arch>.tar.gz` (`mac` or `linux`, `arm64` or `x64`) from github.com/google-antigravity/antigravity-cli/releases, unpack it under `tools/antigravity-cli-VERSION/` in the repository and link `agy` there to its `antigravity` program. The highest version wins. Or set the account's `executable`. Otherwise `agy` on `PATH` is used.

- Run `clawstrum account add ID gemini`, then `clawstrum account login ID`. Open the Google link it prints in any browser and paste the code or full URL back. `account login` and `doctor` check the sign-in without a model call. Your own `$HOME` is untouched.
- Only the Google sign-in (`oauth-personal`) is used. Clawstrum removes `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_*` and `AGY_LLM_GATEWAY_*`, refuses `tokenEnv`, and stops a run whose settings or log show an API key, cloud, enterprise or gateway mode.
- The model is `gemini-4-argon` unless the account sets `model`. If agy doesn't offer it, the run fails and lists what it offers. `effort` sets agy's thinking level: `low` and `medium` as named, anything higher as `high`.
- Sessions run in `auto` mode (`accept-edits` if agy has no `auto`) without approval prompts. Text-only calls use the read-only `plan` mode.
- If agy no longer has a session, a fresh one starts with recent history carried over.
- Clawstrum's instructions open each new session's first prompt.
- Gemini runs have no per-token cost estimates or quota windows, and `memory migrate` can't import their native sessions.
