---
id: repo-checks
title: Nightly harness drift and publish-readiness checks for local repositories
status: active
related_adrs:
  - shared-evidence
related_contracts:
  - verification
---
# Repository checks
## Problem
Harness drift (audit warnings, evidence that no longer matches the code, overdue maintenance reviews) and publish blockers (secrets, `.env`, personal paths, missing README/LICENSE/.gitignore) across `~/sources` are only found when someone runs the CLI by hand. The user plans to publish these projects on GitHub.
## Scope
- Discover repositories directly under `REPO_CHECK_ROOT` (default: parent of this workspace); skip names starting with `_` or `.`.
- Harness repos (`harness/manifest.json`): `harness-lab audit --format json`, `check-evidence` on the newest `checks.json` under the manifest `reportsDir`, maintenance review age.
- Every repo: publish-readiness scan of the files Git would commit (tracked plus untracked-not-ignored; non-Git directories use a temporary external Git dir so `.gitignore` is honored without touching the repo).
- Daily automatic run once per Seoul day after `REPO_CHECK_HOUR` (default 07), `/repos` and `/publish-check <repo>` Telegram commands, a System-tab card with a run button, and a morning-briefing section.
- Out of scope: running other repositories' test suites (`verify`), fixing findings, committing or pushing.
## Acceptance Criteria
- Checks are read-only for the scanned repositories: only `audit`, `check-evidence` and file reads run; no repo files are created or changed.
- Audit warnings/critical findings, invalid or missing evidence and maintenance reviews older than 30 days are reported per repo with their codes.
- Publish blockers: private keys, known token formats (Anthropic, OpenAI, GitHub, AWS, Slack, Telegram bot), quoted secret assignments, and committable `.env` files (`.env.example`/`.env.sample` allowed). Warnings: the home directory path, extra private terms from `PUBLISH_CHECK_PRIVATE_TERMS`, files over 5 MB. Missing README, LICENSE or `.gitignore` are listed.
- Reports name rule, file and line only; matched secret text is never stored, logged or sent.
- The latest result persists across restarts. The morning briefing shows only issues not shown in an earlier morning briefing (new, or changed text such as a different count; the growing day count of an overdue maintenance review is not a change), one line per repo with its first new issue and "외 N건" for its other new issues, at most three repos plus a "외 N개 저장소" line, and one "해결됨" line per repo whose briefed issues are all gone; nothing when no run exists or nothing changed. Briefed issues per repo persist in personal-ops state, shared by all chats (single-user bridge), and are recorded when any morning briefing, including a manual `/morning`, is built (a failed send drops them from later briefings; `/repos` and the dashboard still list every issue; a failed state save is logged and the briefing still goes out). A result older than two days adds a stale line and leaves the briefed state unchanged. The weekly report keeps the full current list.
- A missing harness-lab CLI or a failing command is reported as that repo's check error, not as a clean result.
## Constraints
- No AI calls; external commands have timeouts; scanning skips dependency/build directories, binary files and files over 1 MB.
## Evidence
- test/repo-checks.test.js: discovery, audit/evidence parsing with a stubbed CLI, publish rules and masking, non-Git ignore handling, daily gating, briefing lines and morning delta (new, changed, resolved, stale, persisted briefed state), command output.
- npm run verify:harness
