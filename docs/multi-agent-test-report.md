# Multi-Agent Test Report

## Status

This report distinguishes deterministic local verification from real provider execution. Passing fake-worker tests verifies host control flow and safety checks; it does not prove that Claude or Codex authenticated or completed a real cross-provider run.

## Versions observed

- Claude Code: `2.1.247`
- Claude Agent SDK: `0.3.247`
- OpenAI Codex CLI: `0.164.0`
- Repository Node requirement: `>=22`

## Deterministic verification

On 2026-10-30, after the latest dependency-snapshot, post-merge scope-baseline, exact-staging-commit, registry-shutdown-race, exhaustive active-run, resume/approval guard, maintenance-admission serialization, repair-checkpoint, validation/cleanup recovery, SSE-backpressure, browser-reconnect/unavailable-state, provider-reasoning, recovery, sandbox, host-evidence, Codex-policy, approval-denial, and NUL-delimited Git-path hardening changes, these commands were executed:

```bash
npm run test:autodev
```

Observed result: **106 tests passed, 0 failed**.

```bash
npm test
```

Observed result: **157 tests passed, 0 failed**.

```bash
npm run check
```

Observed result: **JavaScript syntax and runtime reference checks passed**.

Protected pre-existing file hashes were rechecked:

```text
a019bfb26f6d5a7811dfff50158a29d2242a03dd36947c84453e90427278eae4  lib/adapter.mjs
88d06959f4ccf425ebea14d2a9586b9226e8c1babf11d720afeb90310b5497b9  tests/adapter.test.mjs
63ffe6562e68b94ad224bed8931ae054b188d9dd7ff76c7d511d33dcbf49bae5  lib/adapter.mjs.backup
```

The hashes matched their recorded protected values.

## Covered behavior

The deterministic suite includes:

- immutable default limits and explicit lifecycle phases;
- atomic redacted ledger state, monotonic replay, interruption recovery, execution claiming, concurrent approval decisions, cancellation preservation, replay-to-live handoff, and shutdown settlement;
- DAG validation, bounded concurrency, and path-overlap serialization;
- owned worktree creation/adoption, ownership mismatch, unregistered paths, dirty cleanup refusal, and destructive Git guards;
- scoped commits that clear inherited staging and reject out-of-scope entries;
- NUL-delimited dirty/staged Git-path handling for spaces, tabs, Unicode, embedded newlines, and rename endpoints;
- dependency branch visibility, fresh dependency snapshots, post-merge child scope baselines, and repair finalization;
- disposable staging integration, destination guards, package branch/commit binding, and exact staging-HEAD revalidation immediately before apply;
- Codex process arguments, read-only/workspace-write role selection, JSONL/schema handling, secret isolation, output caps, timeout, abort, classified failures, delayed termination, and fail-closed per-process write-command policy;
- Claude Agent SDK role/options, exact per-role built-in tool exposure, structured results, fail-closed sandbox options, direct path controls, symlink escapes, cancellation, timeout, and protocol failures;
- reciprocal cross-model review, host-observed required gates, rejection of fabricated worker passes, owner-targeted repair routing, repair/review bounds, interrupted multi-package repair checkpoint recovery, and truthful blocked reports;
- early per-package workspace/completion checkpointing, sibling-failure preservation, explicit backend availability, final-validation evidence retention, cleanup-only resume after cleanup failure, and recovery-compatible ownership;
- per-canonical-repository manager/ledger routing, lazy restart behavior, and shutdown races during canonicalization/runtime creation;
- dashboard authentication, command parsing, optional-ledger degradation with a persistent unavailable UI and client-side command guard, shared serialization between runtime maintenance and AutoDev admission, maintenance/restart guards for creation/resume/approval, serialized global launch caps, exhaustive paginated active-run accounting, bounded run/event payloads, SSE validation/disconnect/backpressure handling, approval continuation, cancellation, and resume routes;
- final validator pass, failure, timeout, empty-evidence, and output-limit handling.

Scoped `git diff --check` over the AutoDev/dashboard changes produced no output. The protected-file hashes below were rechecked after this verification and still match.

## Provider and E2E evidence

A real Codex authentication smoke test was executed on 2026-10-27 in a disposable empty Git repository with the official CLI, `read-only` sandbox, structured schema, bounded output, and a 120-second timeout. The first launch from `/private/tmp` was correctly rejected by Codex because it was not a trusted Git directory. The retry from the disposable repository returned the structured value `{ "ok": true }`. The process exposed no usage or cost fields, so none are reported.

