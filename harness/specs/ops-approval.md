---
id: ops-approval
title: Approve operational actions from Telegram inline buttons
status: active
related_adrs:
  - ops-approval
related_contracts:
  - verification
---
# Operational approval
## Problem
Restarting the bridge needs a terminal, and repository pushes requested in chat were not treated as external actions, so the harness "Escalation" step cannot be completed from a phone.
## Scope
- `/restart` requests an inline-approved restart of the bridge's own launchd service (`AI_WORKMATE_LAUNCHD_LABEL`).
- `git push`/push-to-remote requests in chat go through the existing AI-job approval.
- Out of scope: arbitrary shell commands, restarting other projects' services, dashboard-triggered restarts.
## Acceptance Criteria
- `/restart` replies with the active job count and approve/cancel buttons; only the requesting user in the same chat can approve, within the existing 15-minute expiry.
- Approval re-checks active jobs and refuses while any job is queued or running; nothing is restarted.
- On approval the callback is answered and a notice is sent before `launchctl kickstart -k gui/<uid>/<label>` runs; a restart marker makes the new process report completion once to that chat.
- Without a configured label the command explains the setting and does nothing.
- `/restart` is not reachable from the dashboard command endpoint.
- Chat requests containing `git push` or push/upload to GitHub/remote require approval.
## Constraints
- Tests stub the command runner; no service is restarted during verification.
## Evidence
- test/ops-approval.test.js: request, active-job refusal at approval time, foreign user rejection, runner invocation order, restart notice, missing label, dashboard rejection, push approval pattern.
- npm run verify:harness
