---
id: claude-primary
title: Run AI jobs on Claude Code with Codex fallback on rate limits
status: maintained
related_adrs:
  - claude-primary
related_contracts:
  - verification
---
# Claude primary, Codex fallback
## Problem
Every chat, delegated, approved and scheduled job runs `codex exec`. The user wants Claude Code as the main engine and Codex only when Claude's rate limit is insufficient.
## Scope
- Provider selection and fallback in JobManager; Claude CLI arguments and stream parsing.
- Persistent Claude limit state learned from `rate_limit_event` stream messages, plus a newer read-only statusline snapshot (`CLAUDE_RATE_LIMIT_SNAPSHOT`) because the account is shared with interactive Claude Code sessions.
- Provider-aware reply sessions, model tiers, status/dashboard limits and job headers.
## Acceptance Criteria
- New jobs run `claude -p --output-format stream-json` by default (`AI_PROVIDER=claude`); `AI_PROVIDER=codex` restores the previous behavior.
- Non-admin Claude jobs keep workspace-only writes: acceptEdits plus sandboxed Bash with unsandboxed commands disabled. Admin-approved jobs bypass permissions like Codex `--dangerously-bypass-approvals-and-sandbox`. Web tools are allowed only in explicit operations modes; scheduled AI briefings run in `brief` mode like the manual briefing commands, including their quality retry.
- A Claude attempt that ends with a rejected rate limit (or a usage-limit error result, or a failed Claude spawn) is retried once on Codex inside the same job; the result says so.
- After a rejection, jobs go straight to Codex until the reported reset (unknown reset: 1 hour). A window at or above `CLAUDE_FALLBACK_UTILIZATION` (default 0.95) also routes to Codex until that window resets. The state survives restart.
- Replies resume with the provider that created the session; legacy sessions are Codex. A Claude session that cannot run because of limits starts a new Codex session.
- Scheduled/briefing tiers map to `SCHEDULED_CLAUDE_MODEL`/`SCHEDULED_CLAUDE_EFFORT` on Claude and the existing Codex settings on fallback.
- `/n8n` stays on Codex unless `CLAUDE_MCP_CONFIG` provides MCP servers for Claude.
- Scheduled usage pause only triggers from the final failing attempt, so a Claude limit with a successful Codex fallback does not pause schedules.
- A usage pause does not skip the locally built morning and evening briefings; their once-per-day ledger still applies.
- `/status` and the dashboard show Claude limits next to Codex limits.
## Constraints
- No real Claude/Codex requests, service restarts or user-state edits during verification; tests use fake executables and temp state.
## Evidence
- test/claude-primary-gaps.test.js: brief mode and quality retry, usage pause only from the final failing attempt, /status Claude limits (fixes a ReferenceError in handleMessage), Codex fallback job header, 0.95 threshold and scheduled effort mapping. Settlement logic moved verbatim to src/job-settle.js for testing.
- test/scheduler.test.js: a usage pause still delivers the local evening briefing once while the AI trend brief stays paused.
- node --test
- npm run verify:harness
