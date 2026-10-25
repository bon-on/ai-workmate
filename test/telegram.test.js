import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient } from "../src/telegram.js";

test("TelegramClient passes successful json responses through", async () => {
  const client = new TelegramClient("token", {
    fetchImpl: async (url, options) => {
      assert.match(url, /getMe$/);
      assert.equal(options.method, "GET");
      return {
        ok: true,
        async json() {
          return { ok: true, result: { username: "bridge_bot" } };
        },
      };
    },
  });

  assert.deepEqual(await client.getMe(), { username: "bridge_bot" });
});

test("TelegramClient aborts requests that exceed the configured timeout", async () => {
  const client = new TelegramClient("token", {
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });

  await assert.rejects(() => client.getMe(), /timed out after 5ms/);
});

test("TelegramClient reports Telegram API descriptions", async () => {
  const client = new TelegramClient("token", {
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      async json() {
        return { ok: false, description: "Bad Gateway" };
      },
    }),
  });

  await assert.rejects(() => client.getMe(), /Bad Gateway/);
});

test("TelegramClient.setMyCommands posts the command list", async () => {
  const client = new TelegramClient("token", {
    fetchImpl: async (url, options) => {
      assert.match(url, /setMyCommands$/);
      assert.equal(options.method, "POST");
      assert.deepEqual(JSON.parse(options.body), { commands: [{ command: "help", description: "도움말" }] });
      return { ok: true, async json() { return { ok: true, result: true }; } };
    },
  });
  assert.equal(await client.setMyCommands([{ command: "help", description: "도움말" }]), true);
});
