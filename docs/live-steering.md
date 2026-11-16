# Live steering

A message you send while the agent works joins the current run on Claude and Codex. The agent's session and its running tools stay alive. Antigravity CLI can't add a message to a running turn, so on Gemini the message ends the current turn and starts a new one with the same context, plus a note to finish the work the old turn was doing. A message with a file attached always waits, on every provider.

Steering is on for every Claude, Codex and Gemini lead run, including scheduled and recovery runs. It needs no setting or extra credentials. Subagents take corrections from the lead through `research_steer` instead, see [subagent steering](orchestration.md#steering-and-continuing-subagents).

## Behavior

- The provider decides when it reads the new message. Steering doesn't interrupt a running shell command, and the model may finish its current step first.
- A message sent after the agent's final reply still joins the run, as long as the run is alive, for example while a long experiment continues in the background. The agent then owes a new answer, and an earlier reply can't count as one.
- Claude can fold several messages into one turn and answer them together. Messages that already got separate Discord replies can't be merged afterward.
- Clawstrum reacts to the message as soon as it saves it: 📨 if the agent is working, 👀 if not. The reaction doesn't mean the provider has taken it yet. The agent is instructed to send one short line on what it will do next before starting work. That line comes from the agent's normal turn, so it appears only once the model reads the message. The rule lives in the shared `AGENTS.md`.

## Limits

- While you type, Clawstrum waits up to a ceiling before it passes the message on, as it does before a turn starts.
- Each injection carries at most 20 messages, each with its ID, author, send time in `runtime.timezone` and full text. The whole batch must fit in `runtime.promptChars` (default 100,000 characters). A first message too long for that waits for the next run instead of being cut.
- A message queued behind an older retry, a retry batch or a message with a file waits too. Later text can't jump ahead of it.
- A correction sent before the final reply runs under the current run's time limit. A new request accepted after the final reply gets a fresh time limit.
- In a scheduled run, an accepted message makes the run interactive, but the task's own limits still apply. If they run out, unanswered messages go back to the normal queue.
- If a message is still queued after `runtime.queuedInputTimeoutMs` (default 120,000 ms) behind an agent that is quiet, ready and running no tool, Clawstrum saves diagnostics and hands the queue to a new turn on the same session. 0 turns this off. See [stuck queue](performance.md#stuck-queue).
- A crash between the provider accepting a message and Clawstrum recording it can replay that message. Tool side effects are not guaranteed to happen once.

## Internals

- The engine sends pending message text to the worker. The worker reports when its provider can take input. A message counts as accepted only after the provider confirms it. Then one database transaction moves it into the running batch and logs a `steered` event. Until then it stays queued and follows the normal path if anything fails. A failed or unconfirmed send stops further steering for that attempt and is never resent blind.
- When the provider actually starts reading a message, Clawstrum logs `input_started`. On Claude this comes from the `UserPromptSubmit` hook or the prompt IDs on the reply stream.
- Accepting a message after a final reply clears the final flag and opens a new reply scope, so old output can't answer the new request. Retries and restarts keep that scope.
- Claude uses the SDK's [streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), in [src/turn-stream.ts](../src/turn-stream.ts). The stream closes once every sent message has a result and no background task is held, after a grace period when background work ran, so late task notices still arrive. `runtime.inputReleaseGraceMs` sets it (default 10,000 ms, 0 to 60,000). If the stream ends while accepted input is unanswered, the run fails as transient and retries.
- Codex runs through the bundled runtime's [App Server](https://learn.chatgpt.com/docs/app-server) over local stdio, in [src/codex-app-server.ts](../src/codex-app-server.ts), for all lead turns and subagents. Input is sent with `turn/steer` and counts only when the reply names the active turn. Codex requests have a 30-second response limit. An abort sends `turn/interrupt`, waits up to one second, then stops the process.
- Gemini runs Antigravity CLI over ACP, in [src/gemini-acp.ts](../src/gemini-acp.ts). Live input is a second `session/prompt` on the same session. Antigravity CLI ends the running prompt with no reply text and answers the new one, which carries the note above. A shell command that outlives a turn keeps running in the background and nothing wakes the model when it ends, so a turn that ends with one still running gets one follow-up asking the model to wait for it.
