---
id: verification
title: Regression evidence
related_specs:
  - verification
  - lab-followup
  - harness-adoption
  - claude-primary
  - repo-checks
  - ops-approval
  - ai-usage-report
evidence_files:
  - out/evidence/harness-latest/checks.json
---
# Regression evidence
## Goal
Record regression evidence using the shared harness-lab schema.
## Done Criteria
- Tests pass and source hashes match.
## Verification
- npm run verify:harness
## Evidence References
- out/evidence/harness-latest/checks.json
