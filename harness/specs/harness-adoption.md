---
id: harness-adoption
title: Shared agent workflow and coordinated development
status: maintained
related_adrs:
  - agent-workflow
related_contracts:
  - verification
---
# Shared agent workflow
## Problem
Claude lacks a repository entry point and development outside verification can miss the harness. Maintenance and agent coordination are implicit.
## Scope
Repository-local development guidance and verification scope only. Runtime scheduling, delivery, AI job behavior and user state remain unchanged.
## Acceptance Criteria
- Preserve existing AGENTS instructions (kept in project-owned harness/project.md since 2026-10-21); both agent entry points discover one shared workflow and project.md.
- Tool-managed files (AGENTS.md, CLAUDE.md, harness/workflow.md, templates, code-reviewer agent) stay identical to the harness-lab template and are tracked by `harness-lab adopt`, so `update` can refresh them.
- Require task-specific requirements, ADRs, contracts and constraints before implementation.
- Split independent work with explicit ownership and dependencies; integrate overlapping changes sequentially and verify the integrated result.
- Do not assume Git worktrees exist; use reviewed patches or isolated copies when unavailable.
- Shared evidence covers both agent entry points and harness artifacts; audit rejects stale evidence.
- lab-followup links the existing regression contract and its evidence ADR references it.
- Maintenance records an actual completed review, including instruction simplification and verification results.
## Constraints
No runtime changes, messages, paid AI, service restarts or personal-state edits. No packs approved by this task.
## Evidence
- node --test
- harness-lab verify using harness/verify.json followed by check-evidence and audit
