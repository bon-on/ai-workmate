# AI Workmate

A privacy-first personal operations service for an always-on Mac mini. It combines Telegram capture and control, local morning/evening briefings, scheduled research, Apple Calendar, weather, trading dry-run summaries, and a local dashboard.

## Requirements

- Node 20+
- `codex` CLI installed and authenticated
- Telegram bot token from BotFather

## Configuration

Copy `.env.example` to `.env` or export the variables in your shell:

- `TELEGRAM_BOT_TOKEN`: Bot token
- `ALLOWED_CHAT_IDS`: Comma-separated whitelist of Telegram chat IDs
- `ALLOWED_USER_IDS`: Optional comma-separated whitelist of Telegram user IDs
- `CODEX_WORKSPACE`: Fixed workspace directory passed to `codex exec -C`
- `ALLOWED_WORKSPACES`: Optional comma-separated `alias=/abs/path` list for chat-selectable workspaces
- `CODEX_MODEL`: Optional model override
- `CODEX_PROFILE`: Optional Codex profile
- `SCHEDULED_CODEX_MODEL`: Lower-cost model for AI trend and weekly scheduled jobs (default: `gpt-5.6-luna`)
- `SCHEDULED_CODEX_REASONING_EFFORT`: Reasoning effort for those jobs (default: `none`)
- `SESSION_STATE_PATH`: Optional path for persisted reply-to-session mappings
- `MEMORY_STATE_PATH`: Optional path for persisted chat/workspace memories
- `SCHEDULE_STATE_PATH`: Optional path for persisted scheduled Codex jobs
- `PERSONAL_OPS_STATE_PATH`: Optional path for inbox and web-watch state
- `CODEX_BIN`: Absolute path to the Codex CLI when it is not available in the service PATH
- `EXTERNAL_STORAGE_PATH`: Optional mounted external SSD path shown by `/health` and used for backups
- `PHOTO_BACKUP_PATH`: Optional original-photo destination monitored for availability and freshness
- `OPERATIONAL_MONITORING_ENABLED`: Send anomaly-only alerts for missing briefings, storage and failed schedules (default: `true`)
- `OLLAMA_PORT`: Local Ollama API port (default: 11434)
- `LOCAL_BRIEFING_MODEL`: Ollama model for morning/evening recommendations (default: `qwen3.5:latest`)
- `JOB_TIMEOUT_MS`: Optional job timeout in milliseconds
- `MAX_LOG_BYTES`: Optional maximum bytes retained in memory for chat-visible excerpts
- `POLL_TIMEOUT_SECONDS`: Optional Telegram long-poll timeout
- `TELEGRAM_REQUEST_TIMEOUT_MS`: Optional Telegram HTTP request timeout in milliseconds
- `POLL_RETRY_MIN_MS`: Optional minimum retry delay after polling failures
- `POLL_RETRY_MAX_MS`: Optional maximum retry delay after polling failures
- `POLL_RESTART_FAILURE_THRESHOLD`: Failures within the recovery window before restarting (default: 6)
- `POLL_RESTART_WINDOW_MS`: Rolling polling-failure window in milliseconds (default: 300000)
- `MAX_DELEGATE_JOBS_PER_CHAT`: Optional concurrent delegated job limit per chat
- `MAX_DELEGATE_JOBS_TOTAL`: Optional global concurrent delegated job limit
- `SCHEDULE_MAX_FAILURES`: Optional recurring schedule failure limit before disabling
- `DASHBOARD_ENABLED`: Set to `false` to disable the local dashboard
- `DASHBOARD_HOST`: Dashboard bind address (default: `127.0.0.1`; use Tailscale Serve for private remote access)
- `TELEGRAM_UNRESTRICTED_ENABLED`: Allow explicitly approved `/admin` jobs (default: `true`)
- `DASHBOARD_PORT`: Local dashboard port (default: 8766)
- `TRADING_DASHBOARD_PORT`: Trading dashboard port shown in the hub (default: 8000)
- `N8N_PORT`: n8n port shown in the hub (default: 5678)
- `DENY_MODE`: `reply` or `silent`

At least one of `ALLOWED_CHAT_IDS` or `ALLOWED_USER_IDS` must be configured.

## Run

Shared harness verification (requires the sibling `../harness-lab` checkout built with `npm run build`):

```bash
npm run verify:harness
npm run audit:harness
```

