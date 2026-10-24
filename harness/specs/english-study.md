---
id: english-study
title: Daily English vocabulary from real news with spaced review
status: active
related_adrs:
  - claude-primary
related_contracts:
  - verification
---
# English study
## Problem
The English study messages came from an n8n workflow that has been inactive since May. Its news-based variant depended on an unofficial Google Translate endpoint that now returns a block page, and the static variant repeats the same 14 lessons every week. The user wants daily words and example sentences again.
## Scope
- A daily scheduled message (default 12:10, `ENGLISH_STUDY_TIME`, `ENGLISH_STUDY_ENABLED`) built by code in the bridge, not by Claude or n8n.
- Source: one recent, not yet used article from the BNE and DW English RSS feeds; 5 words picked from its title and text, validated against the system word list; dictionaryapi.dev adds definitions and examples when reachable.
- Korean title translation, word meanings and example translations from the local Ollama model; no paid AI.
- Review section: words sent 3 and 7 days ago, shown as a quiz with answers.
- `/english` sends one now. Sent words and used article links are stored in the personal ops state to avoid repeats.
- Out of scope: the n8n workflows (left inactive), dashboard UI, pronunciation audio.
## Acceptance Criteria
- No Claude/Codex job and no n8n call; the message is assembled by code and the usage pause does not block it.
- Ollama output is validated (Hangul meanings, bounded length); a missing or invalid meaning never prints raw model text.
- If Ollama is unavailable, the static weekly lesson is sent when its local source exists, otherwise an English-definition version; if all feeds fail, the static lesson or a clear failure notice is sent.
- Words sent in the last 60 days and articles used before are not picked again; proper nouns and common words are skipped.
- The schedule fires once per day even across restarts, like the other personal schedules.
## Constraints
- Network: RSS feeds, dictionaryapi.dev and local Ollama only, each with a timeout; tests use mocked fetch.
- State retention is bounded (words and links capped).
## Evidence
- test/english-study.test.js: feed parsing, word selection and dedupe, dictionary/Ollama validation, fallbacks, review quiz, scheduling and `/english`.
- npm run verify:harness
