# Portable AI — Developer Studio

A portable launcher and independent browser workspace powered by **official Anthropic Claude Code**, with nine provider configurations. No OpenClaude runtime is installed or used.

The studio has a graphite/teal dark theme, a light theme, session search, streaming Markdown and highlighted code, a tool inspector, explicit approvals, cancellation, session resume, local-model controls, and runtime diagnostics. Below 1280px the inspector becomes a drawer; below 768px navigation does too.

## Start here

From this folder on macOS / Linux:

```sh
bash start.sh
# Directly open the browser studio:
bash start.sh dashboard
# Or launch the real Claude Code terminal:
bash start.sh cli
```

On Windows:

```powershell
.\START.bat
.\START.bat dashboard
.\START.bat cli
```

First launch downloads checksum-verified Node.js and installs pinned official packages inside `engine/`. No global npm installation or shell profile change is made. Windows needs PowerShell and network access for setup. macOS/Linux need Bash, curl and tar. The bundled Linux Node build requires glibc; Alpine/musl is not supported by this bootstrap. Runtime-specific OS requirements also apply. Git is useful for project operations; Windows can use the official runtime's PowerShell support without bundled Git.

The launcher prints a loopback URL containing an ephemeral access token and opens it in your browser. Keep the terminal running. A plain visit to port 3000 without that token cannot use the APIs. If port 3000 is occupied, set `PORTABLE_AI_PORT` before launching. Set `PORTABLE_AI_NO_OPEN=1` to suppress automatic browser opening.

In **Providers**, choose the provider, credential, endpoint and model; use **Discover models** or enter an exact identifier. Start a session and confirm its workspace. Do not point an agent at a directory you do not trust.

Use the folder control in the top bar or composer to choose any local project with the operating system's folder picker. Every chat remains locked to the workspace where it started. Choosing another folder from an existing chat asks whether to start a new chat there or continue in the current workspace. Linux uses Zenity or KDialog when available and falls back to manual path entry.

## Providers

| Provider | Runtime connection | Default base URL |
| --- | --- | --- |
| Anthropic | Messages API; account login in terminal only | `https://api.anthropic.com` |
| OpenRouter | Native Anthropic-compatible API | `https://openrouter.ai/api` |
| DeepSeek | Native Anthropic-compatible API | `https://api.deepseek.com/anthropic` |
| Ollama | Native Anthropic-compatible API | `http://127.0.0.1:11434` |
| LM Studio | Native Anthropic-compatible API | `http://127.0.0.1:1234` |
| NVIDIA NIM | Local Chat Completions adapter | `https://integrate.api.nvidia.com/v1` |
| Google Gemini | Local Chat Completions adapter | `https://generativelanguage.googleapis.com/v1beta/openai` |
| OpenAI | Local Chat Completions adapter | `https://api.openai.com/v1` |
| Custom API | Local Chat Completions adapter | User supplied |

For OpenRouter, `/api/v1` is the model-discovery/Chat Completions endpoint; the direct Claude Code connection uses `/api`. No paid fallback is selected automatically. The tested live model is `minimax/minimax-m3:free`; its availability, limits and pricing are controlled by OpenRouter.

**Non-Claude models are experimental, not supported by Anthropic.** Model selection is not a guarantee of tool calling, context capacity, image support or feature parity. Errors identify unsupported capabilities instead of silently falling back. The built-in adapter supports text, base64 images (including images returned by the local Read tool), streaming, tool definitions/calls/results and stop reasons. The Responses adapter maps those images to `input_image`. Gemini OpenAI-compatible tool calls retain Google's opaque thought-signature metadata across tool steps. Extended thinking and provider-native server tools remain unsupported through the generic adapter. Token counting is an explicitly labeled estimate; the selected upstream model must itself support vision.

OpenAI-compatible providers (NVIDIA, Gemini, OpenAI, Custom) offer three protocol choices. **Built-in** and **External claude-adapter** target `/chat/completions`; the external choice uses the pinned `claude-adapter` dependency and adds native/XML tool modes plus optional opus/sonnet/haiku aliases. **Responses API** targets `/responses` and forwards upstream text and function-call argument deltas incrementally as Anthropic SSE, with final usage and stop reasons preserved. All three run loopback-only with a per-run token and no home-folder writes. The external adapter does not support images; keep Built-in when you need vision. Changing the adapter starts a new session.

All providers resume the native Claude Code session so GUI and portable terminal conversations remain the same history. Non-Claude models may have smaller context windows or incomplete resume/tool compatibility; use the composer context meter and choose a larger compatible model when necessary.

