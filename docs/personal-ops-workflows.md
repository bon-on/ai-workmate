# AI Workmate Personal Operations

The following n8n workflow drafts are installed but intentionally unpublished:

- `AI Workmate - Morning Brief`
- `AI Workmate - Research Digest`
- `AI Workmate - Incident Intake`

They remain inactive because the local n8n credential store currently has no Google or Telegram credentials. Before publishing:

1. Add a Telegram credential and select it in each `Send ...` node.
2. Replace the Telegram chat ID placeholder.
3. For Morning Brief, add Gmail OAuth and Google Calendar OAuth credentials.
4. Execute each workflow manually and verify its output.
5. Publish only after the manual run succeeds.

The incident webhook only accepts requests from localhost. External incidents should be forwarded through a trusted local collector rather than exposing this webhook publicly.

Telegram commands provided by the bridge:

- `/n8n <request>`: n8n inspection and controlled changes
- `/brief`: read-only operations summary
- `/incident <details>`: evidence-first incident diagnosis
- `/research <topic>`: sourced research report
- `/file <relative-path>`: send a generated workspace file

External send, delete, publish, deploy, and email/calendar mutation requests require approval through the Telegram inline keyboard.