This writes shared-schema evidence to `out/evidence/harness-latest`. The original `npm run verify` still produces standalone local records; those legacy records are not the shared harness schema. Evidence is regression output, not independent review or factual accuracy certification.

```bash
npm start
```

For unattended use, run the restart supervisor instead:

```bash
npm run start:daemon
npm run status:daemon
npm run stop:daemon
```

Supervisor logs are written to `~/.codex/ai-workmate/telegram-codex-bridge.log`. This manual supervisor is separate from launchd and should not be started when the LaunchAgent is installed.

To start the bridge and dashboard automatically after macOS login (including after a reboot),
install its LaunchAgent once:

```bash
npm run install:startup
```

The LaunchAgent runs Node directly with `RunAtLoad` and `KeepAlive`, so only launchd owns process restarts. Telegram network failures use in-process backoff and do not stop local schedules or the dashboard. Runtime logs larger than 10 MB are trimmed automatically.

Manage local n8n through the timezone-safe service script so every start uses both `TZ` and
`GENERIC_TIMEZONE` set to `Asia/Seoul`:

```bash
./start-n8n.sh start
./start-n8n.sh restart
./start-n8n.sh stop
```

The local dashboard is available at `http://127.0.0.1:8766/` while the bridge is running.
Markdown and text documents (AI lab reports, research notes) open in a built-in viewer, so they can be read on a phone without downloading. Every completed AI lab result is kept as a Markdown report; if a job does not write one, its result summary is saved under `documents/reports/`.
For private phone access, keep it bound to localhost and publish it only to your tailnet:

```bash
tailscale serve --bg http://127.0.0.1:8766
```

## Personal Data Kept Out of Git

Personal state stays local and is ignored by `.gitignore`: `.env`, `data/` (copy
`data/portfolio.example.json` to `data/portfolio.json` for the dashboard portfolio),
`documents/` (except its README), `out/`, `tmp/`, `backups/`, `models/`, the English lesson source
`english-study-weekday-hourly.md` (start from `english-study.example.md`), and machine-specific `deploy/` files. The n8n workflow
sources use `YOUR_TELEGRAM_BOT_TOKEN` and `YOUR_TELEGRAM_CHAT_ID`; replace them (or use an n8n
credential) before importing. `/tr` expects a sibling `../trading` checkout unless
`TRADING_WORKSPACE_PATH` is set.

## First Telegram Setup

1. Put your bot token in `.env` as `TELEGRAM_BOT_TOKEN`.
2. Set `CODEX_WORKSPACE=/path/to/ai-workmate`.
3. Message the bot once in Telegram so an update exists.
4. Check whether another tool already registered a webhook:

```bash
npm run telegram:webhook
```

5. If a webhook URL is present, remove it before using long polling:

```bash
npm run telegram:webhook:delete
```

6. Fetch recent updates and read your private `chat.id`:

```bash
npm run telegram:updates
```

7. Put that value into `ALLOWED_CHAT_IDS` in `.env`.
8. Start the bridge with `npm start`.

Helper commands:

```bash
npm run telegram:me
npm run english-study:build
npm run telegram:send -- --text "test message"
npm run telegram:webhook
npm run telegram:webhook:delete
npm run telegram:updates
```

## Bot Behavior

