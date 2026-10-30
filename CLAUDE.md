# Repository instructions

- AutoDev commands are `/auto-dev <request>`, `/multi-review <request>`, `/deep-review <request>`, and `/agent-status`.
- `/agent-status` is ledger-only and must never invoke a model.
- AutoDev work is package-scoped. Do not merge, push, deploy, publish, broadly delete, or perform another critical action without the matching persisted approval.
- Report checks and review findings from observed evidence only. Never infer that an unrun gate passed.
- Dashboard command dispatch is explicit; ordinary chat and unknown slash-prefixed messages must remain on the normal chat path.
