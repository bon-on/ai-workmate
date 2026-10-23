# Scheduled Codex usage guard (2026-09-28)

## Incident and reproduction

On September 24, local ai-workmate sessions included 68 runs around noon,
including 33 quality-correction prompts. The weekly usage indicator reached
100% at 13:43 KST, before trading's 20:05 review.

The scheduler ran every 30 seconds without excluding an overlapping tick.
While a slow context collector was awaiting Calendar/weather, another tick
could capture the same due entry. After the first tick launched a job and
advanced the entry to tomorrow, the second tick's rejected job start called
`delay()`, overwriting tomorrow's reservation with now + 1 minute.
A mock-only reproduction returns next-run offsets of 1 minute before the fix
and 1,440 minutes after it. No Codex request is needed for this reproduction.

## Safeguards

- One tick at a time per ScheduleStore. Busy jobs do not rewrite due times.
- Briefing occurrences advance durably before slow preparation/startup.
- Persistent KST-date/chat/briefing-kind ledger: one original plus at most one
  correction each day, including across process restarts and duplicate IDs.
- Briefing execution failures keep the next normal occurrence, not a generic
  ten-minute retry. Generic user schedules retain their existing failure policy.
- A usage-limit failure from the bridge pauses all its scheduled Codex jobs
  until the CLI's reported reset (+1 minute). Unknown reset: 24-hour cooldown.
  The pause survives restart; no test request is sent to check quota.
- Harmless Markdown headings, bold, and links are normalized locally, retaining
  link targets, before deciding whether regeneration is needed.
- AI-trend news prompts no longer collect unrelated calendar/weather/inbox or
  personal recommendation history. Morning/evening context remains unchanged.
- Serialized atomic state writes protect the budget and pause state.

The dashboard API exposes `pool.schedules.usagePaused` and `usagePausedUntil`.
Explicit interactive jobs are not disabled by the scheduled-work circuit breaker.
This is an execution-count guard, not a guarantee of account-wide token savings;
individual news research can still use substantial tokens.

## Operational tradeoffs

One bridge process owns this state; multiple independent writers are not
supported. A crash or failed preparation after reservation can skip that day's
briefing rather than spend tokens again. The next regular occurrence is kept.
If quota reset text cannot be parsed, scheduled work waits 24 hours. All existing
schedule entries are preserved during deployment; no messages or Codex jobs are
triggered as a deployment test.

## Validation

Run `npm test`. Tests use mock jobs/local temp state, covering overlapping ticks,
busy jobs, preparation errors, duplicate entries, restart persistence, concurrent
reservations, failure policy, quota reset/fallback, formatting, and news context.