Provider failures show the upstream HTTP status and response detail whenever the endpoint supplies them, including plain-text response bodies. If an endpoint returns only an opaque message such as `Internal server error`, the dashboard explicitly says that no diagnostic detail was provided and identifies the provider/model plus likely compatibility or context causes instead of presenting the generic message as a diagnosis.

The official SDK executes the agent loop in the browser workflow. There is no separate custom agent loop and no prompt trimming. Auxiliary model roles use the selected provider model. Claude account credentials are never forwarded to another provider. Account-login profiles cannot run in the custom dashboard; use API credentials or local endpoints there.

Read, Bash, edit, search, thinking, and assistant text are shown as one chronological conversation timeline in the exact order Claude Code emits them; tool calls are not regrouped above or below the related text. Each compact expandable tool step exposes its exact input and result while the right inspector remains a separate overview. New sessions persist this ordered timeline. Older sessions whose original event order was never recorded show an explicit history note instead of guessing where their tool calls occurred.

Readable thinking blocks are shown only when they are actually returned by the selected model/runtime. Redacted thinking, signatures, and approximate thinking-token progress are never presented as reasoning, and the dashboard does not invent filler between tool calls. Generic adapter providers currently run with thinking disabled because provider-specific reasoning/signature formats are not portable.

## Sessions and permissions

- **Review actions** uses Claude Code's standard permission checks. Tools that need permission request approval; routine reads and some safe shell commands can run without a prompt.
- **Allow file edits** uses the SDK's `acceptEdits` mode. File operations can run without prompting; other actions retain their permission checks. This is not a promise that every shell command will prompt.
- Choose permissions beside the message field. Changes apply to the **next turn**, not a currently running action; the header and inspector show the current turn's mode. Reloading resets the next-turn selection to Review actions.
- Choose any saved dashboard-compatible provider/model directly beside the message field. Switching starts a new chat with that profile and keeps the current chat in history; it is disabled while a turn is active. Configure another provider in **Settings → AI provider & model** and it appears there automatically.
- The composer shows the latest request's input-token usage beside the selected model (`Context 42k / 128k`). Model discovery fills the limit when the provider reports it; otherwise set the model's context window in provider settings. The meter turns amber at 80% and red at 100%. It is per-request context usage, not cumulative billing usage.
- Use the **+** button to attach screenshots, source files, documents, or ZIP archives (up to 10 files, 10 MB each, 20 MB total). Attachments are copied into a private per-session folder under portable `data/`; archives are not silently extracted or executed. The agent receives their verified local paths and handles inspection through the normal permission flow.
- Questions and approval decisions live **inside the composer**, not the inspector. Questions support single/multiple selections, custom text, and Back/Continue navigation. Tool approvals show the action and expandable exact arguments. Your unsent message draft is restored when requests finish. The inspector remains a read-only tool timeline.
- **Unrestricted mode** requires typing `UNRESTRICTED` and resets when the browser reloads. Terminal bypass flags also require an interactive warning confirmation. Quick launch stays in normal mode.
- A session is bound to its workspace and provider/model/auth/endpoint selection. Changing these starts a new session. API key rotation does not invalidate the binding.
- GUI and portable terminal sessions share the official Claude Code session ID and native history. The dashboard discovers terminal-created native sessions and groups them under their working folder; continuing a discovered conversation resumes that same Claude session. Reopen a running GUI session after reconnecting and the agent continues while the browser is disconnected. Restarted-studio sessions are marked interrupted and can be resumed.
- **New chat** starts a projectless agent conversation in a private portable workspace. It keeps the same models, tools, approvals and attachment support without referring to a project. **Open folder** starts a project-backed chat. The sidebar separates projectless **Recents** and groups project chats by workspace.
- You can open Settings during a turn and return to the highlighted active chat without stopping it; live text and tool events continue in the background. Switching to a different chat or workspace remains blocked until the active turn ends or is stopped.
- Provider HTTP, authentication, rate-limit, connection, and protocol errors stop the turn immediately and show the provider's sanitized message. The two-minute timer is reserved for requests where neither the provider nor runtime returns any response. It is paused while an approval needs your input or a local tool is running, then applies again when the agent waits for the model.
- The dashboard disables automatic loading of filesystem settings/hooks (`settingSources: []`). It does not automatically load your project's CLAUDE.md or plugins. The terminal retains the official CLI behavior. Workspaces still need to be trusted.
- Legacy conversations remain read-only. OpenClaude session IDs are not Claude Code session IDs.

