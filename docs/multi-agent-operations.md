# Multi-Agent Operations

## Prerequisites

AutoDev requires:

- a canonical Git repository root;
- the pinned official Claude Code runtime and Agent SDK;
- an API-backed or local active provider (dashboard AutoDev does not use terminal-login-only profiles);
- Git available to the portable process.

Codex delegation additionally requires the official `codex` CLI and an OpenAI provider credential saved in the portable provider settings. Codex is optional; a missing executable or credential leaves that backend unavailable.

The implementation was developed against Codex CLI `0.164.0`. Verify the installed version with:

```bash
codex --version
codex exec --help
```

## Commands

Enter commands in the dashboard composer:

```text
/auto-dev implement the requested change
/multi-review review the selected repository
/deep-review audit authentication and path handling
/agent-status
```

`/agent-status` is ledger-backed and never launches a worker. AutoDev commands do not accept chat attachments; include relevant paths in the request.

## Dashboard controls

The AutoDev inspector shows phase, status, package progress, approvals, cancellation, and resume controls.

- **Approve / Deny** decides a pending destination-integration request. Worker-requested critical actions show only the supported deny/cancel path because the generic manager has no application-owned executor for them. The server resumes the run asynchronously after either integration decision; a denial transitions the run to cancellation.
- **Cancel run** aborts active workers and persists cancellation.
- **Resume run** is shown for interrupted or blocked runs. Resume revalidates state and may rerun tests/reviews.

Event streams reconnect from the last observed sequence with bounded exponential backoff. Run lists are paginated to at most 100 entries and omit accumulated event bodies; replay is bounded to 1,000 events per connection. If replay exceeds that bound, refresh run status and reconnect from its latest sequence. The complete event history remains in the ledger for audit.

The dashboard permits at most three active AutoDev runs by default, in addition to each run's package concurrency bound. Runtime maintenance, provider changes, and new AutoDev launches are rejected while they would create stale or conflicting worker state. Saving provider settings requires a dashboard restart before new chat or AutoDev execution.

## Persistent data

AutoDev stores data below the portable data directory:

```text
data/autodev/ledger.json                 legacy/default-repository ledger
data/autodev/repositories.json           canonical repository registry
data/autodev/repositories/<hash>.json    additional repository ledgers
```

Owned worktrees are created next to each repository in a hash-named `.openclaude-autodev-*` directory, not inside the source checkout. Ownership records live under that directory's `.owners/` folder.

Do not manually edit ownership records. If a run is interrupted, use Resume so the host can verify and adopt its registered worktrees. A mismatched branch/path/owner intentionally blocks recovery.

## Limits

Default limits:

| Limit | Default |
|---|---:|
| Concurrent development packages | 3 |
| Review rounds | 2 |
| Repair attempts | 3 |
| Planned packages | 20 |
| Worker turns per invocation | 24 |
| Worker timeout | 15 minutes |
| Worker budget where exposed | USD 10 per invocation |

Limits can be supplied to the API when creating a run. Values must be positive. The cost ceiling is not yet aggregated across all calls in a run.

## Validation

Normal deterministic verification:

```bash
npm run test:autodev
npm test
npm run check
```

The final repository validator discovers `tests/*.test.mjs`, runs them with the current Node executable, and also runs `tools/check.mjs` when present. Both timeout and captured output are bounded. A run cannot report success if the validator returns no checks or a required check fails.

Networked provider tests are deliberately opt-in because they transmit source and consume provider capacity or paid tokens. The controlled runner creates a disposable Git fixture, seeds two non-overlapping packages, invokes both real providers, injects a known Codex-owned defect, requires owner repair and reciprocal review, explicitly approves only fixture integration, and validates the integrated fixture:

```bash
AUTODEV_REAL_E2E=1 npm run test:autodev:real
```

Without `AUTODEV_REAL_E2E=1`, the command exits successfully with an explicit skip and makes no provider calls. The active Claude provider must be API-backed, and the saved OpenAI profile must have a valid key with the official `codex` executable discoverable through `PATH` or `CODEX_EXECUTABLE`. Never label mocked worker tests as a real provider E2E.

## Troubleshooting

| Symptom | Meaning / response |
|---|---|
| `AutoDev unavailable: Configure an active provider...` | Configure an API-backed or local provider. The rest of the dashboard remains available. |
| `target must match the configured repository` | A manager was invoked for another repository. Dashboard registry routing should create/select that repository's manager; verify the selected path is the Git root. |
| `cross-model backend unavailable` | Reciprocal review requires both Claude and Codex. Install/configure Codex or use a mode that does not claim cross-model completion. |
| `owned worktree is not registered` | Git no longer recognizes a persisted owned path. Inspect it manually; do not delete or force-recreate it automatically. |
| `branch moved from approved commit` | Package content changed after review/approval. Rerun review rather than integrating. |
| `integration destination moved` | Another process changed HEAD after approval. Reconcile manually and resume/recreate the run. |
| `integration destination has uncommitted changes` | Preserve those user changes and integrate only from a clean destination later. |
| `Claude returned ... sandbox ... unavailable` | Fail-closed sandbox initialization failed on this platform. Install the required sandbox dependency or use a supported environment; do not disable the boundary for autonomous writes. |
| Codex authentication failure | Confirm the saved OpenAI profile key and run an explicit opt-in credential smoke test. Never paste the key into logs or prompts. |

## Shutdown

Dashboard shutdown aborts active chat and AutoDev worker operations, closes adapters, and closes all per-repository managers. Persistent state remains available for recovery on the next launch.
