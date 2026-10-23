---
id: ops-approval
title: Bridge may restart its own launchd service after inline approval
status: accepted
related_specs:
  - ops-approval
---
# Operational approval from Telegram
## Context
Project rules require separate authorization for production operations and an idle job queue before restarts. Restarts were only possible from a terminal. The bridge already has an in-memory, user-bound, 15-minute ApprovalStore with inline buttons for AI jobs.
## Decision
Reuse ApprovalStore for a fixed allowlist of operational actions, currently only "restart this bridge" via `launchctl kickstart -k`. The action is defined in code, not by chat text; the active-job check runs at approval time; a marker file lets the restarted process confirm completion. Push requests are added to the AI-job approval pattern instead of a new mechanism.
## Alternatives
- Generic shell command approval: too broad; one mistaken tap runs arbitrary commands.
- Dashboard restart button: the dashboard is reachable over Tailscale without per-user identity, while Telegram approval is bound to an allowlisted user.
- Waiting for jobs to finish before restarting: hides a long delay behind an approval; refusing is explicit.
## Consequences
A tap restarts production, so every approval is still a separate authorization. Pending approvals are lost on restart (in-memory). Other services (trading, n8n) still need their own path.
