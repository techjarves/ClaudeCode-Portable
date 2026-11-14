# Changelog

All notable changes to ClaudeCode-Portable are documented here.

This file describes how this fork differs from the official project it was forked from,
[`techjarves/ClaudeCode-Portable`](https://github.com/techjarves/ClaudeCode-Portable), at commit
`b3660fd`. It is written from the perspective of a user who already knows the upstream launcher:
only the differences are listed.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

#### Clickable local paths in the studio

A path in a reply or in a tool's output was plain text, and a browser will not start a local file from
an HTTP page, so a picture or a report had to be found by hand.

- Paths in replies and tool output are now clickable and open with the user's own application:
  `D:\folder\file.png`, `C:/folder/file.png`, `\\server\share\file.pdf`, and `file:///D:/...`.
- The click goes to the token-protected `POST /api/open`, which accepts only absolute paths that
  exist and hands them to `explorer.exe` / `open` / `xdg-open`. The path is one argument and never
  goes through a shell, so `&`, quotes and other metacharacters stay literal.
- A path with spaces is only recognised inside quotes, because in running text a space is far more
  often the sentence than part of the name. Trailing punctuation stays outside the link.
- Code blocks keep plain text so copying still works; paths there are not turned into buttons.
- Web links open in a new tab and never navigate the studio away.

#### Clickable paths in the terminal

Claude Code emits OSC 8 hyperlinks for paths and URLs, but only in terminals it recognises. Windows
sets no identifier in the classic console, so nothing was clickable there.

- Documented that **Windows Terminal** works automatically (Ctrl+Click) because it exports
  `WT_SESSION`, while the classic console does not.
- `PORTABLE_AI_HYPERLINKS=1` exports `FORCE_HYPERLINK=1` for users who want the escape sequences
  forced in other terminals. It stays opt-in: without OSC 8 support they would print as noise.

#### Sessions learn that Playwright exists

A session saw only its workspace and its own configuration, so nothing told the agent that the
bundled browser automation is there — it would have had to stumble over `engine/playwright`.

- The launcher writes a skill to `data/claude/<provider>-<auth>/skills/portable-playwright/SKILL.md`
  whenever Playwright is installed. Claude Code lists its name and description in the system prompt,
  so the agent knows the capability exists and loads the details only when a task needs them.
- The skill documents the absolute CLI and browser paths (a session's working directory is usually
  the user's project), the `screenshot` invocation, script usage, the `npx` warning, and the
  headless-only limitation.
- Without Playwright the skill is not written and a stale copy is removed; a skill the user added to
  the same folder is never touched.
- Verified with a real session: the SDK's skills dialog reports `portable-playwright` with
  `source: "user"`.
- The profile directory is the only place this can work: sessions run with
  `settingSources: ['user']`, so a `CLAUDE.md` inside a project would not be loaded.

## [2.0] - 2026-11-14

### Summary

| Area | Upstream | This fork |
|---|---|---|
| Bundled Node.js | 24.21.0 | **26.13.1** (LTS "Lithium") |
| Git for Windows | expected on the host | detected, **or downloaded automatically** |
| Session resume | `START.bat resume <id>` only | **standalone `RESUME.bat` / `resume.sh`** with full argument handling |
| Permission mode | per launch, always asked | **stored preference, default ON**, changeable permanently or per launch |
| Host footprint | app data only | `HOME`/`AppData`/XDG of the session **redirected into `data/`** |
| Local models | manual server start | **Ollama server + speed proxy started and stopped automatically** |
| Runtime updates | manual | **`check-update` with pinned-version rollback** |
| Community PRs | — | **two open upstream PRs adopted** (#43, #47) |
| Attachments | picker only, images as file paths | **paste, drop, and real image blocks** |
| Tests | 50 | **106** |
| Node.js pin | one location | launcher, POSIX launcher, CI matrix, `engines`, README |

Upstream has one later commit, `dfdc58d` (a sponsor button), that this fork does not include.

---

### Adopted community pull requests

Two pull requests that are still **open** in the official repository were merged into this fork
(commit `d1a6bf4`). They are listed here because a user of the official repository will not find
them there.

#### #43 — Preserve IME composition in the dashboard (by lux-liang)

[PR #43](https://github.com/techjarves/ClaudeCode-Portable/pull/43)

Pressing Enter while an input method editor (IME) is composing — Japanese, Chinese, Korean, and
similar — submitted the message instead of confirming the composition.

- New `dashboard/composer.js` with `isComposerSubmitKey(event, compositionActive)`, which treats
  Enter as a submit only when Shift is not held, `event.isComposing` is false, and no composition
  is active.
- The composer uses it for its key handler, so Enter now ends the composition first and only the
  next Enter sends.
- Covered by `tests/composer.test.mjs`.

#### #47 — Allow HTTP base URLs for private LAN hosts (by VikasRajput-18)

[PR #47](https://github.com/techjarves/ClaudeCode-Portable/pull/47), fixes upstream issue #45

The base-URL validator accepted plain HTTP only for `localhost`, `127.0.0.1` and `[::1]`, which made
LM Studio, Ollama, or any other local server unreachable over a LAN address (for example
`http://192.168.1.50:1234/v1`).

- `isPrivateHost()` in `lib/config.mjs` accepts loopback, RFC 1918 (`10/8`, `172.16/12`,
  `192.168/16`), link-local (`169.254/16`) and IPv6 ULA/link-local (`fc00::/7`, `fe80::/10`)
  addresses over HTTP.
- Remote hosts still require HTTPS, and URLs with credentials, query strings or fragments remain
  rejected.
- The security trade-off is documented in the README (`2efb954`).

The code from both pull requests is included as authored — `dashboard/composer.js` and the
`isPrivateHost()` helper match the PR branches exactly. The fork only merged them into a single
commit and rebased them onto its own history.

---

### Added

#### Runtime update check with rollback (`check-update`, menu option 7)

Upstream shipped a pinned runtime with no way to move it forward short of a manual reinstall.

- `availableUpdate()` compares the pinned Claude Code and Agent SDK versions with npm
  (`lib/runtime.mjs`).
- `savePinnedVersions()` writes the new pins before installing and restores them if the install
  fails, so a bad release cannot leave the launcher pointing at a broken version.
- Exposed as `START.bat check-update` / `./start.sh check-update` and menu option 7.
- Includes the README documentation for the update flow, model windows and runtime resume
  (`6e2fd1d`, `4b86741`).

#### Custom model windows and model-picker mapping

Claude Code only knows Anthropic model IDs; any other ID warned "Model isn't recognized", assumed a
200K window and exposed reduced capabilities.

- `profileSettings()` writes a `modelPicker` row for custom model IDs, so Claude Code treats them as
  a known model.
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` carries the window declared in the dashboard, so the declared
  value stays authoritative for IDs mapped to a different native window.
- The settings file of the profile's `CLAUDE_CONFIG_DIR` is merged, never replaced, because Claude
  Code stores its own keys there.

#### Dashboard conversation management

- A permanent delete button for conversations, including the Claude history `.jsonl` behind a synced
  session (`d101ffb`).
- The delete button stays visible in the sidebar for synced conversations (`247aeb1`).

#### Deleting a conversation no longer needs a second click

The sidebar rebuilt its whole list with `innerHTML` on every refresh. When a refresh landed between
pressing and releasing the mouse — for example while a session was still loading — the button the
press started on was destroyed, and the browser then delivered no click at all. The press looked
ignored, so the trash had to be pressed twice.

- The list is no longer rewritten when the generated markup is identical, so the frequent redundant
  renders (`resetSession()` followed by `refreshSessions()`) leave the DOM untouched.
- A press inside the list now defers any re-render until the release, so the click always lands on
  the element it started on. The deferred render runs right after it.
- Row, project-toggle and delete handlers are delegated on the list container instead of per node, so
  a rebuilt row can never keep a stale handler or lose one.
- Verified in Chromium: a re-render requested while the mouse is held down no longer swallows the
  click, while the previous behaviour (raw `innerHTML` replacement during the press) does drop it.

#### Image paste in the terminal: Ctrl+V added next to Alt+V

Claude Code binds image paste to `alt+v` on Windows — `ctrl+v` only on macOS, Linux, and WSL — and the
classic Windows console swallows `Ctrl+V` for its own paste. Pressing `Ctrl+V` with a screenshot in the
clipboard therefore did nothing.

- The launcher now merges `ctrl+v -> chat:imagePaste` into the profile's `keybindings.json`. Existing
  bindings and every other context survive; an explicit user choice (including an unbind) is never
  overwritten, and a file with a syntax error is left untouched.
- Documented that **Alt+V** is the Windows shortcut and works in the classic console today, plus the two
  ways to make `Ctrl+V` arrive there (Windows Terminal, or `CtrlKeyShortcutsDisabled`).
- Without an image the action falls back to a normal text paste, so the extra binding cannot break
  pasting text.

#### Playwright built into the install and update flow

Upstream shipped no browser automation. This fork installs Playwright next to the runtime, so
screenshots and browser checks work from the portable drive without touching the user profile.

- First launch installs the pinned package into `engine/playwright` and the headless Chromium build
  into `engine/playwright-browsers` (~300 MB; `--only-shell` avoids the ~750 MB full build).
- Every later launch only checks the installation. A complete setup needs no network.
- Menu option 5 (`install` / `update`) repairs the runtime **and** Playwright.
- Menu option 7 (`check-update`) reports newer Playwright releases next to the Claude Code updates
  and installs them with the same pin rollback: a failed install restores both pins.
- The version lives in `tools/runtime-manifest.json` (`"playwright": "1.65.1"`), because it decides
  the Chromium build revision.
- A failing Playwright install is a warning, never a startup error. `--offline` and
  `PORTABLE_AI_NO_PLAYWRIGHT=1` skip it.

#### Paste and drop attachments in the studio

Upstream only accepted files through the picker behind the **+** button.

- **Paste** — a screenshot in the clipboard goes straight into the attachment list
  (Ctrl+V / ⌘V in the composer). Text pastes are untouched.
- **Drag and drop** — files can be dropped anywhere in the studio window; the composer highlights
  as the drop target and a drop outside never navigates away from the page.
- Pasted images arrive without a file name and often as `application/octet-stream`. The server now
  detects the real format from the file's magic bytes (PNG, JPEG, GIF, WebP) and stores the type in
  a metadata sidecar, so it survives a restart.
- Images get their own 5 MB limit, because they travel to the model as base64 and providers cap them
  far below the generic 10 MB.

#### Images reach the model as image blocks

Upstream passed attachments to the agent as local paths only, so a picture had to be opened by the
agent with its file tools before the model could see it — and a model without tool support never saw
it at all.

- Attached images are now sent in the SDK's streamed prompt form as real `image` content blocks,
  exactly what the Claude Code terminal does with a pasted screenshot.
- Messages without images keep the original single-string prompt, so nothing about the text-only
  path changes.
- Verified end to end against the official runtime: the image block reaches the provider.

#### Standalone session resume (`RESUME.bat`, `resume.sh`)

Upstream only offered `START.bat resume <session-id>`, which still ran the full launcher: runtime
checks, provider setup, update handling. This fork adds a resume path that does exactly one thing.

- `RESUME.bat` (Windows) and `resume.sh` (Linux/macOS) are self-contained entry points.
- They verify that Node.js, the Claude Code executable and `data/settings.json` exist, and fail with
  a clear "run START.bat first" message instead of installing, repairing, updating or reconfiguring
  anything. This is the behavioural difference from `START.bat`: nothing is repaired silently.
- Arguments are parsed in Node (`lib/resume.mjs`), not in batch, so quoting, spaces and Unicode in
  paths work on every platform and the rules are unit-tested:
  - `<session-id>` (positional) or `--resume <session-id>`
  - `--cwd <directory>` or a positional directory
  - `--safe` / `--unrestricted` for a one-off permission override
  - duplicates, missing values, unknown flags and malformed IDs are rejected with exit code 1
  - an existing directory always wins over the positional session-ID interpretation
- Without an ID the most recent conversation in the working directory is continued; if none exists,
  a warning is printed and a new session starts (upstream behaviour, preserved).
- The default working directory is the project folder.

New files: `RESUME.bat`, `resume.sh`, `lib/resume.mjs`, `tools/resume.mjs`, `tests/resume.test.mjs`.

#### Bypass permissions as a stored setting (default ON)

Upstream chose the mode in an interactive menu on every launch. This fork stores it, so the
launcher, the resume path and the studio agree, and the choice survives restarts.

- Stored as `preferences.bypassPermissions` in `data/settings.json`; **missing value means ON**.
- Applies to `START.bat cli`, `--quick`, `--offline`, `START.bat resume`, `RESUME.bat`,
  `./start.sh cli`, `./start.sh resume` and `./resume.sh`.
- Change it permanently with `START.bat permissions on|off`, `./start.sh permissions on|off`,
  `START.bat permissions status`, or menu option 8 (toggles and returns to the menu).
- Override it for a single launch with `--safe` (approvals on) or `--unrestricted` (approvals off).
  Neither switch is forwarded to Claude Code.
- Passing `--dangerously-skip-permissions` or `--permission-mode bypassPermissions` yourself still
  requires typing `UNRESTRICTED`; the stored preference does not weaken that check.
- The effective mode is printed on every terminal launch (`Bypass permissions: ON/OFF`).

New files: `lib/permissions.mjs`, `tests/permissions.test.mjs`.

#### Git Bash handling

Claude Code on Windows needs Git Bash for its shell tool. Upstream assumed it was installed.

- `lib/git.mjs` resolves a usable `bash.exe` in this order: `CLAUDE_CODE_GIT_BASH_PATH`, the bundled
  `engine/git-win-x64`, the standard installation paths, then the directories around any `git.exe`
  on `PATH` — including MSYS2 layouts such as `<root>/ucrt64/bin/git.exe`, where `bash.exe` lives
  two levels up.
- The session environment receives `CLAUDE_CODE_GIT_BASH_PATH` and Git's `cmd`, `bin` and `usr/bin`
  prepended to `PATH`.
- `tools/bootstrap.ps1` downloads PortableGit **only when no Git for Windows is present**, and keeps
  the download out of the startup path for everyone else. A failed download is a warning, not an
  abort, so the app still starts.

New file: `lib/git.mjs`, covered by `tests/local.test.mjs`.

#### Zero-footprint environment

Upstream redirected only `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME`
inside the launcher batch file.

- `portableEnvironment()` (`lib/providers.mjs`) also points `HOME`, `USERPROFILE`, `APPDATA` and
  `LOCALAPPDATA` at `data/home`, `data/app_data` and `data/local_app_data`, and creates them.
- It is applied to the **session child process only**. The dashboard server keeps the host
  environment, so browser and system integration are unaffected.
- The provider environment filter still removes ambient credentials first, so a host
  `ANTHROPIC_API_KEY` cannot leak into a session.
- **The host Git configuration stays linked in.** A redirected `HOME` hides `~/.gitconfig`, which
  made an agent's `git commit` fail with "Author identity unknown". The session now receives
  `GIT_CONFIG_GLOBAL` pointing at the host `~/.gitconfig` (or `~/.config/git/config`), resolved from
  every available profile location — including `HOMEDRIVE`+`HOMEPATH`, so detection still works when
  a session is started from an already redirected environment. This is a deliberate exception to
  zero-footprint, and `git config --global` inside a session writes to that host file.
  `PORTABLE_AI_NO_HOST_GIT_CONFIG=1` disables the link.

#### Automatic Ollama server and speed proxy

Upstream had no speed proxy and left starting the local server to the user.

- When the active profile is Ollama, every terminal launch starts the bundled
  `data/ollama/ollama.exe` and the speed proxy, then routes the session through the proxy.
- The proxy (`tools/local-proxy.mjs`) trims Claude Code's system prompt from roughly 10k tokens to
  ~300 before it reaches the model. It understands **both** protocols:
  - `/v1/messages` — how Claude Code reaches Ollama through its Anthropic-compatible endpoint.
    A proxy that only rewrites `/chat/completions` never sees these requests.
  - `/chat/completions` — other OpenAI-style clients
- Truncation cuts at a sentence boundary and appends a marker instead of slicing mid-word.
- `/health` endpoint; activity is written to `data/logs/proxy.log` only, never to the terminal.
- Tunable with `PORTABLE_PROXY_PORT` and `PORTABLE_PROXY_MAX_CHARS`.
- Shutdown is exact: **only processes this launch started are stopped**. A server or proxy the user
  started elsewhere keeps running.
- Failures degrade instead of blocking: no bundled Ollama means the external server is used; a proxy
  that cannot bind its port means the session runs untrimmed and says so.

New files: `lib/local-session.mjs`, `tools/local-proxy.mjs`; extended `lib/local-models.mjs`,
`tools/launcher.mjs`, `lib/resume.mjs`.

#### Launcher and documentation

- Menu option 8 shows and toggles the permission mode.
- Launcher hints name the script actually running (`START.bat` vs `start.sh`).
- `README.md`: permission-mode matrix for Windows and Linux/macOS, environment-variable reference,
  Ollama automation, zero-footprint notes, updated project structure and troubleshooting entries.

---

### Changed

- **Node.js 24.21.0 → 26.13.1** (LTS "Lithium"), updated in `tools/bootstrap.ps1`, `start.sh`, the
  CI matrix (`node-version: '26'`), `package.json` (`engines: >=26`) and the README. An existing
  installation is replaced automatically on the next launch; the previous runtime is kept as
  `engine/node-win32-<arch>.previous.<timestamp>`.
- `canUseTool` is installed only for permission modes that can actually consult it (see below).

---

### Fixed

#### Native sessions could not run a turn — `Cannot read properties of undefined (reading 'push')`

Sessions imported from the Claude history only carry `messages` and `transcript`; `syncNative`
created them without an `events` array, and the agent appended to it on the first turn.

- `syncNative` now writes `events: []` and preserves an existing log.
- `AgentManager.start` normalises `messages` and `events` before the run.
- The dashboard reconnect endpoint tolerates a missing log.

#### A failed start blocked the session forever — `A turn is already running`

`start()` registered the run before doing work that could throw. A failure left the entry in the run
map, so every later attempt was rejected.

- The registration is now released when that phase throws.
- Covered by a regression test.

#### Providers rejected tool search — `Unsupported content: tool_reference`

Claude Code's tool search returns `tool_reference` blocks naming deferred tools. The Anthropic API
expands them server-side; third-party providers do not, and the adapters threw.

- The adapters now skip `tool_reference` blocks. No information is lost: every tool schema —
  including deferred ones — is forwarded anyway, because `defer_loading` is not propagated.
- A tool result made up only of references is sent as `Tool returned no textual output.` rather than
  an empty body.

#### SDK warning `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`

The dashboard passed both `canUseTool` and `permissionMode: 'bypassPermissions'`. The SDK approves
every tool call before consulting the callback in that mode, so the callback was dead code and the
SDK warned on every turn.

- The callback is now installed only for `default` and `acceptEdits`. Approval handling in those
  modes is unchanged, and the warning is gone at its source rather than suppressed.

---

### Tests

50 → **106** test cases (`npm test`) against the upstream baseline, all passing, plus `npm run check`.
The adopted pull requests contributed `tests/composer.test.mjs` and additions to
`tests/backend.test.mjs`.

New suites: `tests/resume.test.mjs`, `tests/permissions.test.mjs`, `tests/local.test.mjs`.
Regression tests were added for the three bugs above and for the permission behaviour of both the
terminal launcher and the studio.

---

### Upgrade notes

1. Run `START.bat` / `./start.sh` once. Node.js 26.13.1 is fetched automatically; the previous
   runtime is kept next to it.
2. Git for Windows is reused when already installed. Without it, PortableGit is downloaded once into
   `engine/git-win-x64/`.
3. Terminal sessions now run with approvals disabled by default. Run
   `START.bat permissions off` (or `./start.sh permissions off`, or menu option 8) if you want to be
   asked before every write or command.
4. `RESUME.bat` no longer goes through `START.bat`, so it will not repair a broken runtime. If it
   reports a missing runtime, run `START.bat` first.
