import path from "node:path";

export function parseWorkspaceMap(env) {
  const configured = env.ALLOWED_WORKSPACES?.trim();
  const defaultWorkspace = env.CODEX_WORKSPACE?.trim();
  const entries = [];

  if (configured) {
    for (const rawEntry of configured.split(",")) {
      const entry = rawEntry.trim();
      if (!entry) {
        continue;
      }

      const [alias, ...rest] = entry.split("=");
      if (!alias || rest.length === 0) {
        throw new Error(`Invalid ALLOWED_WORKSPACES entry: ${entry}`);
      }

      entries.push({
        alias: alias.trim(),
        path: rest.join("=").trim(),
      });
    }
  }

  if (entries.length === 0 && defaultWorkspace) {
    entries.push({ alias: "default", path: defaultWorkspace });
  }

  if (entries.length === 0) {
    throw new Error("CODEX_WORKSPACE or ALLOWED_WORKSPACES is required");
  }

  const byAlias = {};
  for (const entry of entries) {
    if (byAlias[entry.alias]) {
      throw new Error(`Duplicate workspace alias: ${entry.alias}`);
    }
    byAlias[entry.alias] = path.resolve(entry.path);
  }

  const defaultAlias =
    entries.find((entry) => entry.path === defaultWorkspace)?.alias ?? entries[0].alias;

  return { defaultAlias, byAlias };
}

export class WorkspaceSessionStore {
  constructor(workspaces) {
    this.workspaces = workspaces;
    this.selectionByChat = new Map();
  }

  getActiveWorkspace(chatId) {
    const alias = this.selectionByChat.get(String(chatId)) ?? this.workspaces.defaultAlias;
    return this.getWorkspaceByAlias(alias);
  }

  setActiveWorkspace(chatId, alias) {
    const workspace = this.getWorkspaceByAlias(alias);
    if (!workspace) {
      return null;
    }
    this.selectionByChat.set(String(chatId), alias);
    return workspace;
  }

  listWorkspaces() {
    return Object.entries(this.workspaces.byAlias).map(([alias, workspacePath]) => ({
      alias,
      path: workspacePath,
    }));
  }

  getWorkspaceByAlias(alias) {
    // Own string entries only: "constructor" or "toString" must not resolve to Object.prototype members.
    const workspacePath = Object.hasOwn(this.workspaces.byAlias, alias) ? this.workspaces.byAlias[alias] : null;
    if (typeof workspacePath !== "string" || !workspacePath) {
      return null;
    }

    return { alias, path: workspacePath };
  }
}
