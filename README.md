# LocalAITab

On-demand code completion and selection refactoring in VS Code, served by a
local Ollama. No telemetry, no account, no cloud.

Suggestions are **manual by default** — nothing is proposed until you ask.

On Windows/Linux the chords are `Ctrl+K A` and `Ctrl+K R`.

Not affiliated with Alibaba or the Qwen team; Qwen models are simply the defaults.

## Install

Search for **LocalAITab** in the Extensions view, or:

```bash
code --install-extension Netajam.localaitab
```

## Requires

```bash
ollama pull qwen2.5-coder:3b-base       # completion: must be a -base tag (FIM)
ollama pull qwen2.5-coder:7b-instruct   # refactor: must be an instruct model
```

Together they need about 7 GB, which suits a 16 GB machine. With 32 GB or
more, a larger instruct model gives noticeably better refactors and chat:
`ollama pull qwen3.6:35b-a3b-coding` (about 24 GB) and pick it with
**LocalAITab: Select Model...**.

The two roles need different kinds of model. A `-base` tag completes text and
cannot follow instructions; an instruct tag follows instructions but replies in
prose instead of completing code. Using one where the other belongs is the usual
cause of "it returns garbage", so the extension warns about both at startup.

Any installed Ollama model can fill either role. **LocalAITab: Select Model...**
asks which one to change (completion, refactor/chat/agent, or chat only), then
lists what Ollama has installed, the models that suit that role first, each
marked base or instruct from its tag and the capabilities Ollama reports.
Picking one of the wrong kind asks before saving it. The choice is written to
the setting where it already lives, so a workspace override keeps winning only
if that is where you changed it. The "not installed" warning at startup offers
the same picker.

The instruct model is the heavy one, and not every machine has it. When Refactor,
Chat, Agent or Search planning is invoked and `localAITab.refactorModel` is not
installed, the extension stops and asks rather than failing mid-request: pull the
configured model, or run this once with an installed substitute. The substitute
is the first installed entry of `localAITab.refactorModelFallbacks`, or, if that list
yields nothing, the largest installed instruct model. A substitute is never used
without that confirmation, and the choice is remembered for the rest of the session.

## Use

| Action | Key |
| --- | --- |
| Suggest a completion at the cursor | `Alt+\` |
| Refactor the selection | `Cmd+K` `R`, or right-click |
| Open the chat panel | `Cmd+K` `Q` |
| Toggle on/off | click the status bar item |

`LocalAITab: Switch Between Manual and Automatic` turns on as-you-type
suggestions if you ever want them.

Refactoring offers presets (simplify, add types, document, extract functions,
handle errors, make idiomatic) plus a free-text instruction, then opens a
before/after diff. Nothing is written until you accept it:

| In the diff | |
| --- | --- |
| Accept | the `$(check)` button in the title bar, or `Cmd+Enter` |
| Reject | the `$(close)` button, `Esc`, or just close the tab |

An applied refactor is a single undo step, so `Cmd+Z` puts it back.

If something produces no result, run **LocalAITab: Diagnose** — it checks the
endpoint, both models, the active language, selection state, and runs a live
completion, printing everything to the LocalAITab output channel.

## Chat

`Cmd+K Q` opens a panel where you choose the context explicitly. Nothing is
gathered implicitly, and the header shows exactly what will be sent, per source,
in characters, before you send it.

| Source | |
| --- | --- |
| Pinned lines | selections kept with `Cmd+K L` (or *Pin Selection to Chat* in the editor menu); they stay attached when you select something else, until `/unpin` |
| Selected lines | the current selection, every one of them when there are several (Alt+drag, `Cmd+D`) |
| Current file | the whole active file |
| Open tabs (same language) | every open tab matching the active file's language |
| Open tabs (all languages) | every open tab |
| Current folder | code files beside the active file |
| Chosen files | pick any files from the workspace |

Open it from the **LocalAITab Chat** status bar item, the chat icon in the editor
title bar, or `Cmd+K Q`.

Replies stream, `Stop` cancels mid-answer, and code blocks get Copy and Insert
buttons. Anything that would exceed the attachment cap is listed as skipped
rather than silently dropped.

### Slash commands

Type `/` in the composer for a list; `Tab` or `Enter` completes, arrows move.

| Command | |
| --- | --- |
| `/attach [path or glob]` | attach files; a folder attaches what is under it, a fragment matches file names, several matches open a picker, no argument opens the full picker |
| `/detach [path]` | remove attached files whose path contains the argument, or all of them |
| `/unpin [path:lines]` | drop pinned selections matching the argument (`chat.ts`, `chat.ts:40-52`), or all of them |
| `/allow [folder]` | let agent mode read a folder outside the workspace, see below |
| `/find <task>` | same as **Find context** |
| `/chat`, `/agent`, `/operator` | switch mode |
| `/new`, `/history`, `/clear`, `/stats` | same as the buttons |
| `/skills` | rescan and list the skills found on disk |
| `/<skill> [args]` | run a skill, see below |
| `/help` | list the commands |

Commands never reach the model. Start a message with `//` to send a literal
leading slash. Files can also be attached from the explorer or an editor tab's
right-click menu with **LocalAITab: Attach File to Chat**.