- Plain text message: enqueue a sandboxed Codex job from the message text
- `/admin <request>`: request an explicitly approved system-wide Codex job
- `/capabilities`: show what the bridge allows and blocks
- `/dashboard` or `/ai-workmate:dashboard`: show active work, delegate pool capacity, managed processes, schedules, and recent jobs
- `/status`: show current job status for the chat
- `/jobs`: list recent jobs for the chat
- `/job <jobId>`: show job details
- `/job-logs <jobId>`: show recent Codex job logs
- `/cancel`: cancel the active job for the chat
- `/new` or `/reset`: clear saved reply-based Codex sessions for the chat
- `/remember <text>`: save a memory for the active workspace
- `/preference add <like|avoid> <text>`: save a briefing recommendation preference
- `/memories`: list memories for the active workspace
- `/forget <id>`: delete a saved memory for this chat
- `/schedule in 10m <prompt>`: run a one-time scheduled Codex job
- `/schedule every 1h <prompt>`: run a recurring scheduled Codex job
- `/schedule 매일 9시 <prompt>`: run a daily scheduled Codex job
- `/schedule 평일 9시 <prompt>`: run a weekday scheduled Codex job
- Natural Korean scheduling: `10분 후에 알려줘`, `내일 오후 3시에 부모님께 전화하라고 알려줘`, `평일 오전 9시에 일정 확인하라고 알려줘`, `매주 월요일 오전 8시에 목표 알려줘`, `매일 오후 2시에 AI 뉴스 스크랩해서 알려줘`
- `/schedules`: list scheduled jobs for the chat
- `/unschedule <id>`: delete a scheduled job
- `/delegate <prompt>`: start an isolated concurrent Codex job
- `/delegates`: list delegated jobs for the chat
- `/delegate-cancel <jobId>`: cancel a delegated job
- `/tools`: list available bridge tools
- `/health`: check AI Workmate, n8n, Trading, Ollama, and external storage
- `/repos`: run read-only harness and publish-readiness checks on the repositories next to this checkout
- `/publish-check <repo>`: list publish blockers and warnings for one repository (rule, file and line only; matched text is never shown)
- `/ai-usage [days]`: AI job counts by engine, Codex fallbacks with reasons, failures, briefing quality retries and tokens (default 7 days)
- `/restart`: restart this bridge's launchd service after inline approval; refused while any job is running
- `/inbox add [type] <text>`: capture a task, reading item, idea, document, journal, or request
- `/inbox`, `/done <id>`, `/snooze <id> [hours]`, `/archive <id>`: triage captured items
- `/watch <url> [label]`, `/watches`, `/unwatch <id>`: monitor public web pages for meaningful changes
- `/lab now <topic>`: queue research immediately (dashboard default); `/lab tonight <topic>` remains an explicit one-time 23:00 option
- `/lab list`, `/lab archive <id>`, `/lab discard <id>`: review and triage persistent AI lab results
- `/lab read <id>` marks a result read without hiding it. `/lab practice|implement|research <id> <selected task>` queues a linked follow-up in the original workspace for the next available scheduler tick. `/lab restore <id>` restores an archived result. The dashboard exposes these actions and an archive section; implementation is limited to the selected workspace, with no installation, deployment or service restart.
- `/n8n <request>`: inspect, diagnose, or update n8n through configured Codex MCP tools
- `/brief`: create a read-only daily operations brief
- `/morning`, `/evening`, `/weekly-review`: run a context-aware personal briefing immediately
- `/creative tonight <request>`: queue a tested creative build for 23:00
- `/research <topic>`: create a sourced research report
- `/incident <details>`: diagnose an automation or service incident
- `/file <relative-path>`: upload a file from the active workspace
- `/help`: show usage
- `/workspaces`: list allowed workspace aliases
- `/workspace [alias]`: show or switch the active workspace for the chat
- `/serve <command>`: start a managed background server in the active workspace
- `/ps`: list managed background servers for the chat
- `/logs <processId>`: show recent logs for a managed background server
- `/stop <processId>`: stop a managed background server

Only one active job is allowed per chat. Normal Telegram and dashboard jobs run inside the selected workspace:

```bash
codex exec --skip-git-repo-check --json --sandbox workspace-write -C <workspace>
```

Telegram chat/user allowlists remain enforced. System-wide access is available only through `/admin`, must be confirmed with the Telegram approval button, and can be disabled with `TELEGRAM_UNRESTRICTED_ENABLED=false`. Direct bridge commands such as `/file` and `/serve` keep their command-specific validation.

## AI engine: Claude primary, Codex fallback

Jobs run on Claude Code (`claude -p --output-format stream-json`) by default. Non-admin jobs use `acceptEdits` with Claude Code's Bash sandbox (no unsandboxed escape); web tools are allowed only in `/research`, `/brief`, `/incident` and approved external-action modes. Admin-approved jobs bypass permissions, like the Codex bypass flag.

Codex is used when Claude's rate limit is insufficient:

