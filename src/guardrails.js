const BLOCKED_PROMPT_PATTERNS = [
  { pattern: /\brm\s+-rf\b/i, reason: "destructive filesystem deletion" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "destructive git reset" },
  { pattern: /\bmkfs\b/i, reason: "disk formatting" },
  { pattern: /\bdd\b/i, reason: "raw disk write" },
  { pattern: /\bsudo\b/i, reason: "privilege escalation" },
  { pattern: /\bshutdown\b|\breboot\b/i, reason: "system shutdown" },
  { pattern: /\bkillall\b/i, reason: "mass process termination" },
  { pattern: /\bpoweroff\b/i, reason: "system power control" },
];

const ALLOWED_SERVER_COMMANDS = [
  ["npm", "run"],
  ["npm", "start"],
  ["pnpm", "run"],
  ["pnpm", "start"],
  ["yarn", "start"],
  ["yarn", "run"],
  ["node"],
  ["python3"],
  ["uvicorn"],
  ["gunicorn"],
];

export function checkPromptSafety(prompt) {
  for (const blocked of BLOCKED_PROMPT_PATTERNS) {
    if (blocked.pattern.test(prompt)) {
      return { allowed: false, reason: blocked.reason };
    }
  }

  return { allowed: true };
}

export function checkServerCommandSafety(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { allowed: false, reason: "missing server command" };
  }

  const joined = argv.join(" ");
  for (const blocked of BLOCKED_PROMPT_PATTERNS) {
    if (blocked.pattern.test(joined)) {
      return { allowed: false, reason: blocked.reason };
    }
  }

  const isAllowed = ALLOWED_SERVER_COMMANDS.some((prefix) =>
    prefix.every((segment, index) => argv[index] === segment),
  );

  if (!isAllowed) {
    return { allowed: false, reason: "server command prefix is not allowed" };
  }

  // node/python3 run a script file directly: any interpreter flag before it (-e, -pe, -Bc, --inspect, ...)
  // could run inline code or open a debugger outside the sandbox.
  if (["node", "python3"].includes(argv[0]) && (!argv[1] || argv[1].startsWith("-"))) {
    return { allowed: false, reason: `${argv[0]} must be followed by a script file (no interpreter flags)` };
  }

  return { allowed: true };
}
