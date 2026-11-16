# Installing Clawstrum

If the user wants to install, set up or start Clawstrum (or says "help me install", "get started", "set up"), do not improvise. Read `.claude/skills/setup/SKILL.md` completely and follow it step by step. It is written for people who have never used a terminal: one question at a time, every step checked before the next, and the Discord bot token is never typed into this chat.

Contributing to Clawstrum is a different task; see the section below.

# Contributing to Clawstrum

Clawstrum is a harness that runs Claude Code, Codex or Gemini (Antigravity CLI) as a persistent research agent in Discord.

## Build

    npm ci
    npm run build

## Checks

    npm run typecheck
    npm test

The full test suite is heavy; run it on a machine where you have the CPU for it.

## Changes

- Changes go to `main` as pull requests, which are reviewed before merging.
- Keep personal instructions, credentials and deployment files out of the repository. They live in your own private copy.
- The docs in `docs/` describe the code as it is.