- A Claude attempt that ends with a rejected rate limit (or a failed Claude spawn) is retried once on Codex in the same job. The result shows `Fallback: Codex (...)`.
- Claude limits are learned from `rate_limit_event` messages of real jobs and stored in `CLAUDE_LIMIT_STATE_PATH` (default `~/.codex/ai-workmate-claude-limits.json`). Until the reported reset (1 hour when unknown), or while a 5h/7d window is at or above `CLAUDE_FALLBACK_UTILIZATION`, new jobs go straight to Codex. No quota probe request is sent. When an interactive Claude Code statusline writes `rate_limits` to `CLAUDE_RATE_LIMIT_SNAPSHOT` (default `~/.claude/rate-limits.json`) and that file is newer than the last job event, its values are used for status, dashboard and fallback.
- Scheduled usage pause still triggers only when the final attempt fails with a usage limit, so a successful Codex fallback keeps schedules running.
- `/n8n` stays on Codex unless `CLAUDE_MCP_CONFIG` points to a Claude MCP config.
- Briefing and `/weekly-review`/`/ai-trends` jobs use `SCHEDULED_CLAUDE_MODEL`/`SCHEDULED_CLAUDE_EFFORT` on Claude and `SCHEDULED_CODEX_MODEL`/`SCHEDULED_CODEX_REASONING_EFFORT` on fallback.
- `AI_PROVIDER=codex` restores Codex-only behavior.

`/status` and the dashboard show both Claude and Codex limits.

If you reply to a previous bot completion message, the bridge resumes that session with the engine that created it (`claude --resume` or `codex exec resume`; sessions saved before this change are Codex). When a Claude session cannot continue because of limits, the reply starts a new Codex session. Plain non-reply messages start a new session.

The service sends completion and failure details as Telegram messages. Long results are split across multiple messages.

Natural schedules are classified before execution. Plain reminders are delivered locally without Codex usage, even when scheduled AI work is paused by a usage limit. Requests containing research/news/search/summary intent run as sandboxed Codex jobs at the scheduled time and send their result to Telegram as soon as the job finishes. Use `/schedules` to inspect them and `/unschedule <id>` to cancel one.

Codex runs behind the bridge and should treat Telegram delivery as the bridge's responsibility. If a user asks to "send to Telegram", Codex should create or modify local workspace artifacts and report the result; it should not try to call Telegram APIs or other external delivery tools directly.

If Codex creates image files in the workspace during a successful job, the bridge uploads the recent image artifacts to Telegram after the text summary. Raster images are sent as photos when possible, and other image formats such as SVG are sent as documents.

Incoming Telegram photos, documents, voice messages, audio, and video are downloaded under `.ai-workmate/inbox/<chat-id>` in the active workspace and passed to Codex as untrusted local attachments. Voice transcription requires a compatible local transcription tool; when none is available, the job reports the missing prerequisite.

A Telegram message containing only an HTTP(S) URL is captured into the personal reading inbox without spending Codex usage. AI Lab research and creative jobs persist their queued/completed/failed state, summary, and generated artifact paths, so overnight work remains visible on the dashboard after the original schedule has finished.

External state changes and `/admin` requests pause for inline approval. Dashboard-originated requests retain the same approval flow.

Telegram Codex jobs may operate outside configured workspace aliases when the request requires it.
Direct bridge commands still apply their own validation. For long-running workspace services, use
`/serve` and manage them with `/ps` and `/stop`.

## Personal Operations

The personal inbox and web-watch state is stored atomically in
`~/.codex/ai-workmate-personal-ops.json` by default. Web watches establish a baseline on the first
check and notify only when normalized text changes. Localhost, private-network, credential-bearing,
and non-HTTP URLs are rejected.

Examples:

```text
/inbox add task 이번 주 보증서 정리
/inbox add 읽기 https://example.com/article
/snooze in-a1b2c3 48
/watch https://example.com/releases 제품 릴리스
/lab now 개인 사진 아카이브의 중복 제거 전략
```

Set `EXTERNAL_STORAGE_PATH` to the mounted encrypted SSD and run a recoverable backup:

```bash
npm run personal-ops:backup
```

The command copies AI Workmate JSON state and creates a consistent n8n SQLite backup. Backups older
than 30 days are listed, never automatically deleted. Test restoration monthly and keep a second
off-device copy before treating the SSD as primary storage.

## Repository Checks

Every day after `REPO_CHECK_HOUR` (default 07, Asia/Seoul) the bridge checks each directory under
`REPO_CHECK_ROOT` (default: the parent of this checkout; names starting with `_` or `.` are skipped).
The latest result is shown in the morning briefing, the weekly review and the dashboard System tab,
which also has a "지금 점검" button.