### Skills

Skills use the same `SKILL.md` format as Claude Code, Codex and other agent
harnesses, so one written for them works here unchanged. A skill is a folder:

```
.localaitab/skills/review-pr/
  SKILL.md          instructions, with name and description up top
  checklist.md      anything else the instructions refer to
```

```markdown
---
name: review-pr
description: Review the attached diff for bugs and missing tests. Use when asked to review a change.
argument-hint: "[focus]"
---

1. Read every changed file before commenting.
2. Report bugs first, then missing tests. Focus on $ARGUMENTS if given.
```

**LocalAITab: New Skill** writes that skeleton and opens it. Skills are looked
for in the folders listed in `localAITab.skillPaths`: by default only
`.localaitab/skills` in the workspace, then `~/.localaitab/skills`. When two share
a name the earlier folder wins. A skill folder is picked up the next time the
panel comes into view, or on `/skills`.

Skills written for other harnesses are not read unless you ask for them, so
their descriptions don't crowd a small model's prompt. To use one without
copying it, reference it from a `skills.json` beside a skills folder
(`.localaitab/skills.json`, or `~/.localaitab/skills.json` for every workspace):

```json
{
  "skills": [
    "~/.agents/skills/tdd",
    { "path": "~/.claude/skills/my-skill", "model": false }
  ]
}
```

Each entry is the path of a skill folder, relative to the `skills.json` or
from `~`. The skill is read where it lives, lazily like any other: only its
name and description are listed to the model, and its body is read when
used. `"model": false` leaves it off the model's list entirely, so it runs
only when you type `/my-skill`. A folder's own skill wins over a
referenced one of the same name, and a reference that points at no `SKILL.md`
is reported by `/skills`.

There are two ways to use one:

- **You invoke it.** `/review-pr auth` sends the skill's instructions as your
  message, in either mode. `$ARGUMENTS` in the body becomes `auth`
  (`$ARGUMENTS[0]` is the first word); if the body uses neither, the arguments
  are appended. The transcript shows what you typed; the saved session keeps
  what was actually sent.
- **The agent picks it.** In agent mode the system prompt lists each skill's
  name and description, one line each, and the model gets a `load_skill` tool to
  read a body, or a bundled file, when a request matches. Only descriptions cost
  tokens until then, which matters with a local model's window.

| Frontmatter | |
| --- | --- |
| `name` | the `/command`; lowercase, digits, hyphens. Defaults to the folder name |
| `description` | what it does and when to use it; the agent decides from this alone |
| `argument-hint` | shown beside the name in the `/` list |
| `disable-model-invocation: true` | only you can run it; not listed to the agent |
| `user-invocable: false` | only the agent can load it; hidden from `/` |

