import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class N8nManager {
  constructor({ port = 5678, databasePath } = {}) {
    this.baseUrl = `http://127.0.0.1:${port}/api/v1`;
    this.databasePath = databasePath || path.join(os.homedir(), ".n8n", "database.sqlite");
  }

  async overview() {
    const [workflowResponse, executionResponse, failureResponse] = await Promise.all([
      this.#request("/workflows?limit=100"),
      this.#request("/executions?limit=100&includeData=false"),
      this.#request("/executions?status=error&limit=5&includeData=false"),
    ]);
    const workflows = (workflowResponse.data ?? []).filter((row) => !row.isArchived).map((row) => ({
      id: row.id,
      name: row.name,
      active: Boolean(row.active),
      updatedAt: row.updatedAt,
    }));
    const names = new Map(workflows.map((row) => [row.id, row.name]));
    const allExecutions = (executionResponse.data ?? []).map((row) => ({
      id: row.id,
      workflowId: row.workflowId,
      workflowName: names.get(row.workflowId) ?? row.workflowId,
      status: row.status,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt,
    }));
    const executions = allExecutions.slice(0, 10);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
    const todayExecutions = allExecutions.filter((row) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(row.startedAt)) === today
    );
    const executionStats = {
      success: todayExecutions.filter((row) => row.status === "success").length,
      failed: todayExecutions.filter((row) => row.status === "error" || row.status === "crashed").length,
      running: todayExecutions.filter((row) => row.status === "running" || row.status === "waiting").length,
      total: todayExecutions.length,
    };
    const failures = (failureResponse.data ?? []).map((row) => ({
      id: row.id,
      workflowId: row.workflowId,
      workflowName: names.get(row.workflowId) ?? row.workflowId,
      status: row.status,
      startedAt: row.startedAt,
      stoppedAt: row.stoppedAt,
    }));
    return { workflows, executions, failures, executionStats };
  }

  async setPublished(id, published) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Invalid workflow ID.");
    const action = published ? "activate" : "deactivate";
    const workflow = await this.#request(`/workflows/${id}/${action}`, { method: "POST" });
    return { id: workflow.id ?? id, name: workflow.name, active: Boolean(workflow.active) };
  }

  async failureDetails(id) {
    if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid execution ID.");
    const execution = await this.#request(`/executions/${id}?includeData=true`);
    const result = execution.data?.resultData || {};
    const error = result.error || {};
    return { id: execution.id, status: execution.status, node: error.node?.name || result.lastNodeExecuted || null,
      message: String(error.message || "상세 오류 기록 없음").slice(0, 1200), httpCode: error.httpCode || null,
      description: String(error.description || "").slice(0, 500) };
  }

  async retryExecution(id) {
    if (!/^\d{1,20}$/.test(id)) throw new Error("Invalid execution ID.");
    const execution = await this.#request(`/executions/${id}/retry`, {
      method: "POST",
      body: JSON.stringify({ loadWorkflow: true }),
    });
    return { id: execution.id, status: execution.status, workflowId: execution.workflowId };
  }

  async #request(resource, options = {}) {
    const apiKey = await this.#readApiKey();
    const response = await fetch(this.baseUrl + resource, {
      ...options,
      headers: { "X-N8N-API-KEY": apiKey, "content-type": "application/json", ...options.headers },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`n8n API ${response.status}: ${detail.slice(0, 240)}`);
    }
    return response.json();
  }

  async #readApiKey() {
    const { stdout } = await execFileAsync("sqlite3", [
      this.databasePath,
      "SELECT apiKey FROM user_api_keys WHERE audience = 'public-api' ORDER BY createdAt DESC LIMIT 1;",
    ], { maxBuffer: 64 * 1024 });
    const key = stdout.trim();
    if (!key) throw new Error("n8n API key is not configured.");
    return key;
  }
}
