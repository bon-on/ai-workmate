import fs from "node:fs/promises";
import path from "node:path";

export class TelegramClient {
  constructor(token, { fetchImpl = fetch, requestTimeoutMs = 30000 } = {}) {
    this.token = token;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async getUpdates({ offset, timeoutSeconds, signal, requestTimeoutMs = null }) {
    const params = new URLSearchParams({
      timeout: String(timeoutSeconds),
      allowed_updates: JSON.stringify(["message", "callback_query"]),
    });

    if (offset != null) {
      params.set("offset", String(offset));
    }

    return this.#request(`getUpdates?${params.toString()}`, {
      method: "GET",
      signal,
      timeoutMs: requestTimeoutMs ?? Math.max(this.requestTimeoutMs, (timeoutSeconds + 15) * 1000),
    });
  }

  async getMe() {
    return this.#request("getMe", {
      method: "GET",
    });
  }

  async getWebhookInfo() {
    return this.#request("getWebhookInfo", {
      method: "GET",
    });
  }

  async getFile(fileId) {
    return this.#request(`getFile?file_id=${encodeURIComponent(fileId)}`, {
      method: "GET",
    });
  }

  async downloadFile(filePath, { maxBytes = 20 * 1024 * 1024 } = {}) {
    const requestSignal = createTimeoutSignal({ signal: null, timeoutMs: this.requestTimeoutMs });
    try {
      const response = await this.fetchImpl(
        `https://api.telegram.org/file/bot${this.token}/${filePath}`,
        { signal: requestSignal.signal },
      );
      if (!response.ok) {
        throw new Error(`Telegram file download failed (${response.status})`);
      }
      const declaredSize = Number(response.headers?.get?.("content-length") || 0);
      if (declaredSize > maxBytes) {
        throw new Error(`Telegram file exceeds ${maxBytes} bytes`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) {
        throw new Error(`Telegram file exceeds ${maxBytes} bytes`);
      }
      return buffer;
    } finally {
      requestSignal.cleanup();
    }
  }

  async answerCallbackQuery(callbackQueryId, text = null) {
    return this.#request("answerCallbackQuery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
    });
  }

  async editMessageReplyMarkup(chatId, messageId, replyMarkup = { inline_keyboard: [] }) {
    return this.#request("editMessageReplyMarkup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
    });
  }

  async deleteWebhook({ dropPendingUpdates = false } = {}) {
    return this.#request("deleteWebhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        drop_pending_updates: dropPendingUpdates,
      }),
    });
  }

  async sendMessage(chatId, text, extra = {}) {
    return this.#request("sendMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...extra,
      }),
    });
  }

  async sendDocument(chatId, filePath, caption) {
    return this.#sendMultipart("sendDocument", chatId, "document", filePath, caption);
  }

  async sendPhoto(chatId, filePath, caption) {
    return this.#sendMultipart("sendPhoto", chatId, "photo", filePath, caption);
  }

  async #request(pathname, options) {
    const { timeoutMs = this.requestTimeoutMs, signal, ...fetchOptions } = options;
    const requestSignal = createTimeoutSignal({ signal, timeoutMs });
    let response;
    let payload;

    try {
      response = await this.fetchImpl(`${this.baseUrl}/${pathname}`, {
        ...fetchOptions,
        signal: requestSignal.signal,
      });
      payload = await response.json();
    } catch (error) {
      if (requestSignal.timedOut()) {
        throw new Error(`Telegram request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      requestSignal.cleanup();
    }

    if (!response.ok || !payload.ok) {
      const description = payload.description || `Telegram API error (${response.status})`;
      throw new Error(description);
    }

    return payload.result;
  }

  async #sendMultipart(method, chatId, fieldName, filePath, caption) {
    const form = new FormData();
    const fileName = path.basename(filePath);
    const buffer = await fs.readFile(filePath);
    form.append("chat_id", String(chatId));
    if (caption) {
      form.append("caption", caption);
    }
    form.append(fieldName, new Blob([buffer]), fileName);

    return this.#request(method, {
      method: "POST",
      body: form,
    });
  }
}

function createTimeoutSignal({ signal, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  let settled = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const abortFromParent = () => {
    if (settled) {
      return;
    }
    controller.abort();
  };

  if (signal?.aborted) {
    controller.abort();
  } else if (signal) {
    signal.addEventListener("abort", abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.("abort", abortFromParent);
    },
  };
}
