import fs from "node:fs/promises";
import net from "node:net";

export async function buildHealthReport(config, { connect = canConnect } = {}) {
  const services = await Promise.all([
    inspect("AI Workmate", config.dashboardPort, connect),
    inspect("n8n", config.n8nPort, connect),
    inspect("Trading", config.tradingDashboardPort, connect),
    inspect("Ollama", config.ollamaPort, connect),
  ]);
  const storage = await inspectStorage(config.externalStoragePath);
  const photoBackup = await inspectDirectory(config.photoBackupPath);
  return { checkedAt: new Date().toISOString(), services, storage, photoBackup };
}

export function formatHealthReport(report) {
  return [
    "AI Workmate Health",
    `Checked: ${report.checkedAt}`,
    ...report.services.map((row) => `${row.ok ? "✅" : "❌"} ${row.name}: ${row.ok ? "online" : "offline"}`),
    report.storage.configured
      ? `${report.storage.ok ? "✅" : "❌"} External storage: ${report.storage.ok ? `${report.storage.path} (${formatBytes(report.storage.availableBytes)} free)` : report.storage.error}`
      : "⚪ External storage: EXTERNAL_STORAGE_PATH not configured",
    report.photoBackup?.configured
      ? `${report.photoBackup.ok ? "✅" : "❌"} Photo backup: ${report.photoBackup.ok ? `${report.photoBackup.path} (latest ${report.photoBackup.latestModifiedAt || "empty"})` : report.photoBackup.error}`
      : "⚪ Photo backup: PHOTO_BACKUP_PATH not configured",
  ].join("\n");
}

export async function inspectDirectory(directoryPath) {
  if (!directoryPath) return { configured: false, ok: false };
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    let latest = 0;
    for (const entry of entries.slice(0, 5000)) {
      try { latest = Math.max(latest, (await fs.stat(`${directoryPath}/${entry.name}`)).mtimeMs); } catch {}
    }
    return { configured: true, ok: true, path: directoryPath, files: entries.filter((entry) => entry.isFile()).length, latestModifiedAt: latest ? new Date(latest).toISOString() : null };
  } catch (error) {
    return { configured: true, ok: false, path: directoryPath, error: error.code || error.message };
  }
}

async function inspect(name, port, connect) {
  return { name, port, ok: await connect(port) };
}

async function inspectStorage(storagePath) {
  if (!storagePath) return { configured: false, ok: false };
  try {
    const stats = await fs.statfs(storagePath);
    return { configured: true, ok: true, path: storagePath, availableBytes: stats.bavail * stats.bsize };
  } catch (error) {
    return { configured: true, ok: false, path: storagePath, error: error.code || error.message };
  }
}

function canConnect(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount.toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}
