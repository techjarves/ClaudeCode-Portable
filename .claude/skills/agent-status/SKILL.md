---
name: agent-status
description: Show persisted AutoDev run, package, phase, approval, and terminal status without invoking a model.
disable-model-invocation: true
---

Read status from the local AutoDev ledger/API only. Do not invoke an LLM or start a worker. Summarize active and latest runs, package completion, current phase, pending scoped approvals, failures, and resumable interrupted runs.