Other fields (`allowed-tools`, `model`, ...) are ignored. LocalAITab has no shell
tool, so a skill that asks for a bundled script to be run gets it read, not run.
A skill named like a built-in command is hidden by the built-in. Skills that fail
to parse are listed by `/skills` and in the output channel.

### Files outside the workspace

There are two kinds of access, on purpose.

**Attaching** is you choosing a file, so it reaches anywhere. `/attach` takes an
absolute or `~/` path to a file or a folder (a folder opens a picker over what
is under it), and every file picker has a **Browse outside the workspace**
button in its title bar that opens the system file dialog. With no workspace
open, `/attach` goes straight to that dialog.

**Agent mode** reads without asking, so it reaches only folders you granted:

| | |
| --- | --- |
| `/allow ~/notes` | until the panel closes; no argument opens a folder dialog |
| `localAITab.extraFolders` | for good, e.g. `["~/notes", "/srv/shared/specs"]` |

The system prompt lists the granted folders, and `read_file`, `search` (through
its `path` argument) and `insert_change` accept absolute paths inside them. An
edit there is still only staged for your review. With no workspace open, the
first granted folder stands in for one, so agent mode works on a notes folder
without opening it as a project.

`localAITab.extraFolders` is read from user settings only. If it could be set in a
workspace's `.vscode/settings.json`, any cloned repository could grant the
agent your home directory.

Operator mode does not use these grants: its file writes stay inside the
workspace, and its shell already reaches anything you approve a command for.
The **Find context** planner still searches the workspace only.

### Find context

Type what you are after, press **Find context**, and the model writes the
ripgrep queries instead of you. Results come back grouped by file with a
checkbox per hit and per file. Nothing enters the prompt until you tick it and
press Attach.

The division of labour is deliberate. Formulating queries -- trying casings,
synonyms, narrowing globs -- is tedious and the model is good at it. Deciding
which handful of hits actually matters is the part you are better at, and doing
it yourself is what keeps irrelevant code out of the context.

The planner is first shown a cheap local sketch of the codebase: its files and
the identifiers it really defines, gathered with ripgrep. This matters a lot.
Without it the model guesses naming conventions and misses -- asked about a
TypeScript project it proposed `max_steps`, `GetModelInfo` and `json.Unmarshal`
and returned zero hits. With the sketch it names the actual functions and found
the target file in all five test cases, with 2.6 files to sift on average.

Flags are never taken from the model. Only the pattern, a validated glob and a
case-sensitivity bit are honoured, and ripgrep is invoked directly rather than
through a shell.

### Agent mode

The panel has three modes. **Chat** is one shot: your question plus the context
you ticked, nothing else. **Agent** gives the model its tools and lets it
drive a bounded loop:

| Tool | |
| --- | --- |
| `search` | ripgrep over the workspace or a `path` in it or in a granted folder, returns `file:line:text` |
| `read_file` | one file, truncated past `agentMaxReadChars`; a folder returns its listing |
| `insert_change` | **stages** an edit; never writes |
| `load_skill` | a skill's instructions or bundled files; only offered when skills exist |

The read tools run unattended. `insert_change` cannot write to disk: it stages
one change, which arrives in the same diff with the same Apply/Discard buttons
the refactor commands use. A search string matching zero or several places is
rejected and handed back as a correctable error, because the dangerous failure
is not a missed edit but a confidently misplaced one.

`localAITab.agentMaxSteps` (default 8) is a hard stop, not a hint. Every step is
shown live with its arguments, result and timing, and the run reports steps,
tokens and wall time so the modes can be compared. **A/B stats** totals them.

### Operator mode

**Operator** is the unconstrained mode, kept apart from Agent so Agent stays the
staged, safe default. Its own loop and prompt live in `src/core/harness/operator/`.
The model is told to carry a task through: change the code, then build or test
to check it.

