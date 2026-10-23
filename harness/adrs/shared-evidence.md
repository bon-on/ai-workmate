---
id: shared-evidence
title: Use harness-lab execution evidence alongside standalone verification
status: accepted
related_specs:
  - verification
  - lab-followup
  - repo-checks
---
# Shared evidence
## Context
The original lightweight manifest and checks.json format were incompatible with harness-lab.
## Decision
Use harness-lab schema version 1 via verify:harness for cross-project auditing. Preserve standalone npm run verify for compatibility. Runtime scheduling and Telegram delivery remain unchanged.
## Consequences
Shared verification requires the sibling harness-lab build. Hashes and command status verify association and execution, not factual accuracy or independent acceptance. Regenerate evidence after scoped code changes.