- Harness repositories (`harness/manifest.json`): `harness-lab audit`, `check-evidence` on the newest
  `checks.json` under the manifest `reportsDir`, and a maintenance review older than 30 days.
  `HARNESS_LAB_CLI` overrides the CLI path (default `<root>/harness-lab/dist/index.js`).
- Every repository: the files Git would commit (tracked plus untracked files not ignored; non-Git
  directories use a temporary Git dir outside the repository) are scanned for private keys, known
  token formats, quoted secret assignments and `.env` files (blockers), the home directory path,
  `PUBLISH_CHECK_PRIVATE_TERMS` (comma-separated, e.g. your email) and files over 5 MB (warnings),
  and a missing README, LICENSE or `.gitignore`.

Checks never run other repositories' tests and never write to them. Set `REPO_CHECKS_ENABLED=false`
to disable the daily run.

## Operational Approval

`/restart` asks for inline approval and runs `launchctl kickstart -k gui/<uid>/<label>` for
`AI_WORKMATE_LAUNCHD_LABEL` (default `com.ai-workmate.bridge`; `scripts/install_launchd_startup.sh` installs
the same label, read from the environment or `.env`). Approval re-checks running jobs and refuses while any exists.
The restarted process confirms completion in the same chat. It is not available from the dashboard.
Chat requests that mention `git push` or pushing to GitHub/a remote also require approval.

## Native Personal Briefings

AI Workmate creates four idempotent schedules at startup unless
`PERSONAL_BRIEFINGS_ENABLED=false`:

- Morning briefing at `MORNING_BRIEF_TIME` (default `08:00`)
- Evening briefing and daily discovery recommendations at `EVENING_BRIEF_TIME` (default `20:00`)
- Sunday review at `WEEKLY_REVIEW_TIME` (default `20:30`)
- AI trend briefing at `AI_TREND_BRIEF_TIME` (default `12:00`)

Morning and evening briefings are rendered locally from weather, Apple Calendar, Inbox and trading
data. Their recommendations use Ollama and fall back to a local rotation when Ollama is unavailable,
so these two daily jobs do not consume Codex usage. Weather uses the coordinates in
`WEATHER_LATITUDE` and `WEATHER_LONGITUDE`; `PERSONAL_LOCATION` is a reference point, not a boundary.
Korean public holidays, weekends and Calendar entries containing 휴가/연차/반차/휴무 adjust the
recommendation mode automatically. Clear natural-language feedback such as “이 추천은 좋았어” or
“이런 추천은 하지 마” is offered back as a preference and stored only after Telegram confirmation.

The operational monitor is intentionally quiet when healthy. It alerts only for a missing scheduled
briefing, a disconnected or nearly-full external SSD, a stale photo backup, or failing schedules.
Alert cooldowns and 30-day Codex/local usage metrics survive service restarts.

The AI trend and weekly review jobs use the lower-cost scheduled Codex model. AI trend research has
a strict search/page budget, while the weekly review uses only local context and performs no web
research. Apple Calendar collection uses separate today and tomorrow windows and includes all-day
and already-running events.

After the weekly review is written, code appends the 7-day AI usage report (the `/ai-usage` text)
and the latest repository check lines, so those numbers are never written by the model. The report
counts volume, fallbacks and failures; it is not a quality evaluation.

## Local Telegram Send Helper

`npm run telegram:send` sends a plain text message with the same bot token already configured for the bridge.

Examples:

```bash
npm run english-study:build -- --output out/telegram-english-study-message.txt
npm run telegram:send -- --text "hello from local cli"
npm run telegram:send -- --file out/periodic-message.txt
printf '%s' "hello from stdin" | npm run telegram:send -- --stdin
```

Target chat selection order:

1. `--chat-id`
2. `DEFAULT_TELEGRAM_TARGET_CHAT_ID`
3. First value in `ALLOWED_CHAT_IDS`

This makes it usable from external schedulers such as n8n without duplicating the bot token inside the workflow.

## Weekday English Study Automation

`npm run english-study:build` reads `english-study-weekday-hourly.md` (your own lesson source, not committed; copy
`english-study.example.md` for the format) and writes the current weekday/hour lesson to `out/telegram-english-study-message.txt`.

Example:

```bash
npm run english-study:build -- --output out/telegram-english-study-message.txt
npm run telegram:send -- --file out/telegram-english-study-message.txt
```

For n8n setup details, see [docs/n8n-english-study-weekday-hourly.md](docs/n8n-english-study-weekday-hourly.md).