Terminal resume:

```sh
bash resume.sh <official-session-id>
# Windows: .\RESUME.bat <official-session-id>
```

## Local models

Run `bash start.sh local-setup` or `.\START.bat local-setup` for the existing interactive portable Ollama setup. Model selection happens before downloads. Setup now saves the new provider configuration. In the studio's **System** page, start the installed server, refresh the model list, or explicitly request a model download. Only Ollama processes started by this studio can be stopped by it. LM Studio is managed in its own application.

Local inference needs a tool-capable model, adequate RAM/VRAM and enough context. An installed model can work without internet after initial package setup; local inference is not a promise that every Claude Code feature works offline.

## Runtime versions and updates

- Bundled Node.js: **22.23.2**
- Official Claude Code: **2.1.247**
- Claude Agent SDK: **0.3.247**

Dependencies are pinned in `tools/runtime-manifest.json`. Each platform has its own `engine/<os>-<arch>/current` installation. Installs stage a replacement, verify `claude --version`, then swap it into place, retaining `previous` for rollback. Failed installs preserve the working runtime. Background official updates are disabled for these managed copies.

```sh
bash start.sh install    # install / repair the pinned versions
bash start.sh update     # apply the pinned manifest, not an untested latest release
bash start.sh rollback   # restore previous runtime
bash start.sh status
```

To upgrade, deliberately update the manifest, run tests, then apply it. Restart the dashboard after maintenance so the SDK and executable match. If an interrupted installer leaves `install.lock`, confirm no installation process is still running before removing that specific lock directory.

## Data and security boundaries

`data/settings.json` stores provider credentials as plaintext, with owner-only POSIX permissions. `data/` and `engine/` are ignored by Git. Windows relies on the folder's inherited ACL. Protect the drive and do not share its data directory. The authenticated, loopback-only dashboard can retrieve a selected provider credential when you explicitly click its reveal icon; normal configuration/bootstrap responses remain redacted. Session and diagnostic output is redacted for configured credentials.

The dashboard and adapter bind to `127.0.0.1`. API routes require the ephemeral token, validate Host/Origin and reject non-JSON mutations. Markdown is sanitized and external conversation images are blocked. The adapter has a separate per-run token and does not log credentials. This is not a network-hosted multi-user service or a filesystem sandbox.

App-owned configuration, runtime sessions, caches and logs stay in the portable folder where supported. OS login credentials, subprocess tools and the official runtime can still use system facilities. **This is not a zero-footprint or fully portable-login guarantee.** Provider requests transmit prompts and relevant project content to the selected service.

On first use, old `ai_settings.env` is copied to `ai_settings.env.pre-claude-code.bak` and mapped into version-2 settings without executing it. Existing data is not deleted. `PORTABLE_AI_DATA_DIR` can select an isolated data directory for tests.

## Verification

```sh
npm test                 # offline unit and integration tests
npm run check            # syntax and obsolete-runtime checks
npm run smoke            # real CLI + SDK, scripted loopback provider, no paid API
node tests/live-provider.mjs  # opt-in: uses the configured provider on a synthetic fixture
node tests/ui-fixture.mjs     # isolated UI-only fixture on port 3001; never a live model
```

The real-runtime smoke test checks read → approved write → shell command → resume in a temporary path containing spaces. The UI fixture explicitly labels its synthetic activity and uses separate temporary settings; it is not loaded by the normal application.

Locally verified: macOS ARM64 installation, 20 automated checks, real runtime/SDK workflow and resume, and a live OpenRouter MiniMax free-model read/write/command test. Browser checks cover dark/light appearance, 390/768/1024/1440px layout, provider forms, model discovery/search, approvals, code highlighting/copying and Markdown sanitization. Composer question/approval and permission controls are tested with the isolated UI fixture (not a new live-provider test). Windows/Linux CI is configured but was not run on this Mac. Other providers require live verification with suitable credentials/models. Local-model downloads were not run.

## License and attribution

This repository's wrapper retains its MIT license and original project history. Claude Code, the Agent SDK and other dependencies retain their own licenses and terms. “Portable AI” is an independent interface, not an official Anthropic product.

- [Official Claude Code installation](https://code.claude.com/docs/en/installation)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
- [OpenRouter integration](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration)
- [LM Studio integration](https://lmstudio.ai/docs/integrations/claude-code)
