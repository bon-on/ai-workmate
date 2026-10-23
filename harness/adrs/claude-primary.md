---
id: claude-primary
title: Claude Code as primary job engine with in-job Codex fallback
status: accepted
related_specs:
  - claude-primary
  - ai-usage-report
---
# Claude primary engine
## Context
The bridge was built around `codex exec` (sandbox flags, `-o` summary file, `~/.codex/history.jsonl` sessions, `account/rateLimits/read`). Claude Code offers `-p --output-format stream-json`, which reports the session id, final result, token usage and `rate_limit_event` messages (status allowed/allowed_warning/rejected, reset time, per-window utilization). Claude has no side-channel quota read that avoids a model turn.
## Decision
JobManager selects the provider per job and runs the fallback itself, so router, scheduler, briefing retry and dashboard callers share one policy. Claude limit knowledge comes only from job streams and is persisted; nothing is sent just to probe quota. Callers pass a model tier instead of a Codex model name. Non-admin Claude jobs use acceptEdits with Claude Code's Bash sandbox (no unsandboxed fallback), the closest match to Codex `workspace-write`.
## Alternatives
- Probe Claude quota before each job: costs a request and still races the real job.
- Fallback in the router: scheduled and retry paths would diverge.
- Translate Claude sessions to Codex on fallback: transcripts are not portable; a fresh Codex session is explicit instead.
- Keep Codex for scheduled briefings: rejected by the user's "Claude by default" requirement; tiers keep them cheap.
## Consequences
The first job after Claude exhausts its limit spends one rejected attempt before falling back. Utilization is only as fresh as the last Claude job. Fallback output may differ in style. Claude's sandbox semantics differ from Codex's in detail (file reads outside the workspace remain possible, as with Codex). n8n MCP needs separate Claude configuration.
