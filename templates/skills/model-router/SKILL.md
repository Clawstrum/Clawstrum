---
name: model-router
description: Which Clawstrum subscription account and model a conversation uses, how to check an account, and how to switch without a restart
triggers: which account, which model, switch account, switch model, change the model, account login expired, test the account, account token, HOME, WORK, quota, account rules
not_for: Model choice for a research experiment's own API calls, or provider outages that are not about which account Clawstrum uses.
examples: change this channel's model to Fable | is the HOME account logged in | use WORK until it hits its limit, then my personal account | add a new account
---

Use this skill whenever the question is which account or model a conversation runs on, whether an account works, or how to change either. Read the Accounts section of your instructions first: it lists the accounts, how each one is authenticated, and the owner's rules.

## Where things are

- Accounts: `accounts.json` in the Clawstrum state directory (`CLAWSTRUM_HOME`), a private file (mode 0600). If it does not exist, the accounts are in `config.json`. `clawstrum account list` shows the live list, each account's owner, priority, models, `credential` and availability. It never prints a token.
- Owner's rules for which account to use and when to switch: `ACCOUNTS.md` in the same directory. Follow them. They are the person's decision, not yours.
- `credential` tells you how the daemon logs in: `token in accounts.json`, `env VAR (set|missing)` (a token in the daemon's `.env`), or `profile login at HOME`. Those are the only credentials. Do not search the disk for tokens, do not read `.env` or `accounts.json`, and do not print or copy a token anywhere.

## Check an account or a model

Run exactly one of these. It sends one short prompt through the same executable, home, token and environment filtering the daemon uses:

```sh
clawstrum account test ACCOUNT
clawstrum account test ACCOUNT --model MODEL
```

Never test an account by setting `CLAUDE_CONFIG_DIR` or `CODEX_HOME` to its profile, or by running `claude` or `codex` from a shell. An account whose credential is a token is not authenticated by its profile home, so that test reports a login problem that does not exist.

Do not ask the person to log in for an account whose credential is a token. If `account test` fails with an authentication error for such an account, say which account and the exact error and ask for a new token; the person stores it with `printf %s "$TOKEN" | clawstrum account set-token ACCOUNT`.

## Switch account or model, no restart

```sh
clawstrum switch SESSION ACCOUNT                  # this conversation uses ACCOUNT, with its own model
clawstrum switch SESSION ACCOUNT --model MODEL    # ... with MODEL (for this conversation only)
clawstrum switch SESSION ACCOUNT --model default  # clear the model request
clawstrum status SESSION                          # account, preferred account, model override
```

SESSION is the conversation id given in your instructions ("Conversation id"). In Discord the owner can write `!clawstrum switch ACCOUNT [MODEL]`. If the account refuses the requested model or its limit for it is used up, routing falls back to the account's own models with a notice that names the preferred model. An explicit model request is never replaced silently.

## Add or change an account

Edit through the commands; the daemon applies the change within seconds and logs `accounts_reloaded`. An invalid file is ignored and logged as `accounts_reload_failed` and the old list stays.

```sh
clawstrum account add ID claude --owner NAME --model MODEL --priority N
clawstrum account edit ID --priority N --model MODEL --owner NAME   # "none" clears a field
clawstrum account remove ID
printf %s "$TOKEN" | clawstrum account set-token ID                 # token from stdin, never an argument
clawstrum account reset ID                                          # clear a cooldown
```

Do not write a token into a chat message, a command line, a file in a workspace or `ACCOUNTS.md`.

## Routing in one paragraph

Higher `priority` is tried first; within a priority the model tier and quota headroom decide. A conversation switched to an account uses that account first and falls back to the others. A subagent with an explicit model is tried on every account of its provider before it fails.