| Tool | |
| --- | --- |
| `search`, `read_file`, `load_skill` | as in agent mode |
| `write_file` | creates or overwrites a workspace file, **immediately** |
| `edit_file` | exact, unique search/replace, applied **immediately** |
| `run_command` | a shell command in the workspace root, after **your approval** |

Edits skip the diff, but they are confined to the workspace, so git is the undo.
Commands can reach past the workspace, so every one goes through a modal that
shows the command line. **Run all for this request** lifts the prompt until the
current request ends, and declining tells the model not to retry. Commands run
non-interactively through your login shell. `operatorCommandTimeout`
(default 120s) kills the whole process group. Output is clipped to
`operatorMaxOutputChars`, keeping the head and tail. The full output goes to the
LocalAITab output channel. `localAITab.operatorMaxSteps` defaults to 30.

### Saved conversations

Conversations are written to disk as you go, one JSONL file per session, at
`~/.localaitab/projects/<folder>/<session id>.jsonl`, where `<folder>` is the
workspace path with every character but letters and digits turned into `-`
(`/Users/me/my_repo` → `-Users-me-my-repo`). The terminal keeps its
conversations in the same place, so one started in the panel can be picked up
with `/resume` in `localaitab`, and the other way round. Reopening the panel
picks up where the last one left off; **New session** starts clean and
**History** lists past conversations to resume. **Show files** opens the folder.
Sessions from earlier versions, in `~/.localaitab/sessions/<workspace>/` or VS
Code's own storage, are converted the first time the panel or `localaitab` starts;
one that can't be is left where it was and logged. `LOCALAITAB_HOME` moves the
whole `~/.localaitab` folder.

The files follow Claude Code's transcript shape (`~/.claude/projects`), so a
tool that reads Claude Code's transcripts reads localaitab's by looking in
`~/.localaitab` instead, and can show their title, goal, branch, token use and
tool calls. localaitab never writes into `~/.claude`. Each
line is appended as it happens and never rewritten, so an interrupted write
costs at most the last line, a reader only reads what is new, and a transcript
stays greppable:

- `user`: a question, with what was typed when a `/skill` expanded it
  (`display`), the context sources attached, the mode and the model. One you
  typed is marked `origin: {kind: "human"}`.
- `assistant`: each model reply, with its tool calls as `tool_use` blocks and
  Ollama's token counts as `usage`.
- `user` with a `tool_result`: what each tool returned, including a command you
  declined.
- `ai-title`: the session's title, its first question.

