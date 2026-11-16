# Subscription support

Clawstrum is designed for coding agents' SDKs and the Agent Client Protocol (ACP): Claude runs through the Claude Agent SDK, Codex through the Codex SDK and app server, and Gemini through Antigravity CLI over ACP, each on the user's own sign-in. It does not silently switch to API billing, and it does not require an OpenAI API key for Codex.

Codex supports ChatGPT subscription login. Clawstrum forces that login method in the SDK configuration and gives each profile its own `CODEX_HOME`. [Official Codex authentication](https://learn.chatgpt.com/docs/auth).

Claude uses the user's own Claude login through the bundled Claude Code runtime.

## Gemini (Antigravity CLI over ACP)

The third provider keeps the name `gemini`. It runs Google's Antigravity CLI (`agy`, the successor of Gemini CLI for Google subscription accounts and for Gemini 4 Argon) as an agent speaking the [Agent Client Protocol](https://agentclientprotocol.com) (ACP, JSON-RPC lines on stdin/stdout) with `agy acp`. Clawstrum is the ACP client. Nothing from Antigravity CLI is bundled: download the release archive for the machine from github.com/google-antigravity/antigravity-cli/releases (`agy_cli_<os>_<arch>.tar.gz`, `mac` or `linux`, `arm64` or `x64`; it holds one `antigravity` program), unpack it under the repo's `tools/antigravity-cli-VERSION/` and link `agy` to the unpacked `antigravity` binary (the highest `tools/antigravity-cli-*` wins), or set the account's `executable`. Without either, `agy` on `PATH` is used.

- Subscription only: Clawstrum only ever calls ACP `authenticate` with `oauth-personal` (Log in with Google). It never uses `gemini-api-key`, `agent-platform` or `oauth-business`, never sends `_meta.apiKey`, and removes `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_*`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_*` and `AGY_LLM_GATEWAY_*` from the environment. `tokenEnv` is refused for Gemini accounts. Before agy starts, `<home>/.gemini/antigravity-cli/settings.json` is read (the old Gemini CLI's `<home>/.gemini/settings.json` is ignored): an auth type other than the Google login stops the run with an authentication error. After the session exists and before the prompt, agy's own log (`--log-file`, a temporary file) is read: an `Auth mode is ...` line naming an API key, cloud, enterprise or gateway mode stops the run too.
- Login: the account `home` plays the role of the CLI's home. agy is started with `--gemini-dir <home>/.gemini` and `XDG_CONFIG_HOME=<home>/.config`, so each account has its own login and the real `$HOME` is untouched. Add and sign in: `clawstrum account add ID gemini` then `clawstrum account login ID`, which runs `agy acp --login`: it prints a Google link, open it in any browser (a laptop works, the redirect page is antigravity.google/oauth-callback), sign in with the account that has the subscription, and paste the code or the full URL back. `account login` then checks the login by asking agy for a session (no model call). `doctor` does the same check. A run with no login fails with an authentication error before any model call.
- Model: the default is `gemini-4-argon` (Gemini 4 Argon). The account `model` replaces it. `agy acp` has no `--model` flag, so the model is chosen after the session exists, from the picker agy offers (a session config option of category `model`, or `session/set_model`). If agy does not offer the model the run fails and lists what it does offer, instead of running on another model. `effort` is ignored.
- Permissions: sessions are put in `auto` mode (`accept-edits` if `auto` is not offered) and agy is started with `--dangerously-skip-permissions`; any permission request still left is answered with allow-once, the same no-approval policy as Claude and Codex. A text-only call (`toolless`) uses `plan` mode, no MCP server and no auto-approve flag, and rejects permission requests. Plan mode is agy's read-only mode; it is not a switch that removes agy's built-in tools.
- Resume: the session id is the ACP session id. `session/resume` (no replay) is used when agy advertises it, otherwise `session/load` when it advertises `loadSession`; if agy no longer has the session, Clawstrum starts a fresh session with portable context, as for Codex.
- Instructions: ACP has no developer-instruction field, so the instructions are the start of the first prompt of a new session, and changed instructions are sent as a `CLAWSTRUM_CONTEXT_UPDATE` block at the start of a later prompt.
- Not available: live input into a running turn (a new message waits for the turn to end), per-token cost estimates, quota windows (Antigravity reports none over ACP; a quota error is classified from the error text and its status code), and native session import in `memory migrate`.

## Profiles

```json
{
  "version": 1,
  "discord": {
    "ownerIds": ["123456789012345678"],
    "channelIds": ["234567890123456789"],
    "guildId": "345678901234567890"
  },
  "accounts": [
    { "id": "personal", "provider": "codex", "home": "accounts/personal/codex" },
    { "id": "second", "provider": "codex", "home": "accounts/second/codex" },
    { "id": "claude", "provider": "claude", "home": "accounts/claude/claude" }
  ]
}
```

Relative homes resolve against `CLAWSTRUM_HOME`, not the service's working directory. Profiles must have distinct homes within each provider. Authentication is handled by the bundled CLI, not by a Clawstrum token-exchange implementation.

For an existing, authorized Claude OAuth-token workflow, `tokenEnv` names an environment variable in the private `.env` file. It is optional; do not put the token itself in JSON. Provider-routing variables from the parent shell are removed before selecting the account, and so is every variable whose name looks like a credential (token, secret, password, credential, API/access/private key, or ending in `_KEY`) and every configured `tokenEnv` whatever its name, for the lead, workers, reviews, command watches and cluster commands alike; their values are also redacted from failure notices. Research and decision keys reach the Clawstrum MCP server explicitly; a script an agent runs that needs such a key must read it from a file such as `~/.netrc`. This keeps keys out of transcripts, job environments and logs, and prevents accidental credential selection; it is not a security boundary against an agent with full host access, which can still read `.env` and provider homes.

An account with `tokenEnv` is run on that saved token, not on the login stored in its profile home, so `clawstrum account login ID` refuses it unless `--force` is given. To check such an account, or any account on a particular model, run `clawstrum account test ID [--model MODEL]`: it sends one short prompt through the same adapter, executable, home, token variable and environment filtering the daemon uses and prints the result as JSON.

An account may specify `model`, `effort` and an explicit `executable` override. The provider default is used when model is omitted. Account changes apply to the running daemon within seconds (see [Live changes](#live-changes)); no restart. With no channel preference, routing is automatic: try primary models across all accounts, then each ordered fallback tier. Within a tier, routes below the warning threshold come first, followed by the lowest observed quota utilization. A warning alone does not downgrade a usable preferred model. Rejection, proactive cooldown, failed attempts and concurrency limits can make a route unavailable. Align the fallback order across profiles to express the same model preference; Clawstrum does not infer quality from model names. Within the same tier and warning level, a known percentage ranks before an unknown one; unknown never means zero usage. The active account stays selected when its pressure is within five percentage points of the best observed route, avoiding unnecessary native-session handoffs. Equal or entirely unknown observations retain active-account/configuration order. Explicit channel preferences retain account-first ordered fallback behavior, subject to availability and quota pressure.

## Switching

Set an account's optional integer `priority` to prefer its subscription whenever an eligible route remains: higher values are tried first, and omitted values mean `0`. For example, priorities `100`, `50`, and `0` express a first-choice account, a backup, and a last resort. This applies to existing and new conversations, research subagents, and maintenance that use automatic account selection. Within each priority, the model-tier and quota ranking above still applies. Higher priority takes precedence over a lower-priority account's model tier or greater quota headroom; it never bypasses authentication, cooldowns, explicit subagent model/provider requests, failed attempts, or concurrency limits. Quota warnings alone do not override account priority. Once an account's cooldown expires, it is eligible again at the next routing decision; running turns are not interrupted just to reorder accounts.

An explicit channel switch or configured subagent account overrides automatic priority. Clear old channel preferences to adopt a new installation-wide order. All priorities equal (the default) preserves automatic quota balancing. Change priorities in `accounts.json` (or `config.json`); the running daemon applies them at the next routing decision. Model fallbacks remain visible through the existing notices.

```sh
clawstrum account add second codex
clawstrum account login second
clawstrum switch SESSION second
```

Quota rejection blocks the affected account or explicitly mapped model bucket and automatically tries another configured route. It can cross providers. All profiles exhausted means saved work waits, rather than repeated requests against the same limit. Reset timestamps are used when known; an unknown timestamp gets a configurable cooldown and is presented as an estimate in the configuration/architecture documentation.

Separate account homes also mean separate native transcript stores. Same-profile conversations resume natively; a profile/provider change uses Clawstrum's portable handoff. Adding multiple accounts does not combine their entitlements or change either provider's account rules.

Actual account/model changes produce a notice identifying the channel and observed previous/new route. A fallback is explicitly labeled and queued for delivery before provider execution, including the first turn in a new channel or the first use after upgrading an unannounced fallback. A durable per-channel receipt avoids repeated warnings while that route remains unchanged. The receipt and notice are written together; Discord delivery itself remains asynchronous. `discord.noticeChannelId` sends these directly to the configured operator channel. Without it, fallback warnings go directly to the conversation; other switches use its notice thread. A missing previous model after a schema upgrade is initialized without inventing a switch. Multiple distinct fallback transitions in one run remain visible. Research-subagent and maintenance role models are separate from this lead-channel routing policy.

Automatic ranking uses the maximum unexpired utilization among buckets applicable to a route. Observations without reset times expire after `unknownQuotaCooldownMs`. This is a routing heuristic from observed windows, not a measurement of remaining tokens or a live account dashboard; absent percentages stay unknown, and errors still trigger reactive fallback.

## Private account registry

`runtime/accounts.json` (in the state directory, `CLAWSTRUM_HOME`) is the private list of accounts. When the file exists its accounts are the account list and `config.json` `accounts` is ignored; without it, `config.json` is used exactly as before, so existing installations need no change. Clawstrum refuses to load the file if group or others can read it (it may hold tokens) and says to run `chmod 600`. Every other `config.json` rule applies to it unchanged: unique ids, one provider home per account, model fallback rules, bucket rules.

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "WORK",
      "owner": "Alice",
      "label": "Work Claude (WORK)",
      "notes": "Shared lab seat. Fable 5.2 is refused here.",
      "provider": "claude",
      "home": "provider-profiles/WORK",
      "priority": 100,
      "model": "claude-opus-5-5",
      "modelFallbacks": [{ "model": "claude-sonnet-5-5", "quotaBuckets": [] }],
      "quotaBuckets": [],
      "effort": "high",
      "tokenEnv": "CLAUDE_TOKEN_WORK",
      "executable": "tools/claude-2.1.322/bin/claude",
      "maxConcurrent": 4
    },
    {
      "id": "HOME",
      "owner": "Alice",
      "label": "Personal Claude",
      "provider": "claude",
      "home": "provider-profiles/HOME",
      "priority": 50,
      "model": "claude-opus-5-5",
      "token": "sk-ant-oat01-FAKE-EXAMPLE-NOT-A-REAL-TOKEN"
    }
  ]
}
```

Fields are those of a `config.json` account plus `owner`, `label` and `notes` (free text for people and the Accounts prompt section) and `token`, a Claude OAuth token used as an alternative to `tokenEnv` (set one or the other, never both; Codex accounts use a login in their own home and take neither). A `token` is passed to the provider as `CLAUDE_CODE_OAUTH_TOKEN` exactly as a `tokenEnv` value is, after the same removal of ambient provider variables. Clawstrum keeps it only in the daemon's memory, apart from the account objects: it is not in logs, events, `account list`, `status`, the dashboard, prompts, error messages or the configuration snapshots stored with subagent delegations.

`clawstrum account list` shows, per account, `credential`: `token in accounts.json`, `env VAR (set)` or `env VAR (missing)`, or `profile login at HOME`; never a value.

| Command                                                                                                        | Effect                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clawstrum account import [--move-tokens] [--force]`                                                           | Write `accounts.json` from the `config.json` accounts and seed `ACCOUNTS.md`. `--move-tokens` copies each `tokenEnv` value from the environment or `.env` into `token`; without it the references stay. A variable that is not set stays a reference. `config.json` and `.env` are not modified |
| `clawstrum account add ID codex\|claude [--owner O --label L --model M --priority N --token-env VAR --home H]` | Add to the registry (to `config.json` when there is no registry)                                                                                                                                                                                                                                |
| `clawstrum account edit ID --FIELD VALUE ...`                                                                  | Change `owner`, `label`, `notes`, `priority`, `model`, `effort`, `home`, `executable`, `token-env`, `max-concurrent`; the value `none` clears a field. Edit the file for fallbacks and buckets                                                                                                  |
| `clawstrum account remove ID`                                                                                  | Remove from the registry (not the last account)                                                                                                                                                                                                                                                 |
| `printf %s "$TOKEN" \| clawstrum account set-token ID` / `account set-token ID --clear`                        | Store or remove an account's token. The token is read from stdin, never from arguments; any `tokenEnv` on that account is dropped                                                                                                                                                               |
| `clawstrum account test ID [--model M]`, `login ID`, `reset ID`                                                | As before. `login` also refuses an account that has a stored token unless `--force`                                                                                                                                                                                                             |

Writes validate the whole configuration first and replace the file atomically with mode 0600.

### Account rules and the Accounts prompt section

`runtime/ACCOUNTS.md` holds the owner's rules in plain words, for example "Use WORK whenever it has quota left; otherwise HOME; CODEX last." `account import` seeds a template. Every lead agent's system context gets a short **Accounts** section (about 1,600 characters at most): fixed instructions, a table of the accounts (id, owner, provider, model and fallbacks, priority, credential source without value, availability when the session started), and the rules text, cut with a pointer to the file when long. The fixed instructions say: use only the accounts listed; test one only with `clawstrum account test ID --model M`; never test by setting `CLAUDE_CONFIG_DIR` or by a shell login; change a conversation's account or model with `clawstrum switch`; do not ask the person to log in for an account whose credential is a token. Anything that looks like a Claude token is removed from the rules text before it is shown. The `model-router` skill carries the same rules with the exact commands.

## Live changes

The daemon checks `config.json` and `accounts.json` every few seconds. A valid change replaces the account list used by routing, memory review, group review and subagents: new and removed accounts, priorities, models and tokens apply at the next routing decision, and cached subagent pools are rebuilt. Running turns are not interrupted. The daemon logs `accounts_reloaded` with account ids only. An invalid or unreadable file (bad JSON, failed validation, permissions too open) keeps the old list and logs `accounts_reload_failed` once until the file changes again. Other `config.json` edits still need a restart.

### Per-conversation model

```sh
clawstrum switch SESSION ACCOUNT                   # this account, its own model
clawstrum switch SESSION ACCOUNT --model MODEL     # this account, this model for this conversation
clawstrum switch SESSION ACCOUNT --model default   # clear the model request
clawstrum status SESSION                           # shows account, preferred account and model override
```

In Discord: `!clawstrum switch ACCOUNT [--model] MODEL`, or `/clawstrum action:switch account:ID model:MODEL`. The model is stored for that conversation only (metadata `model-override:<session id>`; no schema change) and is used on that account. If the account refuses it (no access, no such model) or its limit for that model is exhausted, routing falls back to the account's own primary model and fallbacks and posts the usual fallback notice naming the preferred model; if the account has no other model, the refusal is reported. A switch always sets account and model together: without `--model` the account's own model is used. A model that is not one of the account's configured models has no quota bucket mapping, so a limit hit on it cools the whole account; map buckets in `modelFallbacks` for model-specific cooling.

## Quota observations

| Execution path                                               | Observations consumed                                                                                                | Limits                                                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Agent SDK                                             | Native quota events with utilization, bucket and reset when supplied                                                 | Missing fields stay unknown; errors also drive reactive fallback                                                                                  |
| Codex interactive lead and research subagents via App Server | `account/rateLimits/updated` primary/secondary windows, `usedPercent / 100`, reset seconds converted to milliseconds | Bucket names are `<limitId>:primary` or `<limitId>:secondary`, with `codex` as the missing-ID fallback; no inferred equivalence to Claude windows |
| Codex scheduled lead work via TypeScript SDK                 | Structured failures and recognized quota errors                                                                      | The pinned SDK event union supplies no utilization windows                                                                                        |

`quotaBuckets` and ordered `modelFallbacks` are implemented. They share the profile's login and concurrency cap, and only operator-mapped buckets constrain a specific model. Shared or unknown rejections conservatively cool the whole account. Proactive exclusion requires a known reset and a recognized short-window or explicitly mapped model bucket; merely receiving a Codex percentage does not identify its scope. `quotaWarningThreshold` controls notices independently. See the [configuration example](setup.md#model-fallback-and-quota-notices).

No private quota polling or paid probe prompts are implemented, and provider quota windows are not combined into a universal subscription meter. Separately, [normalized token observations](research-continuity.md#resource-accounting) can be grouped by role, provider and account; missing fields remain unknown. Subscription quota is not an API-dollar bill; multiple profiles do not imply independent entitlements if they authenticate the same underlying account.
