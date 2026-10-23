import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, resolveDefaultChatId } from "../src/telegram-send.js";

test("parseArgs reads text mode", () => {
  assert.deepEqual(parseArgs(["--chat-id", "123", "--text", "hello"]), {
    chatId: "123",
    text: "hello",
    filePath: null,
    stdin: false,
    help: false,
  });
});

test("parseArgs rejects multiple message sources", () => {
  assert.throws(() => parseArgs(["--text", "hello", "--stdin"]), /Exactly one of --text, --file, or --stdin is required/);
});

test("resolveDefaultChatId prefers explicit then configured values", () => {
  assert.equal(
    resolveDefaultChatId("111", {
      DEFAULT_TELEGRAM_TARGET_CHAT_ID: "222",
      ALLOWED_CHAT_IDS: "333,444",
    }),
    "111",
  );

  assert.equal(
    resolveDefaultChatId(null, {
      DEFAULT_TELEGRAM_TARGET_CHAT_ID: "222",
      ALLOWED_CHAT_IDS: "333,444",
    }),
    "222",
  );

  assert.equal(
    resolveDefaultChatId(null, {
      ALLOWED_CHAT_IDS: "333,444",
    }),
    "333",
  );
});
