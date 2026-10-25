---
id: emoticon-studio
title: Dashboard emoticon studio
status: active
related_adrs:
  - emoticon-studio
  - claude-primary
related_contracts:
  - verification
---
# Emoticon studio
## Problem
Making a talking sticker pack needs the sibling imoticon-maker CLI, hand-written speech lines and manual uploads per messenger. The user wants to describe a feeling (optionally with a photo) on the dashboard and get a good pack for Telegram, iPhone, Android and KakaoTalk.
## Scope
- An "이모티콘" dashboard tab: feeling text, optional photo, sticker count, engine, Telegram options, recent results with previews and downloads.
- A planning job through JobManager that turns the feeling and photo into a character, pack title and per-expression speech lines.
- Rendering by the imoticon-maker `pack --json` CLI; optional Telegram delivery of the platform ZIPs and optional Telegram sticker set registration.
- Out of scope: new character species or drawing styles (imoticon-maker owns rendering), Telegram chat commands, KakaoTalk/iMessage/Android installation.
## Acceptance Criteria
- The tab accepts a feeling (required unless a photo is given, max 500 chars), an optional JPEG/PNG/WebP photo (downscaled in the browser, max 6 MB request), a count of 1-12 and engine `local` (default, free) or `ai` (OpenAI, uses the photo as reference).
- Submitting returns immediately with a request id; status moves planning -> rendering -> completed or failed and survives a bridge restart (in-flight requests become failed with a restart note).
- Planning runs as a JobManager job (`jobKind: "emoticon"`, concurrent with chat jobs, `deliverToTelegram: false`) so Claude-primary policy, Codex fallback and usage metrics apply. The prompt includes the photo path inside the workspace.
- The plan is validated: species and color come from the imoticon-maker vocabulary, title <= 40 chars, each line <= 16 chars with `|` removed. An invalid or failed plan falls back to the feeling text and default lines and is marked as such.
- Rendering runs `python3 <IMOTICON_MAKER_PATH>/main.py pack --json` with telegram, imessage, whatsapp and kakaotalk platforms and a timeout; output stays under `data/emoticons/<id>/`.
- Completed requests show sticker previews with speech, per-platform ZIP downloads and the plan source; files are served only from that request directory with allowed extensions.
- "텔레그램으로 받기" sends the platform ZIPs to the first allowed chat. "텔레그램 스티커 팩 등록" creates a sticker set owned by the first allowed user (or private chat id) and shows its t.me/addstickers link. Telegram failures are reported on the request without failing the render.
- Polling preserves expanded results and scroll; emitted browser JavaScript is syntax-checked.
## Constraints
- Tests use fake jobs, a fake pack runner and a fake Telegram client: no AI calls, no Python rendering of real user data, no external messages.
- The bridge is not restarted by this work.
## Evidence
- test/emoticon-studio.test.js: request validation, plan parsing/fallback, job options, pack argv, status persistence and restart recovery, file path guard, Telegram delivery and sticker set calls, emitted tab JavaScript.
- npm run verify:harness
