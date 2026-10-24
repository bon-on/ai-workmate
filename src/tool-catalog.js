export const TOOL_CATALOG = [
  {
    id: "codex",
    name: "AI job",
    description: "Send any plain text message to run Claude (Codex fallback) in the active workspace.",
  },
  {
    id: "memory",
    name: "Persistent memory",
    description: "Use /remember, /memories, and /forget to manage chat/workspace memories.",
  },
  {
    id: "schedule",
    name: "Scheduled jobs",
    description: "Use /schedule in 10m <prompt> or /schedule every 1h <prompt>.",
  },
  {
    id: "delegate",
    name: "Delegated jobs",
    description: "Use /delegate <prompt>, /delegates, and /delegate-cancel <jobId> for concurrent work.",
  },
  {
    id: "workspace",
    name: "Workspace switcher",
    description: "Use /workspaces and /workspace <alias> to control where jobs run.",
  },
  {
    id: "server",
    name: "Managed server",
    description: "Use /serve, /ps, /logs, and /stop for background processes.",
  },
  {
    id: "english-study",
    name: "English study",
    description: "Daily news vocabulary with Korean meanings and review at 12:10 (ENGLISH_STUDY_TIME); /english sends one now. npm run english-study:build renders the static weekly lesson.",
  },
  {
    id: "trading",
    name: "Trading controls",
    description: "Use /tr 보유, /tr 설정 <종목> 익절 <퍼센트> 손절 <퍼센트>, and /tr 매도 <종목>.",
  },
  {
    id: "n8n-ops",
    name: "n8n operations copilot",
    description: "Use /n8n, /brief, and /incident to inspect workflows and diagnose automation failures.",
  },
  {
    id: "multimodal",
    name: "Telegram attachments",
    description: "Send a photo, document, voice message, audio, or video with an optional caption.",
  },
  {
    id: "research",
    name: "Sourced research",
    description: "Use /research <topic> to create a current, sourced report.",
  },
  {
    id: "personal-ops",
    name: "Personal operations inbox",
    description: "Use /inbox add, /inbox, /done, /snooze, and /archive to capture and triage personal items.",
  },
  {
    id: "watchtower",
    name: "Web change watchtower",
    description: "Use /watch, /watches, and /unwatch to receive deduplicated public web-page change alerts.",
  },
  {
    id: "overnight-lab",
    name: "Overnight research lab",
    description: "Use /lab tonight <topic> to queue a sourced Markdown research report for 23:00.",
  },
  {
    id: "health",
    name: "Home lab health",
    description: "Use /health to inspect core services and mounted external storage.",
  },
  {
    id: "personal-services",
    name: "Creative tools",
    description: "Use /creative tonight for local personal workflows.",
  },
];

export function formatToolCatalog() {
  return TOOL_CATALOG.map((tool) => `${tool.id} | ${tool.name}\n${tool.description}`).join("\n\n");
}
