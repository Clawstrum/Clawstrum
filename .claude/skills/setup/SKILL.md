---
name: setup
description: Guided first-time install of Clawstrum. Use when the user wants to install, set up or configure Clawstrum, connect it to Discord, or get their agent running. Triggers on "setup", "install", "get started", "set up Clawstrum", and on a fresh clone with no ~/.clawstrum folder. Walks a non-programmer from nothing to a first message answered by their agent in Discord.
---

# Clawstrum guided setup

You are helping someone install Clawstrum. They may have never used a terminal. The goal: the user sends a message in their main Discord channel and their agent answers. Do not stop before that.

## Rules for you

1. One question at a time. Wait for the answer. If your tool list has a question tool (Claude Code's `AskUserQuestion`), you may use it; otherwise ask in plain chat.
2. Plain words. Say "server", not "guild". When you must use a technical word, explain it in the same sentence.
3. Check every step before the next one. Name the command you ran and say what it showed. Never say "should be fine".
4. The user only does what needs a person: make a Discord account, make a server, use the bot page in the Discord developer portal (copy the token, turn on one switch), and click the invite link. Everything else you do or read from the machine.
5. The bot token is a password for the bot. It never goes into this chat. Never ask for it, never repeat it, never print it. Never read `.env` (no `cat`, `Read`, `grep` that prints it, no `env` or `printenv` without `| cut -d= -f1`). You only run checks that print yes or no. Why: this chat is saved on the model provider's servers and in local transcripts, and anyone who has the token controls the bot. If the user pastes it into the chat anyway, tell them: "Please reset the token on the Bot page (Reset Token) and put the new one only in the file." Do not use the pasted one.
6. Do not use `sudo` unless the user agrees to that exact command. Fix problems yourself when you can (see the fixes below); only hand a step to the user when it needs their hands.
7. If a command is blocked by your sandbox or permission prompt, say which command, and ask the user to approve it or to run it themselves in a normal terminal. Do not look for a way around it.
8. Use placeholders below as `<LIKE_THIS>`. Fill them from real answers or command output, never from memory.

Words you will use with the user, in plain terms:
- *terminal*: the window where you type commands.
- *second terminal*: a new terminal window, separate from the one where this chat runs. The user opens it when you ask.
- *Clawstrum home*: the folder where Clawstrum keeps its settings and the bot token. It is `~/.clawstrum` unless the user sets `CLAWSTRUM_HOME`.

Some steps below use two options of `clawstrum setup`: `--status` (prints JSON: what is done, what Discord reports, and the next step; writes nothing) and `--main-channel` (finds or makes the first channel and writes the settings). Step 1 checks that they exist.

`clawstrum setup --status` prints one JSON object. The keys used below: `node.ok`, `node.nightlyReviewOk`, `token.saved`, `token.looksValid`, `discord` (null until a token is saved) with `discord.tokenAccepted`, `discord.bot.username`, `discord.applicationId`, `discord.messageContentIntent`, `discord.inviteUrl`, `discord.guilds[]` (`id`, `name`, `ownerId`, `ownerName`, `canManageChannels`, `textChannels`), then `mainChannel` (`id`, `name`), `review.scheduled`, `login.signedIn`, and `next` (one of `save-token`, `message-content-intent`, `invite-bot`, `main-channel`, `login`, `start`) with a `hint`. Use `next` to decide which step comes next: `save-token` and `message-content-intent` → step 2c, `invite-bot` → 2d, `main-channel` → 4, `login` → 5, `start` → 6.

## Step 0. Which agent is running this?

You know which one you are. Say it once: "I am running inside Claude Code" or "I am running inside Codex". It only matters for two things: the question tool in rule 1, and the sandbox note in rule 7 (Codex may block writes outside the repo folder; Claude Code may ask for approval per command).

Do not mix this up with the provider the user will pick in step 3. Setup can run inside Codex and still use a Claude subscription for the agent, and the other way round.

If `command -v clawstrum` prints a path, run `clawstrum setup --status` before anything else. If it shows `mainChannel` set, Clawstrum is already set up here: tell the user, and go straight to the step `next` names instead of starting over.

Then say, in your own words: "I will walk you through five things: check this computer, make a Discord bot, choose how your agent signs in, make your first channel, and start the agent. About 20 to 30 minutes, most of it Discord screens. You do the parts that need a person; I do the rest."

Ask: "What do you want to call your agent? (1 to 40 characters, for example `Atlas`.)" Remember it as `<AGENT_NAME>`.

Ask: "Where will your agent run? (a) a computer you use day to day, like a laptop; (b) a computer that stays on, such as a lab server or a cloud machine you reach over SSH; (c) a shared computing cluster, where jobs go through a scheduler such as Slurm." Remember it as `<WHERE>`: `personal`, `server` or `cluster`. The agent works only while that computer is on and awake, so (a) is for trying it out and (b) or (c) for daily use. This setup must run on that same computer, on a cluster on a login node (the machine you land on when you log in). If it runs somewhere else, stop: the user clones the repository there and starts the setup again.

## Step 1. This computer and the install

Check, then fix.

```sh
uname -sm
node --version
npm --version
git --version
```

**Operating system.** Linux and macOS are supported. Windows is not tested: tell a Windows user to install WSL (Windows Subsystem for Linux, a Linux inside Windows), open it, clone the repository there, and start this setup again inside it.

**On a cluster** (`<WHERE>` is `cluster`), also run:

```sh
node -p 'require("os").hostname()'
echo "job: ${SLURM_JOB_ID:-none}"
command -v tmux
```

- `job` shows a number: this terminal is inside a job, and the agent would stop when the job ends. Ask the user to open a plain login (SSH to the cluster, no `salloc` or `srun`) and start this setup again there.
- The first line is this machine's exact name. Remember it as `<NODE>`. Clusters usually have several login nodes behind one address, and the agent will live on this one. Tell the user: "Your agent will run on `<NODE>`. To get back to it later, log in to exactly that node: `ssh <NODE>`, from your computer or from another login node."
- Ask: "Does your cluster allow a light program to keep running on a login node for days?" Many allow it for programs that mostly wait, as this one does, and some do not; the agent's heavy work goes into jobs (step 4 sets a limit for that). If the user does not know, the cluster's documentation or help desk does. If it is not allowed, they ask the help desk where a long-running service may go (some clusters offer a service machine); finish the setup here anyway and move it later.
- Whenever this guide asks for a second terminal, on a cluster it must be on `<NODE>` too: tell the user to open it with `ssh <NODE>`. Clawstrum commands on any other node are refused once step 1 has pinned the database to `<NODE>`.
- `tmux` keeps a terminal session running after you log out; step 6c uses it. If `command -v tmux` prints nothing, try `module avail tmux` or ask the help desk.

**Node.js.** Clawstrum needs Node 22.13 or newer. Do not ask for more up front. If `clawstrum setup` or `clawstrum setup --status` later warns that Node is older than 22.16, tell the user plainly: "Update Node to 22.16 or newer, otherwise the nightly self-review and live backups will not run."
- Too old or missing: ask "Node.js is too old or missing. May I install a current one?" If yes:
  - macOS with Homebrew: `brew install node@22`, then follow what brew prints about adding it to the PATH (the list of folders the shell searches for programs).
  - Otherwise: install nvm (Node Version Manager) from https://github.com/nvm-sh/nvm following its README, open a new terminal, then `nvm install 22`.
  - After installing, run `node --version` again in a new shell.

**Install.** Run these from the repository folder, one at a time, and read each result:

```sh
npm ci
npm run build
npm link
```

- `npm ci` downloads the packages. It must include optional packages: they hold the Claude and Codex programs. Check `npm config get omit` prints nothing (or at least not `optional`). If it prints `optional`, run `npm config delete omit` and repeat `npm ci`.
- `npm run build` compiles the code into `dist/`.
- `npm link` puts a `clawstrum` command on the PATH that runs this folder. The agent can then change Clawstrum's own code here later (`clawstrum apply` checks and tests a change before it goes live). Tell the user to keep this folder where it is: moving or deleting it breaks the command.

`npm run check` (type check plus the full test suite) is for people who change the code. It takes several minutes of CPU and is not needed to install; run it only if the user asks.

For a fixed install without the source, `npm pack` and `npm install --global` of the archive it prints work too, but then the agent cannot change Clawstrum's code (docs/customize.md). Both ways write into npm's global folder.

If `npm link` fails with `EACCES` (permission denied): do not use `sudo`. Give npm a folder the user owns:

```sh
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
```

Then add `export PATH="$HOME/.npm-global/bin:$PATH"` to the shell's startup file (`~/.zshrc` on macOS, `~/.bashrc` on most Linux), with the user's yes, open a new terminal, and repeat the install.

**Check the install:**

```sh
command -v clawstrum
clawstrum --version
clawstrum setup --help
```

All three must work. The help text must list `--status` and `--main-channel`. If it does not, this copy of Clawstrum is older than this guide: tell the user, and point them to the manual setup in `docs/setup.md`. Do not continue.

**Where Clawstrum keeps its files.** Run `echo "${CLAWSTRUM_HOME:-$HOME/.clawstrum}"` and call the result `<HOME>`. The database in it must be on a local disk, not a network drive. On Linux, check:

```sh
df -T "$(dirname "<HOME>")" | tail -1
```

On macOS skip this check (the home folder is on the computer's own disk unless the user says otherwise; `df -T` means something else there).

If the type is `nfs`, `nfs4`, `lustre`, `gpfs`, `cifs` or similar, the folder is on a network drive:

- Not on a cluster: ask where a local folder is (for example `/tmp` is not good; use a folder on the computer's own disk), and use `export CLAWSTRUM_HOME=/that/folder` for every later command. Tell the user to add the same line to their shell startup file, because later commands and the background service need it.
- On a cluster: a login node's own disk (`/tmp`, local scratch) is usually emptied at reboots or purged, so keep the home on a network drive and make the database safe there. That needs NFS version 4. If the type is `nfs4`, keep `<HOME>`. If it is `nfs` (version 3) or another type, file locks there can freeze the database: ask the user for a folder of theirs on an `nfs4` drive (lab or project storage often is; check it with the same `df -T`), and set `CLAWSTRUM_HOME` to a new folder inside it as above; that folder is `<HOME>` from here. Then, before any later step creates the database, make the folder (`mkdir -p -m 700 "<HOME>"`) and write `<HOME>/STORAGE.json`:

```json
{ "host": "<NODE>", "directory": "<HOME>", "journalMode": "DELETE" }
```

`DELETE` is the SQLite journal mode that works on an NFS 4 drive when only one computer writes (the default, WAL, does not work over a network file system). `host` pins the database to `<NODE>`: a `clawstrum` command on another node refuses to open it and names `<NODE>`, so two copies can never write at once. The interactive `clawstrum setup` warns that the home is on a network file system; with this file that is expected.

Say what passed. Then go on.

## Step 2. The Discord bot

Tell the user plainly: "Your agent lives in Discord. It will be a bot (an automatic account) in a server (a group of channels) that you own. I need you for four things: an account, a server, the bot page, and one click on an invite link. After each one I check it from here."

### 2a. Account

Ask: "Do you already have a Discord account?"
- No: send them to https://discord.com/register. They need an email address, a username, a password and a date of birth, and must confirm the email. Wait until they say they can see the Discord app or website, logged in. (Discord's screens change; if a label below is not exactly there, look for the closest one.)
- Yes: continue.

### 2b. A new server

Ask: "Do you want a new server just for your agent (recommended), or use one you already own?" A new server is simplest: you are the owner and nothing else is in it.

New server: in Discord, the plus button at the bottom of the server list (left side), then **Create My Own**, then **For me and my friends**, name it anything, **Create**. The server must be one the user owns.

If they want to use an existing server: ask "Did you create that server yourself?" If yes, use it. If not, a new server is still the easy way. If they must use that server: someone there with the Manage Server permission has to click the invite link in 2d, and the user gives their own Discord user ID (Discord settings, Advanced, turn on Developer Mode; then right-click their own name, Copy User ID) to use as `<OWNER_ID>` in step 4. Without that, the agent would answer only the server's owner.

### 2c. Create the bot (developer portal)

Create `<HOME>` and an empty token file now, so the user has a place to put the token. This holds no secret yet:

```sh
H="<HOME>"
mkdir -p -m 700 "$H"
[ -e "$H/.env" ] || ( umask 077; printf '# Discord bot token; do not commit this file.\nDISCORD_BOT_TOKEN=\n' > "$H/.env" )
chmod 600 "$H/.env"
```

Then tell the user, one numbered list, and wait for "done":

1. Open https://discord.com/developers/applications (same account).
2. **New Application**, name it `<AGENT_NAME>`, accept the terms, **Create**.
3. Left side, **Bot**. Under **Privileged Gateway Intents** turn on **Message Content Intent** (this lets the bot read what you write; without it the agent cannot start). You do not need the other two switches. **Save Changes**.
4. Still on the Bot page, click **Reset Token**, confirm, and **Copy** the token. It is shown only once. Do not paste it here.
5. Open a *second terminal* (not this chat). Run: `nano -w "<HOME>/.env"` (use the real path; `-w` stops the editor from breaking the long line). Put the cursor right after `DISCORD_BOT_TOKEN=`, paste the token with no spaces and no quotes, keep it on that one line. Save with Ctrl+O then Enter, leave with Ctrl+X. (Nano is a small text editor that is on macOS and Linux. Any plain text editor works if the user prefers one.)

Check without printing anything secret:

```sh
grep -Ec '^DISCORD_BOT_TOKEN=.{50,}$' "<HOME>/.env"
```

`1` means a token is there. `0` means the line is empty, wrapped over two lines, or too short; ask the user to redo step 5.

Now ask Discord whether the token works:

```sh
clawstrum setup --status
```

From the JSON you need: `discord.tokenAccepted`, `discord.bot.username`, `discord.applicationId`, `discord.messageContentIntent`, `discord.inviteUrl`, and `discord.guilds` (empty for now).

Never print or quote the token if it appears anywhere (it should not).

- `token.saved` is false: the token is not in `<HOME>/.env` yet; redo the editor step. `discord.tokenAccepted` is false, Discord rejected the token: the user copied the wrong thing or Reset Token ran again after copying. Redo steps 4 and 5.
- `discord.messageContentIntent` is false (`next` is `message-content-intent`): send the user back to step 3 (Bot page, the switch, **Save Changes**). Check again.
- Both fine: tell the user "Discord accepts the token and the bot is called `<BOT_NAME>`. Application ID `<APPLICATION_ID>`." (IDs are not secret.)

### 2d. Invite the bot

Give the user `discord.inviteUrl` from the status output. Tell them: open it in a browser, choose their new server in the list, **Continue**, **Authorize**, solve the captcha if it shows one. The link asks for these permissions: Manage Channels (so the agent can make the main channel now and a channel per project later), View Channels, Send Messages, Add Reactions, Attach Files, Read Message History, Create Public Threads, Send Messages in Threads (listed in `src/setup.ts`, `INVITE_PERMISSIONS`). Do not remove any.

Check again:

```sh
clawstrum setup --status
```

- The server is in `discord.guilds`: say its `name`. Ask: "Is `<SERVER_NAME>` the server you just made?" If several servers are listed, ask which one by name.
- Remember its `id` as `<SERVER_ID>`, its `ownerId` as `<OWNER_ID>` and its `ownerName` as `<OWNER_NAME>`. Confirm the owner with the user before you use it: "Is `<OWNER_NAME>` your Discord account?" The agent will answer only this person, so a wrong owner means it never answers the user. After a yes, no Developer Mode and no copying of numbers is needed.
- `canManageChannels` is false: the bot cannot make the channel itself; step 4 then asks the user to make it.
- Not listed after 1 minute: the user probably picked another server or stopped before Authorize. Ask them to open the link again.
- The owner shown does not match the user (they used a server someone else owns): stop and go back to 2b with a new server.

## Step 3. Which model account runs the agent

The agent uses a subscription the user already pays for, not an API key.

Ask: "Which do you have: a *Claude* subscription (Claude Code, Pro or Max), a *ChatGPT* subscription (used through Codex) or a *Google* subscription with Gemini (used through Antigravity CLI)?" Only one is needed. Remember `<PROVIDER>` as `claude`, `codex` or `gemini`.

- If none: they need one first. Pause the install here and say what to subscribe to; do not use an API key (Clawstrum does not).
- If `gemini`: the Gemini program, Antigravity CLI (`agy`), is not part of the Clawstrum install. Set it up now, from the repository folder: download the archive for this machine from the releases page github.com/google-antigravity/antigravity-cli/releases (`agy_cli_<os>_<arch>.tar.gz`: `mac` or `linux`, `arm64` or `x64`; `uname -sm` tells which), unpack it into `tools/antigravity-cli-<VERSION>/` (the version number of the release) and make a link named `agy` in that folder to the unpacked `antigravity` program. Clawstrum takes the highest `tools/antigravity-cli-*` version. Without that folder it uses an `agy` on the PATH; if the user already has `agy` elsewhere, set `"executable"` in the `main` account of `<HOME>/config.json` to its full path after step 4. Check: `tools/antigravity-cli-<VERSION>/agy --version` prints a version number.

## Step 4. Create the settings and the first channel

Tell the user plainly, before you run it:

> "I am about to make your first channel, called `main`. This is your **main channel**. It is also your **therapy channel**: the place where you talk to your agent about the agent itself, what to improve, what it got wrong, how you want it to work. Every night the agent reads the day's chats and looks for what went wrong. It writes here only when something needs you; on a quiet night you hear nothing. Your project work goes into other channels later; the agent will help you make them in your first conversation."

Run setup with everything already known. It keeps the token that is already in `<HOME>/.env`, finds or creates the `main` channel in `<SERVER_NAME>`, writes `config.json` with the name, provider and owner, and turns on the nightly self-review in that channel. It does not log in (that is the next step).

```sh
clawstrum setup --main-channel main \
  --guild <SERVER_ID> \
  --owner <OWNER_ID> \
  --provider <PROVIDER> \
  --name "<AGENT_NAME>" \
  --json
```

On success it prints JSON. Check: `channel.id` (remember it as `<MAIN_CHANNEL_ID>`); `created` (true if it made the channel, false if one named `main` was already there); `configCreated`; `ownerId` equals `<OWNER_ID>` and `ownerSource` is `flag` or `config`; `review.scheduled` is true (if false, tell the user `review.reason` in plain words). Tell the user each item of `warnings` in plain words (a Node older than 22.16 means: "Update Node to 22.16 or newer, otherwise the nightly self-review will not run").

On failure it prints a message (no JSON) and exits with 1. Read the message:
- it could not create the channel: ask the user to create a text channel named `main` in the server (right-click the server name, **Create Channel**), then run the same command again;
- several servers and no `--guild`: add `--guild <SERVER_ID>`;
- a value differs from an existing `config.json` and it says to use `--reconfigure`: ask the user which value is right, then run `clawstrum setup --reconfigure` in the second terminal.

Then check:

```sh
clawstrum setup --status
```

`mainChannel.id` must equal `<MAIN_CHANNEL_ID>`, and `next` must be `login` (or `start` if the account is already signed in).

On a cluster, also keep the agent from loading the shared login node. Show the user this edit to `<HOME>/config.json` and make it after their yes: in the `runtime` object (add it if missing) set `"shellCpuSeconds": 300`. Every shell command the agent runs then stops after 5 minutes of CPU time, with a note to submit a job instead; `sbatch`, `srun` and `salloc` lift the limit, so jobs are not cut short. It covers Claude only: with Codex or Gemini, tell the user the agent has to be told to keep heavy work in jobs (step 6d writes that down for it).

Then run the system checks, which `--main-channel` does not run:

```sh
clawstrum doctor
```

It prints JSON: a list `checks`, each with `check`, `ok` and `detail`. It exits 1 whenever a check that is not a warning is `ok: false`, so read the JSON, not the exit code. Before step 5, `main sign-in` is `ok: false`; that is expected. `Research executable: pdftotext` with `warn: true` is fine (it only reads PDFs and is optional). Any other `ok: false` needs fixing: read its `detail`.

## Step 5. Sign in to the model account

Signing in opens a web page, so the user does it in the *second terminal*. IDs are fine to say aloud; passwords and codes only go into that terminal or that web page, never this chat.

First ask: "Is there a web browser on the computer where Clawstrum is installed?" (If they connect to a remote server over SSH, the answer is no.)

- `claude`, browser available: tell the user to run `clawstrum account login main` in the second terminal and finish the web page that opens.
- `claude`, no browser (remote server): the same command, `clawstrum account login main`. It prints a web address after "If the browser didn't open, visit:" and then waits at "Paste code here if prompted". Tell the user to open that address on any computer or phone and sign in; if the page then shows a code, paste it at that prompt in the second terminal. Claude's login has no separate "device" option. If it cannot finish, see the advanced route below.
- `codex`, browser available: `clawstrum account login main`.
- `codex`, no browser: `clawstrum account login main --device`. It prints a web address and a short code. The user opens the address on any computer or phone, types the code there, and signs in with their ChatGPT account.
- `gemini`, with or without a browser: `clawstrum account login main` (no `--device`). It runs `agy acp --login`, which prints a web address. The user opens it in a browser on any computer or phone, signs in with the Google account that has the Gemini subscription, and pastes the code the page shows (or the page's full address) into the second terminal. The command then checks the sign-in itself and fails if it is not usable.

Check from here (not the second terminal):

```sh
clawstrum doctor
```

Look for the check named `main sign-in` with `"ok": true`. Then the real test, one tiny model request:

```sh
clawstrum smoke main
```

It must answer `CLAWSTRUM_OK`. If sign-in fails, ask the user to read you the last lines of what the second terminal printed (they never contain the bot token) and fix from that.

*Advanced route for Claude with no way to sign in on the machine (offer only if the normal route failed):* this needs Claude Code installed separately on a computer that has a browser, because the Clawstrum install does not put a `claude` command on the PATH (its Claude runtime sits inside the SDK package). On that computer the user runs `claude setup-token`, which prints a long-lived token. They then add one line `CLAWSTRUM_CLAUDE_TOKEN=<that token>` to `<HOME>/.env` with the same editor method as step 2c (never in chat). You edit `<HOME>/config.json`: in the `accounts` entry with `"id": "main"`, add `"tokenEnv": "CLAWSTRUM_CLAUDE_TOKEN"` (the config holds only the variable name). Then run `clawstrum smoke main`; it must print `CLAWSTRUM_OK`. This token route was tested on a fresh install, and `clawstrum setup --status` then shows `login.signedIn` true. On a machine with no browser, `clawstrum account login main` was seen to print the address and wait for the code; a sign-in finished that way has not been tested yet.

## Step 6. Start the agent and talk to it

### 6a. Foreground first

Tell the user to run this in the second terminal and leave it open:

```sh
clawstrum start
```

The agent only works while this runs. A line like `{"event":"ready","name":"<AGENT_NAME>",...}` means it is connected. Ask the user to tell you whether they see that line (it contains no secret). If they see an error instead, ask for it and use the table below.

Check from here:

```sh
clawstrum doctor
clawstrum setup --status
```

`doctor` should show a recent daemon heartbeat; that is the check that the agent is running.

### 6b. The first message

Tell the user: "Open `main` in your server. Your agent writes there first, within a minute or two: who it is, what `main` is for, and a few ideas to make it yours. Answer it. When you write, a small reaction appears first, then the agent answers."

**You are done only when the user says the agent's first message arrived and it answered their reply.** Nothing on this computer proves it: `clawstrum status` lists the main channel before any message has been sent.

If nothing arrives after about two minutes, ask the user to write `hi` in `main`. If that gets no answer either, go to the table.

### 6c. Keep it running after you close the terminal (optional)

Ask: "The agent stops when that terminal closes. Do you want it to keep running in the background?" On a server or a cluster the answer is almost always yes.

First stop the foreground one (Ctrl+C in the second terminal; only one agent can run per home). Then pick:

- On a cluster, on a Mac, or on Linux without `systemctl --user`: **tmux**.
- On your own Linux computer or server with systemd: the **systemd service**, which also starts again after a reboot. On a cluster use it only if the user knows that user services with lingering are allowed there: a cluster can clear lingering without notice, and the agent then stops without a word.

**tmux.** On a Mac, `brew install tmux` first. Write `<HOME>/start-tmux.sh` with this content, `<PATH>` replaced by the output of `echo "$PATH"` here and `<HOME>` by the home folder. The script sets both itself, because a tmux server started earlier could hand the session an outdated environment.

```sh
#!/bin/sh
# Starts the Clawstrum agent in the tmux session "clawstrum". Run it again after this computer restarts.
if [ "$1" != loop ]; then
  if tmux has-session -t clawstrum 2>/dev/null; then echo "already running: tmux attach -t clawstrum"; exit 0; fi
  tmux new-session -d -s clawstrum "/bin/sh '<HOME>/start-tmux.sh' loop" && echo "started in tmux session clawstrum on $(hostname)"
  exit
fi
export PATH='<PATH>' CLAWSTRUM_HOME='<HOME>' CLAWSTRUM_SUPERVISED=1
trap 'stop=1' INT
while :; do
  clawstrum start
  code=$?
  if [ "$code" -eq 0 ] || [ -n "$stop" ]; then break; fi
  sleep 5
done
```

Run `chmod +x "<HOME>/start-tmux.sh"`, then ask the user to run `<HOME>/start-tmux.sh` in the second terminal. After 15 seconds `clawstrum doctor` must show a recent daemon heartbeat. The loop starts the agent again after a crash or when it asks for a restart (after a change to its own code), and ends when the agent is stopped with Ctrl+C. Tell the user:
- to look at it: `tmux attach -t clawstrum` (on a cluster after `ssh <NODE>`); to leave it running: Ctrl+B, then D;
- to stop it: attach, then Ctrl+C; it finishes what it is doing and exits within about 30 seconds;
- after the computer restarts (on a cluster: maintenance, usually announced), the session is gone: log in to the same computer and run `<HOME>/start-tmux.sh` again.

**systemd service.**

```sh
mkdir -p ~/.config/systemd/user
clawstrum service > ~/.config/systemd/user/clawstrum.service
systemctl --user daemon-reload
systemctl --user enable --now clawstrum
loginctl enable-linger "$USER"
journalctl --user -u clawstrum -n 20 --no-pager
```

`enable-linger` keeps the service alive after the user logs out. If `CLAWSTRUM_HOME` is not the default, it must be exported when you run `clawstrum service`, since the unit stores the path. Ask the user to send a message again and confirm the answer.

### 6d. Tell the agent where it runs

Show the user, then add after their yes, a `## Where you run` section to `<HOME>/AGENTS.md`, just above `## MEMORY`. A few lines: the computer (`<NODE>` on a cluster) and how the agent is kept running (the tmux session `clawstrum` from `<HOME>/start-tmux.sh`, the systemd service, or a terminal). On a cluster add: "This is a shared login node. Anything heavier than a quick check, more than about a minute of CPU, goes into a job, never onto the login node. After a reboot of `<NODE>` the owner starts you again with `<HOME>/start-tmux.sh`." The first conversation in `main` adds how the user's own work runs (cluster accounts, partitions, software).

Finish with a short summary: what is installed, where `<HOME>` is, where the agent runs (`<NODE>` on a cluster), that `main` is the main and therapy channel, how to start the agent again (`<HOME>/start-tmux.sh`, `systemctl --user restart clawstrum` or `clawstrum start`), and that everything else from here (new channels, skills, changes) happens by asking the agent in Discord.

New project channels: the user just asks the agent in `main` ("make a channel for my project X"). The agent runs `clawstrum setup --add-channel <NAME> --json`, which finds or creates the channel, adds it to the settings and is picked up within seconds with no restart. If the bot may not create channels, the user makes the channel and the agent runs the same command. If the user asks you for one now, run that command and report `channel.name` and whether `created` is true.

## Troubleshooting: the agent does not answer

Run `clawstrum doctor` and `clawstrum setup --status` first, read both, then pick the row.

| Symptom | Likely cause | Check | Fix |
| --- | --- | --- | --- |
| `clawstrum start` stops with "disallowed intents" | Message Content Intent is off | status shows it off | Bot page, turn it on, **Save Changes**, start again |
| Bot shows offline in Discord | The agent is not running, or the token is rejected | `doctor` heartbeat; status says Discord rejected the token | Run `clawstrum start`; if rejected, Reset Token and put the new one in `<HOME>/.env` with an editor (never in chat) |
| Bot online, no reaction, no answer | Your Discord user ID in the settings is not yours. Messages from anyone else are dropped without a word | `ownerIds` in `<HOME>/config.json` against the owner ID from status | Fix `discord.ownerIds` in `config.json` (not secret), restart the agent. Or run `clawstrum setup --reconfigure` in the second terminal; each question shows the current value |
| Bot online, answers elsewhere but not in `main` | Wrong channel ID in the settings | `discord.channelIds` in `config.json` against the channel Discord reports | Correct the ID in `config.json`; the running agent picks up channel changes without a restart |
| `doctor` or setup says the bot is not in the server | The invite link was not completed | status shows no servers for the bot | Open the invite link again, pick the server, **Authorize** |
| setup says "the bot cannot see channel" | The channel is private or its permissions exclude the bot | status and the channel's permissions in Discord | Give the bot's role access to the channel, or use a public channel |
| Reaction appears, no answer | Sign-in missing or expired | `doctor` check `main sign-in`; `clawstrum smoke main` | `clawstrum account login main` in the second terminal (add `--device` for Codex without a browser) |
| You wrote in a thread or another channel | Only the configured channels and their threads are answered | `discord.channelIds` | Write in `main`, or ask the agent to add the channel later |
| `clawstrum start` says "Clawstrum is already running" | One agent per home; the service, the tmux session or an old terminal is still running | `systemctl --user status clawstrum`; `tmux ls`; other terminals | Stop the other one, then start |
| Bot offline after a reboot or cluster maintenance | The tmux session ended with the reboot | `tmux ls` on `<NODE>` | Run `<HOME>/start-tmux.sh` on `<NODE>` |
| A `clawstrum` command says "This state belongs to host …" | This terminal is on another node than the one in `STORAGE.json` | `hostname` | `ssh` to the node it names and run the command there |
| Service restarts every few seconds | Start fails (token, intent, login) | `journalctl --user -u clawstrum -n 50 --no-pager` | Fix the cause above; the service retries by itself |
| Slash command `/clawstrum` is missing | Discord is slow to show new commands | none | Use the text form `!clawstrum status` in the channel |

If none fits: ask the user to read you the last lines of the terminal where `clawstrum start` runs (check there is no token in what they paste), and read `docs/setup.md` and `docs/operations.md`.
