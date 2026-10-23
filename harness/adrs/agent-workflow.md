---
id: agent-workflow
title: Share policy and coordinate independent development tasks
status: accepted
related_specs:
  - harness-adoption
---
# Shared agent workflow
## Context
The existing AGENTS entry point covers verification only; CLAUDE has no entry point. This directory is not a Git checkout. Tests and the running personal assistant share a filesystem.
## Decision
Preserve AGENTS policies and add a common workflow discoverable by both agents. Analyze requirements first, assign independent work with explicit file ownership and constraints, and centralize integration and evidence generation. Use isolated source copies or reviewed patches when worktrees are unavailable. Keep agent operation capabilities optional and preserve existing application behavior.
## Alternatives
Duplicating full policy in both entry points creates drift. Requiring Git worktrees excludes this existing directory. Running all work in parallel creates conflicting edits and invalid evidence.
## Consequences
Agent compliance still needs observation; document presence does not prove it. One coordinator owns integrated verification. Maintenance reviews require actual review and checks. Runtime jobs and external delivery remain outside this adoption task.
## Amendments
- 2026-10-21: To receive harness-lab template updates, AGENTS.md, CLAUDE.md and harness/workflow.md are now identical to the harness-lab template and tracked through `harness-lab adopt`. The original AGENTS policies and the project-specific parts of the workflow (development safety, Git-less coordination, verification scope and wording limits) moved verbatim in meaning to project-owned `harness/project.md`, which the workflow and both entry points load. CLAUDE.md no longer imports AGENTS.md; it imports the workflow and project.md. Alternative considered: keeping the customized files, rejected because update could never refresh them. Backup of the previous files: ~/sources/_harness-backups/2026-10-21/ai-workmate-before-adopt.tgz.
