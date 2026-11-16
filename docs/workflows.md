# Workflows

Optional tools the agent uses: condition watches, linting of decisions, prose and figures, and research skills. For backups, planned restarts and recovery, see [operations](operations.md). For self-review, see [customizing](customize.md#self-review).

## Feature defaults

- Research tools, background tasks, consolidation, history and Slurm helpers are on by default. Each depends on your accounts and host tools: Slurm helpers submit nothing on their own, and paper services need your keys or contact details.
- Defaults apply to settings you leave out. An upgrade keeps an explicit `false`. See [configuration](configuration.md).
- Guided setup schedules a nightly self-review in the main channel. No backup timer is turned on.

## Condition watches

Use a watch when the trigger is a file or a cheap command. Use a scheduled task when it is a time. A watch makes no model calls while it waits.

```json
{
  "condition": { "type": "file", "path": "results/summary.json", "nonempty": true },
  "message": "Validate the measurements and attach the summary.",
  "intervalMs": 60000,
  "timeoutMs": 86400000,
  "warnAfterMs": 3600000
}
```

```sh
clawstrum watch add SESSION --key experiment-summary --input watch.json
clawstrum watch list SESSION
clawstrum watch cancel WATCH_ID
```

The lead agent has a `watch` tool with `action` `add`, `list` or `cancel`. `add` takes the same spec and a `key`, and `cancel` takes an `id`. Keys belong to one conversation. Adding the same key with the same spec returns the existing watch, and a changed spec needs a new key. Paths are relative to the conversation's workspace.

A command condition looks like `{"type":"command","argv":["program","argument"],"cwd":"."}`. Arguments go to the program directly, with no shell unless you name one. Exit 0 means done, any other exit means not yet, and errors and timeouts are stored as `lastError`. A probe can run twice after a crash, so it should only look, not change anything. Commands have full host access.

| Setting          | Default        | Limit                            |
| ---------------- | -------------- | -------------------------------- |
| `checkTimeoutMs` | 10 seconds     | at most 60 seconds               |
| `intervalMs`     | 1 minute       | at least 1 second, at most 1 day |
| `timeoutMs`      | 1 day          | at most 30 days                  |
| `warnAfterMs`    | 0 (no warning) | less than `timeoutMs`            |

At most four probes run at once. A probe that times out is killed with its process group. A file that already meets the condition fires at the first check. When a watch fires, expires or warns, the agent gets the message once. An expiry says the condition was not met. Watches survive a daemon restart. `doctor` reports overdue watches. `stop SESSION` doesn't cancel watches or jobs, so cancel them yourself.

## Decision linting

```sh
clawstrum decisions lint /project/decisions.md
clawstrum decisions lint /workspace/decisions.md --shared-target /project/decisions.md
```

It prints findings as JSON and exits 1 if there are any. It never edits the file or blocks a tool. It finds duplicate active tags, malformed entries, invalid dates and retired entries with no reason. Fenced examples are skipped. Tags may use letters, digits, `.`, `_` and `-`. Entries under a `Superseded`, `Retired` or `History` heading are inactive. `--shared-target` also checks that the file is a symlink to that target.

```md
## Active

- 2026-09-17 [report.v2]: Save full results as an artifact.

## Superseded

- 2026-09-10 [report.v1]: Superseded by [report.v2].
```

The `decision-hygiene` skill in `templates/skills/` describes how to keep the file. The lint can't tell whether two differently tagged decisions contradict each other.

## Prose linting

```sh
clawstrum prose lint /project/manuscript.tex
clawstrum prose lint /project/notes.md
```

It checks three things: em dashes (the Unicode character U+2014 or LaTeX `---`, except in rules and table separators), bold inside a line (markdown `**bold**`, `\textbf{}`, `{\bf }`, but not a bold run that opens the line) and headings that argue (a fixed list of verb-led openings, or ending in `.` or `?`). It prints findings as JSON, exits 1 if there are any, and never edits the file. Fenced blocks, `verbatim`, `lstlisting`, `minted`, LaTeX comments and front matter are skipped. Word choice, passive voice and sentence length are left to your own rules file.

On Claude runs with research tools on, the same checks also run on every `.tex`, `.sty` and `.cls` write. The findings come back to the agent on that tool call and never block it. An edit reports only the findings it adds. In strict mode, the manuscript write gate also refuses a large `.tex` write until your writing rules are in context.

The gate and the automatic check stay off until a `WRITING.md` exists in the workspace or in the Clawstrum home (for every workspace). Start from `templates/skills/onboarding/WRITING.example.md`, copied to `skills/onboarding/` in the home, and edit it.

## Figure linting

```sh
clawstrum figures lint /project/scripts/make_figure.py
```

It prints findings as JSON, exits 1 if there are any, and never edits the script. It finds five defects:

- axes are plotted into but neither axis is labeled anywhere in the file
- a rainbow colormap (`jet`, `rainbow`, `gist_rainbow`, `hsv`, `nipy_spectral`, `Spectral`, with or without `_r`) set through `cmap=`, `set_cmap(` or `colormap=`
- `plt.show()` with no `savefig(` in the file
- `plt.figure(` or `plt.subplots(` inside a loop in a file that never calls `.close(`
- a font size below 8 pt, in a `set_*` call or in the `font.size`, `axes.labelsize`, `xtick.labelsize`, `ytick.labelsize`, `legend.fontsize` or `axes.titlesize` rcParams

Comments are ignored. The check matches text and doesn't run Python. The same checks run on every `.py` write on the same terms as the prose checks, with no rules file needed. Very large writes are skipped.

## Research skills

`clawstrum init` installs the skills in `templates/skills/` into a new home and leaves existing skill folders alone. In an older home, copy the ones you want into `H/skills`. Skills describe a procedure. None of them enforces anything.

| Skill                | Use                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `theory`             | Derivations. An analytical result isn't trusted until it is checked numerically against code                                          |
| `plotting`           | Decide what a figure must show before drawing it                                                                                      |
| `scientific-writing` | State each claim at the strength its evidence supports                                                                                |
| `brainstorm`         | Generate options before judging them                                                                                                  |
| `iterate`            | One critique pass against a fixed checklist before important output goes out                                                          |
| `reviewers`          | Judge work in progress or a final draft                                                                                               |
| `harness-health`     | Diagnose a slow or stuck daemon from `performance`, `usage profile`, `workers profile` and the consolidation and memory review events |
| `decision-hygiene`   | Keep a decisions file                                                                                                                 |
| `self-review`        | The nightly review. See [customizing](customize.md#self-review)                                                                       |
| `onboarding`         | The first conversation after setup                                                                                                    |
| `customize`          | Later changes to instructions, skills, tools and code                                                                                 |
| `model-router`       | Which account and model a conversation uses, and how to switch without a restart                                                      |

A subagent role lists the skills its subagents get under `research.workers.roles.<role>.skills`. The lead gets every installed skill. By default `analyst` gets `theory`, `coder` gets `iterate`, `thinker` gets `brainstorm`, and the other roles get none. A role may name a skill that isn't installed. The subagent still runs, and its `research_worker_route` event lists the name under `skillsMissing`.
