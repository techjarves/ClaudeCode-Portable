# Multi-Agent Architecture

## Purpose

AutoDev coordinates Claude Code and OpenAI Codex through a persistent, bounded development lifecycle:

```text
PLAN → DELEGATE → IMPLEMENT → TEST → REVIEW → FIX → INTEGRATE → VALIDATE → REPORT
```

The host application owns scheduling, persistence, worktrees, approvals, integration, and final validation. Model output is structured input to those controls; it is not authority to bypass them.

## Components

- `lib/autodev/manager.mjs` implements the lifecycle, phase persistence, backend selection, reciprocal review, repair bounds, approvals, and truthful reports.
- `lib/autodev/registry.mjs` routes dashboard operations to one manager per canonical Git repository. Each repository has an independent ledger and worktree namespace.
- `lib/autodev/ledger.mjs` stores schema-versioned runs with atomic writes, recursive redaction, serialized mutations, and monotonically numbered events. Startup marks active persisted runs `interrupted`.
- `lib/autodev/scheduler.mjs` validates the dependency DAG and creates bounded waves that do not contain overlapping path scopes.
- `lib/autodev/worktrees.mjs` creates, verifies, adopts, commits, integrates, and removes application-owned Git worktrees without reset, clean, force merge, or force removal.
- `lib/autodev/runtime.mjs` validates canonical repository roots, wires workers, creates repository validators, and implements staged integration.
- `lib/autodev/claude-worker.mjs` invokes the official Claude Agent SDK with programmatic roles, structured output, host permissions, cancellation, and fail-closed sandboxing.
- `lib/autodev/codex-worker.mjs` invokes official noninteractive `codex exec` with JSONL events, a JSON schema, explicit CWD and sandbox, bounded output/time, ephemeral process state, and a private fail-closed command policy for write roles.
- `dashboard/server.mjs` exposes authenticated create, paginated list, status, bounded event, approval, cancellation, and resume routes, with optional-AutoDev degradation and a global active-run cap.

## Run and work-package state

A run records its mode, request, canonical target, preferred backend, current phase/status, immutable limits, work packages, checks, reviews, repairs, approvals, artifacts, quality state, report, and event history.

Every planned work package contains:

- a stable ID, title, and description;
- explicit allowed paths;
- dependency IDs;
- acceptance criteria and required gates;
- an assigned backend;
- lifecycle status;
- owned workspace metadata and the accepted commit;
- structured worker result and evidence.

Writable packages without an explicit path scope are rejected. Workspace metadata is checkpointed immediately after preparation so an interrupted run can reconcile its owned worktree.

## Scheduling and delegation

The manager validates the package DAG and computes scheduling waves. A wave is capped at three packages by default and cannot contain packages whose declared paths overlap. Dependencies must be completed before a dependent package starts. Each writable package receives a separate Git branch and worktree outside the source repository.

Claude roles are planner, implementer, tester, reviewer, and fixer. The selected role runs on the SDK main thread so schema output retains the SDK-owned `StructuredOutput` tool, while the `tools` option exposes only that role's exact built-ins and leaves `canUseTool` authoritative. Codex receives the corresponding structured role prompt. Planner, tester, and reviewer Codex invocations use `read-only`; implementer and fixer use `workspace-write`.

## Reciprocal review and repair

A package cannot be reviewed only by its producing backend. Claude output is reviewed by Codex; Codex output is reviewed by Claude. Required test failures and blocking review findings form the quality gate. Failed gates are sent back to the owning backend, bounded to three repair attempts by default. Every repair is finalized into the package branch before tests and reviews run again. Review rounds are bounded to two by default.

Worker tester claims are advisory only. The host validator executes every package gate in its owned worktree and records observed evidence; a missing or failed host result blocks integration. A successful report additionally requires validation of the exact staged integration commit and final application-level evidence.

## Integration model

Before integration, the manager prepares an owned staging commit and validates that exact commit. It then requests explicit approval whose SHA-256 digest binds the run ID, integration action, expected destination HEAD, staging commit, and ordered package IDs/commits. Integration then:

1. checks that every package branch still resolves to the approved package commit;
2. creates an owned staging worktree from the exact destination HEAD;
3. merges all package branches into that staging worktree in dependency order;
4. stops without changing the destination if any staging merge conflicts;
5. runs the full repository validator against the exact staging commit;
6. persists a write-ahead integration intent;
7. recomputes the approval digest and verifies that the destination HEAD and status are unchanged and clean;
8. performs one destination merge from the validated staging branch;
9. persists `integrated: true` and the resulting destination HEAD before cleanup;
10. removes clean owned worktrees and runs an additional destination validation.

On restart, the host reconciles the persisted intent against Git and recognizes an already-applied staging commit without merging twice. Destination divergence blocks rather than merging blindly. This prevents a later package conflict or crash from producing partial or falsely recorded integration.

## Recovery

Ledger recovery changes active runs to `interrupted`. The dashboard exposes Resume. A worktree may be adopted only if its ownership record matches the run and task, Git still registers the expected path, and the expected branch is checked out. Unowned paths, missing registrations, and mismatched ownership fail closed.

Resume is phase-safe rather than side-effect-free: completed packages are not implemented again, but quality checks and reviews may run again before integration. This favors fresh evidence over silently trusting pre-interruption claims.

## Limits

Defaults are three concurrent packages, two review rounds, three repairs, twenty packages, twenty-four turns per worker invocation, a fifteen-minute invocation timeout, and a per-invocation USD ceiling where the backend supports it. There is no recursive agent spawning in the host lifecycle.
