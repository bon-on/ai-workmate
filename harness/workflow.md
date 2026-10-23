# Agent Instructions

Follow this repository-local workflow for substantive work. The `harness-apply` skill is optional.

Startup sequence:
1. Read `harness/manifest.json`.
2. Select the feature spec in `harness/specs/` whose Scope covers the request, and read specs it also touches as secondary. Specs move `draft` -> `active` (under development) -> `maintained` (implemented regression baseline); `active` and `maintained` specs are both selectable. If no spec fits, write one from `harness/templates/feature-spec.md` before changing code; if several fit equally, ask the user. State which spec you selected.
3. Read `approvedPacks` from the manifest. If it is empty, treat `suggestedPacks` as recommendations only.
4. Read linked ADRs and contracts before making code changes.
5. Read `harness/rules/constraints.md`, `harness/rules/golden-rules.md` and `harness/project.md`. `harness/project.md` holds project-specific instructions; treat them as repo constraints.
6. Map the user request to acceptance criteria and project-specific verification commands. Run checks before claiming completion; record argv, exit status and evidence. Static audit or mock scores do not prove execution.
7. Record architectural or cross-cutting changes in an ADR, including alternatives and consequences.
8. Review `harness/maintenance.json` every 30 days and after repeated failures or stack changes. Remove duplicate guidance, check stale ADRs and unused packs, compare instruction size, and add a regression check for recurring failures. Preserve decision history. Record reviewedAt and a nonempty summary only after review and verification.

Development routing:
- For implementation requests, use the available `harness-develop` skill or follow the same core workflow: map requirements to checks, assign independent tasks with exclusive file ownership and explicit dependencies, then integrate and verify as coordinator. State why when using a single-agent fallback.
- Before claiming implementation complete, obtain an independent read-only review: the `code-reviewer` agent in Claude, or a separate agent following the `harness-review` skill elsewhere. Fix and re-review Critical and High findings, or justify them in the report. State why when review is skipped for a trivial change.
- Use the host's available agent tools. Do not assume Git worktrees or a particular orchestration service exists.

Response contract:
- Include `References used`, `Constraints`, `Conflicts or gaps`, and `Escalation`.
- Escalate when required harness artifacts are missing or conflicting.
- State which approved or suggested profile packs were used.
