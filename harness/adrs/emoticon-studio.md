---
id: emoticon-studio
title: Plan emoticons with a JobManager job, render with the imoticon-maker CLI
status: accepted
related_specs:
  - emoticon-studio
---
# Emoticon studio
## Context
imoticon-maker draws talking stickers offline from a character phrase and speech lines and exports per-messenger packs. It deliberately avoids Telegram APIs (its ADR leaves Telegram delivery to ai-workmate). Good packs need creative speech lines that fit the user's feeling, and a photo can only steer the offline renderer through species and color choice.
## Decision
- A planning job through JobManager writes a small JSON plan (character, title, lines). The model reads the photo from `data/emoticons/<id>/` inside the default workspace.
- ai-workmate validates the plan and runs `imoticon-maker main.py pack --json` as a subprocess; it does not import or duplicate rendering code.
- Telegram ZIP delivery and sticker set registration live in ai-workmate, which already owns the bot.
- Requests and outputs are stored under the git-ignored `data/emoticons/`.
## Alternatives
- Let the AI job run the CLI itself: needs imoticon-maker as an allowed workspace and makes output paths unreliable.
- Keyword parsing only: free, but cannot write lines that match a feeling or read a photo.
- Port the renderer to JavaScript: duplicates imoticon-maker.
## Consequences
Each request costs one planning job. With the offline engine the photo influences species and color, not a likeness; likeness needs the `ai` engine and OpenAI credits. The dashboard depends on a sibling checkout path (`IMOTICON_MAKER_PATH`).
