---
id: ai-usage-report
title: Weekly AI job usage, fallback and failure report
status: active
related_adrs:
  - claude-primary
related_contracts:
  - verification
---
# AI usage report
## Problem
Run metrics already record provider, status, tokens and fallback reason, but nobody sees how often Codex fallback, failures or briefing quality retries happen, so harness or prompt changes cannot be judged.
## Scope
- A deterministic report over stored run metrics: jobs by engine, failures, Codex fallbacks with reasons, tokens, briefing quality retries, heaviest jobs, plus the current Claude 5h/7d utilization.
- `/ai-usage [days]` command; the weekly review appends the 7-day report after the AI-written part; the dashboard quality card shows fallback and failure counts.
## Acceptance Criteria
- Counts come from stored metrics only (no AI call); the weekly review numbers are appended by code, not written by the model.
- Quality retries are recorded on the run metric (`briefingRetry`) so they survive restarts.
- Report text is at most ~12 lines and states that it measures volume, not result quality.
## Constraints
- Keep the 1,000-metric retention; older metrics without new fields count as zero.
## Evidence
- test/ai-usage-report.test.js: aggregation, fallback reasons, retry counting, weekly append, command output.
- npm run verify:harness
