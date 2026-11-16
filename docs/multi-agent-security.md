# Multi-Agent Security

## Trust boundaries

The host application, not a model, owns repository selection, worktree creation, path checks, scheduling, approvals, commits, integration, and final validation. Claude and Codex are treated as potentially fallible code-producing workers. Structured output is validated and consequential effects are rechecked by host code.

Source, prompts, diffs, and test evidence supplied to a worker are transmitted to that worker's configured model provider. In particular, Codex delegation sends assigned repository content to OpenAI. Operators must establish that this transmission is legally and contractually permitted before enabling that backend.

## Credentials and logs

- Provider keys remain in the portable settings store, which is plaintext and must be protected as documented in the main README.
- The saved OpenAI key is passed as `CODEX_API_KEY` only in an individual Codex process environment.
- Codex is launched with `shell_environment_policy.exclude=["CODEX_API_KEY"]`, preventing model-generated child commands from inheriting it.
- Keys are never added to prompts, repository files, ledger records, events, or reports.
- Worker events, errors, and persistent values pass through recursive redaction.
- Codex uses `--ephemeral` and `--ignore-user-config` to avoid ambient session/config behavior.

## Filesystem isolation

Every writable package has a separately owned Git worktree outside the target repository. Concurrent packages with overlapping declared path scopes are not scheduled together.

Before a package commit, the host:

1. parses all changed paths, including both source and destination endpoints of renames;
2. rejects changes outside the package scope;
3. clears inherited staged entries;
4. stages only host-approved paths;
5. inspects the staged path list before committing.

Claude Agent SDK runs enable the SDK sandbox with `failIfUnavailable: true`, disable unsandboxed fallback and sandbox auto-approval, and restrict writes to the owned workspace. Each role receives only its exact built-in tool list; the SDK adds its harness-owned `StructuredOutput` tool when a JSON schema is configured. Read-only roles expose only `Read`, `Glob`, and `Grep`; the tester additionally receives `Bash`; implementer and fixer roles receive the scoped file and shell tools. These tools are selected with `tools`, not `allowedTools`, so selection does not auto-approve them before the host `canUseTool` callback. Direct file-tool requests are checked against canonical existing ancestors, rejecting symlink traversal outside the worktree. The SDK sandbox remains the primary boundary for shell redirection, wrappers, and interpreter-based writes that command-pattern matching alone cannot reliably classify.

Codex planner, tester, and reviewer roles use a read-only sandbox. Implementer and fixer roles use workspace-write in their owned worktree. Each writable invocation receives a private temporary `CODEX_HOME` containing AutoDev-owned exec-policy rules. The policy forbids Git, package-manager, shell-wrapper/interpreter, broad deletion, common network/publication, container, infrastructure, and deployment command families; setup failure blocks launch. The host therefore owns commits, gates, integration, and publication while Codex retains its built-in workspace file-edit mechanism. Policy state is removed only after the process has actually exited.

## Git safety

The worktree helper refuses `git reset`, `git clean`, `--force`, and `-f`. It never force-removes dirty worktrees. Integration requires an exact expected destination commit and a clean destination checkout. Package branches must still point to their approved commits.

All package merges are tried in a disposable integration worktree first. Only the completed staging branch is merged into the destination, preventing partial destination integration when a later package conflicts. Conflicts are aborted without automatic resolution and worktrees remain for diagnosis.

Existing user changes are not stashed, reset, cleaned, or overwritten. A dirty destination blocks integration.

## Approval boundary

Integration always pauses for explicit approval. Worker-requested critical actions are recorded but deliberately not executed by the generic manager. Application-owned executors would be required for any future support.

Explicit approval remains mandatory for:

- production deployment or production database changes;
- destructive database operations or deletion of important files/data;
- credential changes;
- untrusted software installation or new paid external services;
- substantial global-system changes;
- changes outside the approved project scope.

Approval to run AutoDev or transmit code to one provider does not approve these actions.

## Network boundary

Dashboard and adapters bind to loopback and use authenticated routes. The Claude sandbox is configured for filesystem isolation, but an explicit outbound network allowlist is not currently applied to worker Bash. Provider calls themselves require network access. Treat this as a known boundary: host approvals and tool restrictions block named critical actions, while the sandbox primarily protects filesystem scope.

## Remaining limitations

- Command regexes are defense in depth, not a complete shell parser; sandbox confinement is required.
- The USD limit exposed to workers is currently per invocation rather than an aggregate run-level budget.
- Destination approval uses a deterministic SHA-256 digest bound to the run, expected destination HEAD, validated staging commit, action, and ordered package commits. It is one-use, but approval-expiry metadata is not yet enforced and the digest is not an external digital signature.
- Ledger files are redacted but not encrypted. Their mutation lock is process-local, and atomic replacement does not currently include explicit file/parent-directory `fsync` durability.
- Codex command policy is deliberately conservative and verified for prohibited command families, but it is defense in depth around the CLI sandbox rather than an operating-system capability boundary.
- A malicious dependency test can execute code inside its sandbox/worktree; run only trusted repositories and review test commands.
