---
name: multi-review
description: Run independent cross-model reviews over a target without modifying files.
argument-hint: <target and review request>
disable-model-invocation: true
---

Submit `$ARGUMENTS` to the local AutoDev command surface as a `multi-review` run. Treat the target as read-only. Require concrete evidence for findings, preserve reviewer identity, deduplicate overlapping findings, and report severity, file, line, blocking status, and failure scenario. Do not apply fixes.
