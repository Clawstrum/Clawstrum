# Hooks and gates

Clawstrum checks what the agent writes and reviews each outgoing reply once before it goes to Discord. None of these checks confines the agent. Every conversation keeps full host access, and shell commands can still do what a refused tool call would have done.

## Validation modes

`research.validation` sets how content checks act.

| Mode       | Effect                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advisory` | Default. Findings are recorded and returned to the agent. Nothing is refused.                                                                                                         |
| `strict`   | Findings are refused or held as each check below says.                                                                                                                                |
| `off`      | Turns off the content checks, subagent routing and the outgoing reply review. The secret-file block, paper push gate, subagent file holds and the restore after compaction still run. |

## Tool-call checks

These run as hooks before each tool call. Gemini runs them through Antigravity CLI's own hook file, `<account home>/.gemini/config/hooks.json`. Codex gets the hook when it starts, and Clawstrum marks it as trusted in `<account home>/config.toml`, because Codex skips a hook it doesn't trust. If the hook still isn't trusted, the run stops instead of going on unchecked. A Codex file edit is checked once for each file it touches. On Codex and Gemini only refusals get through: notes, the `nice` prefix and other changes to a tool call are dropped there. Findings are saved as `research_validation` events. The agent sees at most ten findings per call.

- A Write or Edit to a `.md`, `.markdown`, `.tex`, `.bib` or `.rst` file is checked for author and year pairs that disagree with the saved record of the DOI or arXiv ID next to them. An Edit only reports problems it introduces. In strict mode, the first citation finding per run and agent refuses the write once.
- A Write or Edit outside the channel folder, the Clawstrum home, the system temp folder and `research.writeRoots` is reported. In strict mode it is refused every time.
- Where a `WRITING.md` exists, strict mode refuses a write of 300 or more characters to a `.tex`, `.sty` or `.cls` file until the agent has read it, directly or through a skill with "writing" in its name. It refuses at most three times per agent between compactions.
- Writes to `.tex`, `.sty` or `.cls` files (where a writing-rules file exists) and plotting code in `.py` files get style advice. This advice never refuses a write, in any mode. Payloads over 2,000,000 characters are skipped.
- When Slurm support is on, a raw `sbatch` command gets advice to use `research_cluster preflight` and `submit`, which check the script and start a job watch.
- Fetching a PDF directly gets advice to use `research_paper`. An Unpaywall request without an email gets advice to set `research.email`.

The citation check reads only saved Crossref, DataCite and arXiv records. It recognizes forms such as `Doe (2024)`, `Doe et al. (2024)`, `(Doe, 2024)` and plain BibTeX fields, and allows a one-year difference. Ambiguous pairings, TeX-encoded fields and code fences are skipped. A clean result means no detected mismatch, not that every citation is right.

Every provider can scan any text or file with `research_citation action=scan` and exactly one of `text` or `path`, up to 2,000,000 bytes.

## Secret files

With `research.enabled` on, a hook refuses a tool call that would print a secret file, in every validation mode, and logs `secret_print_blocked`. It covers:

- a Read of `.env` or `.env.*`, `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.netrc`, `.pgpass`, `.aws/credentials`, `.git-credentials`, `credentials.json`, `.config/gh/hosts.yml`, or a file named `secret` or `secrets` with the extension `.env`, `.json`, `.yaml`, `.yml` or `.txt`
- a shell command where `cat`, `less`, `head`, `tail`, `grep`, `sed`, `awk` or a similar reader names one of these files
- `env`, `printenv`, `export -p` and `declare -x`

Commands that reduce the output to names, counts or masked values pass, for example `| cut -d= -f1`, `| wc` or `grep -c`. The hook knows only these patterns: `python3 -c "print(open('.env').read())"`, reading a copy under another name, or `source .env; echo $KEY` get through.

## Subagent routing

`research.workers.enforceRoles` (`deny` by default, or `advise`, `off`) handles native Task, Agent and Workflow dispatch. With `deny`, the call is refused and the agent is told to use `research_delegate`, which applies the configured role's model, effort and limits. It applies only when roles are configured and never limits the lead's own tools. `research.validation: off` also turns it off.

## Paper push gate

`research.workers.review.paperPush` (`off` by default, or `advise`, `deny`) checks a Claude or Gemini lead's `git push` of paper changes. Subagent pushes are not checked. It does not depend on `research.validation`.

Compared with the upstream merge base, the push triggers the gate on a changed caption, section heading, figure or `\includegraphics` line, abstract text, number or image, or on 800 or more changed characters. Such a push needs a checker or reviewer result after the first `.tex` edit. `deny` refuses at most three times per change and `advise` adds a note. What git cannot answer is allowed and recorded as `research_paper_push_gate`.

## Outgoing reply review

Before a reply enters the Discord queue, Clawstrum checks it for citation mismatches and length. This covers `send_message` text, `send_file` captions and prose attachments, and the automatic final reply, on every provider.

| Setting                   | Default |
| ------------------------- | ------- |
| `research.reply.maxLines` | 25      |
| `research.reply.maxChars` | 2000    |

Set either to 0 to drop that limit, or both to 0 to drop the length check.

In advisory mode, findings are recorded, a tool call gets them with its result, and the reply goes out. In strict mode, the first reply with a finding is held. A tool call gets an error to fix. An automatic final reply gets one extra model call with the feedback and the path of the saved draft. Each incoming message gets one such correction across all parts, retries, restarts and account switches.

Each finding creates a `research_reply_review` event and a JSON file under `CLAWSTRUM_HOME/research/reply-reviews/<session>/` with the draft, the scan, the mode and whether it was held. These files are kept until you delete them, so include them in backups.

## Subagent results

Before the lead gets a subagent's result, Clawstrum checks it against the subagent's event log. The lead gets a caveat if the subagent ran no tools, if none of the paths in its brief appear in its events, or if it cites absolute paths that don't exist. The result is never withheld.

## Compaction

After Claude compacts its context, the next session start restores the channel's state. If a compaction finishes without that, the next tool call gets the same state once, even when validation is off. See [memory](memory-lifecycle.md#background-passes).

## Cost

None of these checks calls a model, except the one strict correction of a final reply.
