---
id: daily-ux
title: Daily use improvements for Telegram, dashboard and operational alerts
status: active
related_adrs:
  - claude-primary
related_contracts:
  - verification
---
# Daily UX

## Problem
A fresh-eyes review (2026-10-25) found that failures and pauses are invisible, alerts repeat without saying what to do, dashboard requests bypass job settlement, Telegram replies read like developer logs, and simple notes spend AI usage. The owner wants all of it addressed.

## Scope
Grouped by owner area. Shared labels live in `src/schedule-names.js` (`scheduleName`, `scheduleRepeatLabel`, `formatKst`, `formatKstClock`).

### Ops and data (scheduler, stores, monitor, local briefings)
- O1 Usage pause: an unparseable reset pauses AI schedules for 6 hours instead of 24. The pause stores its reason. `schedules.getUsagePause()` returns `{ until, reason, provider, chatId, scheduleName, canReleaseEarly } | null` (the last four are null/false for pauses without O10 metadata); `schedules.clearUsagePause()` lifts it. When a new pause begins, the chat gets one Korean notice with the end time (KST), the reason, that local briefings and English study continue, and `/resume` to lift it.
- O2 Schedule failure alert names the schedule (`scheduleName`), summarizes `lastError`, says what to do (`/runnow <id>`), and is sent once per failure episode of each schedule (`failingSince`, set on the first failure and cleared on success). More failures in the same episode, other schedules failing, or a restart do not repeat it.
- O3 Schedule actions: `schedules.runNow(id, { chatId, now })` makes an entry due now; `schedules.skipNext(id, { chatId, now })` advances it one occurrence. Both return the entry or null when the id is unknown for that chat.
- O4 Late local briefing: a morning/evening briefing built more than 10 minutes after its scheduled time starts with `⏰ 지연 발송 (원래 HH:MM)`.
- O5 n8n failures: the operational monitor sends at most one daily summary of failed n8n executions for active workflows (names and counts).
- O6 Inbox: entries accept an optional `dueAt`. Briefings show how many days an open item has waited (`N일째`) and the due date. The morning focus picks overdue/due-soon first, then the oldest, instead of always the first entry. The local briefing's focus item carries inline buttons `inbox:done:<id>` and `inbox:later:<id>`; `runLocalBriefing` may return `{ summary, replyMarkup }` and the local job carries `replyMarkup`.
- O7 Settlement: `job.deliverToTelegram === false` skips the Telegram result message (and reply-session) but still records metrics and schedule results.
- O8 Briefing health: `summarizeBriefingHealth` reports late deliveries, recommendation feedback count/rate and failed local builds for the last 14 days, replacing the format-score summary on the dashboard.
- O9 External watchdog: `scripts/watchdog.js` checks the dashboard health endpoint and, after two consecutive failures, sends one Telegram notice through the existing send script; it notifies once more on recovery. It keeps its own small state file and runs from a launchd interval job documented in README.
- O10 Usage pause follows the limit reset. When a job hits a usage limit, the pause ends at the provider's reset time: for Codex the latest `resetsAt` of windows at 100% from the account rate-limit read (no model turn), for Claude the rate-limit event's reset, then the CLI message's retry time, else 6 hours. While paused, the schedule tick re-reads Codex limits at most every 15 minutes; when no window is exhausted the pause ends early. When the pause ends (early or at its end time) the chat gets one Korean resume notice. Early release is disabled for a pause whose limits did not show exhaustion when it began, or that began within 2 hours of an early release, so a limit the read cannot see does not loop.
- O12 Briefing context reports past failures: run metrics keep `scheduleId` and the first line of the error for failed runs, and `personal.recentRunIssues` lists failed or late runs of the last 7 days. The schedule list exposes `currentFailureStreak` instead of `failures`, so a report does not read a reset streak as "no failures this week".
- O11 A usage-limit failure is not a schedule failure: it neither increments `failureCount` nor triggers the O2 alert or disabling. The O1 pause notice is the single message and names the affected schedule.

### Telegram (router, formatting, watch alerts)
- T1 Result messages carry a one-line footer (provider · duration · `/job <id>`) instead of the Job/Session/Mode/Workspace header; accepted, busy, `/status`, `/jobs`, `/cancel` and schedule replies are Korean.
- T2 `/schedules` lists `scheduleName`, `scheduleRepeatLabel`, next run in KST and the cancel command, not raw prompts or UTC.
- T3 `/help` is a short Korean overview by category; `/help <topic>` gives details. The bot registers its command menu with `setMyCommands` at startup.
- T4 Text starting with `할일:`, `할 일:`, `메모:`, `아이디어:` or `읽기:` is saved to the inbox without AI. A trailing `오늘`, `내일`, `M/D` or `M월 D일` sets `dueAt`.
- T5 A request sent while a job runs offers a button to run it in the background (delegate) instead of only rejecting it.
- T6 `/resume`, `/runnow <id>` and `/skip <id>` call the O1/O3 store methods. Callback handlers for `inbox:done:<id>` and `inbox:later:<id>` (24h snooze) update the inbox and answer the callback.
- T7 Result messages honor `job.replyMarkup` on the last chunk.
- T8 Web watch alerts include a short excerpt of what changed.

### Dashboard
- D1 Requests from the dashboard are settled through the bridge's `settleJob` (metrics, sessions, Telegram delivery unless the request unchecks "텔레그램으로도 받기"). The full result is viewable in the dashboard after refresh and restart.
- D2 The Today view shows a status line when AI schedules are paused (until, reason, lift button) or a schedule is failing (name, reason, run-now button).
- D3 Schedule rows show the Korean repeat label (including weekdays) and offer run now, skip once and delete. `/api/schedule-action` accepts `{ id, action: "run" | "skip" | "remove" }` and `/api/usage-pause` (DELETE semantics via POST `{ action: "clear" }`).
- D4 Briefing cards expand to the full text, offer 👍/👎 per briefing (stored through `setBriefingFeedback`) and "다시 보내기" to Telegram.
- D5 Inbox rows offer 미루기 (snooze 24h) and show due date / days waiting.
- D6 Korean labels throughout; unconfigured checks (photo backup) are hidden; repository checks older than 24 hours are marked stale with a 재점검 action.
- D7 Requests through a `*.ts.net` host must carry a `Tailscale-User-Login` listed in `DASHBOARD_TAILNET_USERS` when that variable is set; when unset, the settings view warns that any tailnet device can run commands.

### Out of scope
Changing briefing times from the dashboard (still `.env`), Telegram briefing feedback buttons (removed earlier on purpose), multi-item job queues.

## Acceptance Criteria
- Every item above has a regression test with mocked Telegram/AI/fetch, or is listed in the report with the reason it has none (O9 launchd install).
- No Telegram send, paid AI call or live state edit during verification; `src/index.js` is only checked with `node --check`.
- Dashboard browser code is tested through the emitted JavaScript (no backticks or `${` inside the template).
- Existing behavior covered by the 244 current tests keeps passing.

## Constraints
- Zero runtime dependencies stays true.
- Callback data stays under Telegram's 64-byte limit.

## Evidence
- node --test
- npm run verify:harness
