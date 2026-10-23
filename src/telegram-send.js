import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadEnvFile } from "./config.js";
import { TelegramClient } from "./telegram.js";

const HELP_TEXT = `Usage:
  node src/telegram-send.js --text "hello"
  node src/telegram-send.js --file /abs/path/to/message.txt
  node src/telegram-send.js --chat-id 123456789 --text "hello"
  printf '%s' "hello" | node src/telegram-send.js --stdin

Options:
  --chat-id <id>  Telegram target chat ID. Defaults to DEFAULT_TELEGRAM_TARGET_CHAT_ID, then the first ALLOWED_CHAT_IDS entry.
  --text <text>   Send literal text.
  --file <path>   Read message text from a file.
  --stdin         Read message text from stdin.
  --help          Show this help.`;

if (isMainModule(import.meta.url)) {
  loadEnvFile();
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const chatId = resolveDefaultChatId(options.chatId, process.env);
  const text = await resolveMessageText(options);

  const telegram = new TelegramClient(token);
  const result = await telegram.sendMessage(chatId, text);

  console.log(
    JSON.stringify(
      {
        ok: true,
        chatId,
        messageId: result.message_id,
      },
      null,
      2,
    ),
  );
}

export function parseArgs(argv) {
  const options = {
    chatId: null,
    text: null,
    filePath: null,
    stdin: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--chat-id":
        options.chatId = requireValue(argv, ++index, "--chat-id");
        break;
      case "--text":
        options.text = requireValue(argv, ++index, "--text");
        break;
      case "--file":
        options.filePath = requireValue(argv, ++index, "--file");
        break;
      case "--stdin":
        options.stdin = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const sources = [options.text !== null, options.filePath !== null, options.stdin].filter(Boolean);
  if (!options.help && sources.length !== 1) {
    throw new Error("Exactly one of --text, --file, or --stdin is required");
  }

  return options;
}

export function resolveDefaultChatId(explicitChatId, env) {
  if (explicitChatId) {
    return explicitChatId;
  }

  if (env.DEFAULT_TELEGRAM_TARGET_CHAT_ID) {
    return env.DEFAULT_TELEGRAM_TARGET_CHAT_ID;
  }

  const firstAllowedChatId = env.ALLOWED_CHAT_IDS?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)[0];

  if (firstAllowedChatId) {
    return firstAllowedChatId;
  }

  throw new Error(
    "No Telegram target chat ID found. Set DEFAULT_TELEGRAM_TARGET_CHAT_ID, ALLOWED_CHAT_IDS, or pass --chat-id.",
  );
}

async function resolveMessageText(options) {
  if (options.text !== null) {
    return requireNonEmptyText(options.text);
  }

  if (options.filePath !== null) {
    const fileText = await fs.readFile(options.filePath, "utf8");
    return requireNonEmptyText(fileText);
  }

  if (options.stdin) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    return requireNonEmptyText(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
  }

  throw new Error("A message source is required");
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function requireNonEmptyText(value) {
  const text = value.trim();
  if (!text) {
    throw new Error("Message text must not be empty");
  }

  return text;
}

function isMainModule(moduleUrl) {
  const entryPoint = process.argv[1];
  if (!entryPoint) {
    return false;
  }

  return moduleUrl === pathToFileURL(path.resolve(entryPoint)).href;
}
