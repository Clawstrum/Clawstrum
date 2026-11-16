# Jev decisions

Jev is a paid API from TypeSafe (https://typesafe.ai) that answers small typed questions. Clawstrum calls it only when `JEV_API_KEY` is set. Without a key everything works, and each decision falls back to a local rule. A chat model on OpenRouter can take Jev's place, see [OpenRouter](#openrouter).

Jev does not run the agent, write memory or decide permissions. It never starts a subagent or changes a channel's model. Your instructions and explicit subagent model choices come first.

## Decisions

| Feature                    | With Jev                                                                                                                       | Without a key, or when the call fails                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Skill suggestions          | Picks one installed skill from the message, the last 2 agent replies and each skill's criteria, and loads its `SKILL.md`       | Loads the top keyword match's `SKILL.md`, marked as possibly wrong, lists other matches and the full catalog |
| `history action=rank`      | Reranks up to 12 keyword matches from the channel's history                                                                    | Returns the keyword search order                                                                             |
| `research_subagent_advice` | Suggests a configured role, or keeping the task with the lead                                                                  | Returns the configured roles and models so the lead chooses                                                  |
| Message recall             | Checks research notes no longer in memory against each message and adds matching ones to the prompt (`research.messageRecall`) | Off                                                                                                          |

The fallback also covers timeouts, invalid replies, rate limits, oversize requests and the daily budget. Clawstrum never switches to another paid API on its own. Ranking searches only the scope you ask for. `history search`, `list` and `read` always cover everything.

## Configuration

Put `JEV_API_KEY` in the daemon's private `.env`, not in `config.json`. `TYPESAFE_API_KEY` also works when `apiKeyEnv` is left at its default.

The optional `decisions` block in `config.json` defaults to:

```json
{
  "decisions": {
    "enabled": true,
    "provider": "jev",
    "model": "jev-1.13.0",
    "apiKeyEnv": "JEV_API_KEY",
    "foregroundTimeoutMs": 1000,
    "backgroundTimeoutMs": 10000,
    "maxConcurrent": 4,
    "maxRetries": 1,
    "maxRequestBytes": 24000,
    "dailyBudgetUsd": 1,
    "inputUsdPerMillion": 0.042,
    "cacheTtlMs": 86400000,
    "history": true,
    "skills": true,
    "workers": true,
    "memoryReview": false
  }
}
```

`history`, `skills` and `workers` turn single features off. `model` must be a pinned version such as `jev-1.13.0`. `memoryReview` is accepted for old configs and does nothing. The time limits include retries. A request over `maxRequestBytes` falls back instead of being cut. See the [API contract](https://docs.typesafe.ai/api).

## OpenRouter

[OpenRouter](https://openrouter.ai) sells many companies' chat models through one key. With `"provider": "openrouter"` in `decisions`, the same questions go to one of those models, with the same features and fallbacks. Put the key in `OPENROUTER_API_KEY` in `.env`. Only `config.json` picks the provider. An OpenRouter key alone never turns it on, and the Jev key is not used while it is on.

```json
{
  "decisions": {
    "provider": "openrouter",
    "openrouter": {
      "model": "openai/gpt-4.1-nano",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "foregroundTimeoutMs": 3000,
      "inputUsdPerMillion": 0.1,
      "outputUsdPerMillion": 0.4
    }
  }
}
```

These are the defaults. The reply must match a JSON schema, or the call falls back. Confidences are the chat model's own estimates and are not calibrated like Jev's.

- Use a fixed model ID whose OpenRouter page lists structured outputs and temperature. Router IDs such as `openrouter/auto` are refused.
- When you change the model, change both prices to its list prices in USD per million tokens. They count against `dailyBudgetUsd`.
- The foreground limit is 3 seconds instead of 1. Skill suggestions and message recall wait for it before a turn starts.
- Requests go to OpenRouter and to the company serving the model. OpenRouter's [privacy settings](https://openrouter.ai/settings/privacy) decide whether providers that keep or train on prompts may be used.

## Costs and profiles

Before each call, Clawstrum reserves an estimate of its input cost from the request size and replaces it with the reported usage. When the day's total (UTC) reaches `dailyBudgetUsd`, decisions fall back until the next day. It is an estimate, not an exact billing cap. Identical questions within `cacheTtlMs` reuse the cached answer.

Each request and its answer are saved under `H/research/decisions/<id>.json`, without keys or headers. Nothing deletes them automatically.

```sh
clawstrum jev profile --since 2026-09-22 --limit 100
clawstrum jev profile SESSION --offset 100
```

These show per-call latency, tokens, cache hits and estimated cost, and need no key. Totals cover the returned page only, so follow `nextOffset`. In a channel, `research_status collection=decisions` shows the same for that channel.

A source checkout can replay recorded test cases with `node scripts/eval-jev.mjs`, or call the live service with `--live --out NEW_DIR` (add `--provider openrouter` for OpenRouter).
