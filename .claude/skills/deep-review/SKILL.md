---
name: deep-review
description: Run an intensive read-only cross-model review with repeated independent passes.
argument-hint: <target and review focus>
disable-model-invocation: true
---

Submit `$ARGUMENTS` to the local AutoDev command surface as a `deep-review` run. Keep the target read-only. Use at least two independent review passes, verify findings against code and tests, and report only surviving findings with concrete failure scenarios. Do not edit files or claim unverified defects.
