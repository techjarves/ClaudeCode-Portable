---
name: auto-dev
description: Plan, implement, test, independently review, repair, and validate a bounded coding request through AutoDev.
argument-hint: <request>
disable-model-invocation: true
---

Submit `$ARGUMENTS` to the local AutoDev command surface as an `auto-dev` run. Keep package paths and acceptance criteria explicit. Follow persisted run events. Stop at scoped approval gates; never merge, push, deploy, publish, or execute another critical action without the matching run approval. Report final package, test, review, and validation evidence.