While it runs, localaitab also keeps `~/.localaitab/sessions/<pid>.json` up to
date, in the shape of Claude Code's `~/.claude/sessions/<pid>.json`, so a
monitor can tell a localaitab agent is running, where, and on which session.
The terminal writes one per `localaitab` process; the panel one per VS Code window
while it is open (the pid is the window's extension host). It holds:

| Field | |
| --- | --- |
| `pid`, `procStart` | the process, and when it started as `ps -o lstart=` prints it in UTC, so a reused pid is not mistaken for this one |
| `sessionId`, `name` | the current transcript and its title; they follow `/clear`, `/resume`, New session and History |
| `cwd` | the workspace |
| `status`, `statusUpdatedAt` | `busy` from sending a prompt until the reply is complete, `waiting` while an operator command waits for your approval, `idle` otherwise |
| `kind`, `entrypoint` | `interactive`, and `localaitab-tui` or `localaitab-vscode` |
| `tmux` | `session:@window.%pane` when the terminal runs in tmux |
| `startedAt`, `updatedAt`, `version` | |

It is written whole through a temporary file and a rename, so a reader never
sees half of one, and removed when localaitab quits or the window closes. A crash
leaves it behind naming a pid that is gone, which is how a reader tells.

Nothing is uploaded. `LocalAITab: New Chat Session` and
`LocalAITab: Resume Chat Session...` are also in the command palette.

### Context meter

A bar tracks usage against the model's context window, updating as you toggle
sources and as you type, before anything is sent. It counts the system prompt,
attached context, conversation so far, and your draft, and adds
`localAITab.chatMaxTokens` on top, since the reply competes for the same window.

The window comes from `/api/ps` -- what Ollama actually allocated when it loaded
the model, which is what governs truncation. That is often far below the model's
advertised maximum: 65,536 against a 262,144 ceiling for qwen3.6 here. When the
model is not resident the meter falls back to the maximum and says so.

Attached context is capped at `localAITab.chatContextPercent` of that window (60%
by default), leaving the rest for the conversation and the reply. The cap shows
as a tick mark on the bar. Set `localAITab.chatContextTokens` for an absolute
number instead. Everything is counted in tokens against the window: an earlier
version also reported a percentage of a fixed character budget, which was a
different denominator and read as a contradiction -- 90% of one was 12% of the
other.

Ollama exposes no tokenizer endpoint, so counts before sending are estimated
from a chars-per-token ratio, then corrected against `prompt_eval_count` after
every reply. Measured against the real tokenizer the starting ratio is within
1-3% on source files; it converges within a turn or two, and each reply also
reports its exact prompt and reply token counts.

## Context

What the model is given, per command:

| | Completion (`Cmd+K A`) | Refactor / improve |
| --- | --- | --- |
| Model | `localAITab.model` (base/FIM) | `localAITab.refactorModel` (instruct) |
| Own file | 3000 chars before, 1500 after the cursor | per `localAITab.refactorContext` |
| Other files | open tabs, same language, 2000 chars | only in `openTabs` scope |

`localAITab.refactorContext` takes `none` (selection only, fastest), `surrounding`
(a window either side, the default), `file` (the whole file with the selection
marked), or `openTabs` (that plus other open tabs of the same language).

To override it for a single run without changing the setting, use
**LocalAITab: Refactor Selection (choose context)...**

## Terminal

Chat, agent and operator mode also run without VS Code, as `localaitab` in a terminal:

```bash
npm run install-tui           # compile, test, install to ~/.local/bin/localaitab
localaitab                      # a session in the current directory
localaitab "why does add() subtract?"   # one task, then exit
localaitab --chat               # start in chat mode: answers only, no tools
localaitab -c                   # reopen the latest conversation in this folder
localaitab --resume <id>        # reopen that conversation, by its session id
localaitab --operator -C ~/proj # start in operator mode, elsewhere
localaitab --version            # which build is installed
```

The install is a copy of the build, not a link to the repo, so it keeps
working while you edit or switch branches; rerun `npm run install-tui` to
update it, and `npm run uninstall-tui` to remove it. It needs Node 18 or newer
and `~/.local/bin` on your PATH (set `LOCALAITAB_PREFIX` to install elsewhere).

It runs the same conversation as the chat panel. Chat mode streams an answer from
what you attach, with no tools, drawn as markdown while it arrives. In agent mode a staged change is
shown as a diff and written only when you answer `y`. In operator mode, edits
land directly and each command is shown before it runs (`y`, `a` for the rest
of the request, or `n`). Answers are rendered from markdown: headings, lists,
tables, and code blocks with light highlighting.

It takes over the window like a full-screen app: the prompt and a footer
(mode, model, and the shortcuts that work right now; F1 lists them all) stay
pinned to the bottom, and the conversation scrolls above them on its own, with
the mouse wheel or PgUp/PgDn. Scrolled back, the rule above the prompt says how
far, and sending a message returns to the bottom.

Each message you send and each reply is a point in the conversation. ⌥↑ and
⌥↓ jump to the previous and next point (`[` and `]` in vim normal mode), and a
scroll bar down the right edge shows where you are and a mark per point: `◆`
(cyan) for your messages, `•` (magenta) for replies, so they differ even
without colour. Scrolled back, the rule above the prompt names the point in
view, such as `◆ your message 2 of 4`. Clicking the bar jumps there, straight
to the point when you click a dot. A resumed conversation has its points too. Because the app receives the
wheel, select text with ⌥ Option+drag in iTerm2 (Shift+drag in most other
terminals). On quit the conversation is printed to the terminal, so it stays in
the scrollback.

| | |
| --- | --- |
| `@path` | Attach a file, or the source files of a folder. A fuzzy finder opens as you type; `Tab` opens a folder, `Enter` attaches. `@~/` and `@/` browse outside the workspace. Attached context is capped at `contextMaxChars` (48k). |
| `/` | Commands and skills, completed as you type: `/mode`, `/model`, `/allow`, `/skills`, `/clear`, `/help`, `/quit`, `/<skill> args`. Their argument completes too: `/mode` offers chat, agent and operator, `/model` the models Ollama has installed, `/allow` folders on disk. Enter on an argument sends. |
| `→` | Accept the dimmed suggestion after the cursor: the rest of the highlighted completion, or of your latest earlier message that starts the same way (history is kept in `~/.localaitab/history`). `Alt+→` takes one word. |
| `Shift+Tab` | Cycle chat → agent → operator. The thread carries across modes. |
| `Esc` | Vim normal mode: motions, `d`/`c`/`y` operators, counts, `u` and `Ctrl+R`. `i`/`a`/`A`/`o` go back to typing. |
| `Alt+Enter`, `Ctrl+J`, `\ Enter` | New line. `Up`/`Down` walk earlier messages. |
| `Ctrl+C` | Clear the prompt, or stop a running request. `Ctrl+D` on an empty prompt quits. |

Every conversation is saved as you go, one file per session in
`~/.localaitab/projects/`, grouped by the folder you started in, in Claude Code's
transcript shape (see [Saved conversations](#saved-conversations)): the same
place the chat panel uses, so its conversations are listed too. `/resume` lists
them by their first question (type the space and the list opens, narrowed as
you type), and picking one plays it back and makes it the model's thread
again. `localaitab -c` reopens the latest, and `localaitab --resume <id>` a given
one (the id is the transcript's file name, or `sessionId` in the live file),
which is how a monitor reopens a stopped session; an unknown id is an error.
`/clear` starts a new one.

Piped input (`echo "/skills" | localaitab`) gets plain lines with no footer.

Defaults come from `~/.localaitab/config.json`, keyed by the extension's setting
names without `localAITab.` (`{"model": "...", "agentMaxSteps": 12}`). Set
`LOCALAITAB_DEBUG=1` to see the log lines the extension sends to its output
channel.

The code is laid out along that split: `src/core` holds the Ollama client and
the tool loops, with no `vscode` import, behind one entry point,
`src/core/harness/conversation.ts`, which keeps the thread and the skills and
runs a turn in either mode. `src/hosts/app` is the extension and
`src/hosts/tui` the terminal; each supplies how files are read and written,
how the user approves a command, and its settings.

## Settings

All under `localAITab.*`. Notable ones: `trigger` (manual/automatic), `model`,
`refactorModel`, `refactorModelFallbacks`, `refactorPreview`, `multiline`,
`debounceMs`, `neighborFiles`.

## Develop

```bash
npm install
npm run compile
npm test                  # unit tests, no editor or model needed
npm run e2e               # live completions against Ollama
node test/refactor-e2e.js # live refactors, checks for leaked prose and indent drift
npm run e2e:continuity    # live check that both modes carry conversation history
npm run install-all       # compile, test, package, install to every VS Code profile
npm run tui               # the terminal harness, straight from out/
npm run install-tui       # compile, test, install localaitab to ~/.local/bin
```

Press `F5` in VS Code for an Extension Development Host.

## Notes

Completion requests set `raw: true` so Ollama does not wrap the FIM prompt in a
chat template. Refactor requests send `think: false` to models that report the
`thinking` capability — without it a reasoning model spends its whole token
budget thinking and returns nothing (and takes ~60s rather than ~1s).
