import { loadEnvFile } from "./config.js";
import { TelegramClient } from "./telegram.js";

loadEnvFile();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

const telegram = new TelegramClient(token);
const command = process.argv[2];

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  switch (command) {
    case "me":
      printJson(await telegram.getMe());
      return;
    case "webhook-info":
      printJson(await telegram.getWebhookInfo());
      return;
    case "delete-webhook":
      printJson(await telegram.deleteWebhook());
      return;
    case "updates":
      printJson(
        await telegram.getUpdates({
          timeoutSeconds: 1,
        }),
      );
      return;
    default:
      console.error(
        "Usage: node src/telegram-tools.js <me|webhook-info|delete-webhook|updates>",
      );
      process.exitCode = 1;
  }
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
