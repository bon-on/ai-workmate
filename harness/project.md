# Project instructions

Project-owned instructions for AI Workmate. They were moved here from `AGENTS.md` and `harness/workflow.md` so those files can stay identical to the harness-lab template and receive updates. Treat them as repo constraints.

## Safety during development
- `harness/rules/constraints.md` limits apply to all development verification, and workers inherit them. Additionally, do not restart services during development; production operations require separate authorization.
- Before restarting the service, check active jobs and preserve their completion and result persistence.
- Do not assume this directory is a Git checkout. Use reviewed patches or isolated source copies when worktrees are unavailable, and keep overlapping edits sequential.

## Requirements
- For verification changes, read `harness/manifest.json` and its referenced spec and rules.
- Do not use the verification spec as a substitute for a product feature spec. Record missing requirements before implementation.
- Link cross-cutting ADRs to the task spec.

## Verification
- Dashboard browser code is embedded in a template string: test the emitted browser JavaScript and observable dashboard/router behavior, not just the server template.
- Existing tests use mocked external clients and temporary fixtures. Review changed tests for side effects before running them.
- Run `node --test` for regression checks, then `harness-lab verify` with `harness/verify.json` to produce shared execution evidence; one coordinator regenerates evidence after integration and runs `check-evidence` and `audit`.
- `npm run verify` produces a standalone local regression evidence bundle. It does not send Telegram messages or run AI, and it is not the shared contract's evidence.
- Resolve the harness-lab CLI path explicitly if the sibling checkout (`../harness-lab`) does not exist.
- Missing critical requirements or invalid evidence block a completion claim.
- Do not equate briefing format scores or test counts with factual accuracy or browser acceptance. Never claim browser acceptance, factual accuracy, production delivery or independent review from regression counts or formatting scores.