A real Claude worker smoke test through the active OpenAI Chat Completions adapter initially failed because Claude Code requested unsupported extended thinking: `API Error: 400 Extended thinking is unavailable through the Chat Completions adapter. Disable thinking for this provider.` AutoDev now disables thinking only for adapter-backed providers while retaining high effort. A subsequent smoke exposed that assigning a programmatic agent through the top-level `agent` option hid the harness-owned `StructuredOutput` tool, so the provider returned JSON text without `structured_output`; AutoDev now runs the selected role on the main thread with its role prompt, tool restrictions, and permission mode. The first successful retry returned status `succeeded`, summary `Claude smoke passed`, a real session ID, 19,444 input tokens, 90 output tokens, zero thinking tokens, and observed cost USD 0.09947. After replacing the broad Claude Code tool preset with the reviewer's exact `Read`, `Glob`, and `Grep` list, another disposable smoke both read its fixture and returned validated structured output. Its initialization exposed exactly `Glob`, `Grep`, `Read`, and the SDK-injected `StructuredOutput`; it observed 9,553 input tokens, 310 output tokens, zero thinking tokens, and cost USD 0.055515. No repository source was used in either smoke fixture.

A real dashboard startup/API smoke test was executed after the repository-registry and Resume changes. The page, authenticated configuration route, and authenticated AutoDev run-list route each returned HTTP 200, and the page included a Content Security Policy. This verifies server startup and basic authenticated API routing; it does not substitute for a real browser interaction test.

Three bounded Codex negative scenarios were also observed: a one-millisecond invocation limit raised `CodexTimeoutError` with code `CODEX_TIMEOUT`; an empty per-process credential was rejected before launch with `CODEX_API_KEY is required`; and a synthetic invalid credential produced a sanitized HTTP 401 and `CodexExitError` with code `CODEX_EXIT`.

A real Claude/Codex cross-model fixture E2E completed successfully on 2026-10-30 in a disposable Git repository. The observed run:

1. executed two non-overlapping writable packages concurrently, with Claude implementing one and Codex implementing the other;
2. performed reciprocal reviews (`Codex → Claude` and `Claude → Codex`) in read-only sandboxes;
3. injected one controlled defect after the initial Codex implementation and observed its package gate fail;
4. routed the verified defect back to Codex, committed the repair, reran host-owned tests, and rereviewed both packages;
5. paused before destination integration, consumed an explicit approval bound to the validated staging commit, and left the destination unchanged before approval;
6. integrated the exact approved commits and passed the host-observed fixture integration suite;
7. finished with status `succeeded`, a truthful successful report, 15 real provider calls, and two simultaneously active implementers.

The Claude calls exposed 139,229 input tokens, 10,554 output tokens, and observed cost USD 0.959995. The Codex CLI worker exposed no usage or cost fields, so no Codex or aggregate cost is claimed. Earlier attempts truthfully failed on an OpenAI strict-schema rejection, an eight-turn Claude limit, and a Codex attempt to run a host-owned gate; those issues were corrected by making every object property required-and-nullable where appropriate, raising the bounded fixture turn limit to 16, and explicitly reserving gate execution for the host. The separately observed missing-authentication, timeout, and invalid-credential failures remain the negative-scenario evidence described above.

## Known limitations

- `maxBudgetUsd` is a per-worker-call ceiling, not an aggregate run budget.
- An interrupted repair round resumes from its per-package checkpoint; other resumptions may rerun tests and reviews to refresh evidence.
- Review/test/fix loops are mostly serial and can be optimized without changing safety semantics.
- Claude sandbox networking has no explicit outbound allowlist.
- Integration approval uses a SHA-256 digest over the run, action, expected destination HEAD, validated staging commit, and ordered package commits, but approval expiry metadata is not yet enforced.
- Ledger updates rewrite the complete JSON ledger and may become slower with very long histories; dashboard lists are paginated and event replay is bounded, but ledger storage itself is not compacted.
- Ledger serialization is process-local and atomic replacement does not currently include explicit file/parent-directory `fsync` durability.
- The browser reconnects AutoDev streams with bounded exponential backoff, but still uses one stream per active run rather than a multiplexed stream.
- Provider usage/cost is reported only when exposed by a worker; the real E2E exposed Claude usage and cost but no Codex usage or cost, so no aggregate cost statement is available.
