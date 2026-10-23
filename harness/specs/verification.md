---
id: verification
title: Verification evidence
status: maintained
related_adrs:
  - shared-evidence
related_contracts:
  - verification
---
# Verification evidence

## Problem

Produce reproducible evidence without running paid AI or sending messages.

## Acceptance Criteria
- `npm run verify` runs the existing Node test suite and saves actual output and exit code in a unique directory under out/evidence.
- Record SHA-256 hashes of src, test, scripts, harness and package.json before and after verification; flag changes during verification.
- A failed test process produces failed evidence and a nonzero command exit.
- Records explicitly distinguish regression tests from browser interaction, factual accuracy and independent review, which are not verified by this command.
- Dashboard briefing score is labelled as a format check, not factual quality.

No profile packs required. Shared evidence follows the linked ADR.

## Scope
- Local test evidence and dashboard format-score labelling.
## Constraints
- Preserve user state and avoid model calls during verification.
## Evidence
- test/verify-script.test.js: npm run verify evidence directory, hashes, change detection, failure exit and not-verified list on temporary fixtures.
- test/dashboard.test.js: text and browser dashboard label the briefing score as a format check.
- npm run verify
