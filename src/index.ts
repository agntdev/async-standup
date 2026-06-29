import { buildBot } from "./bot.js";
import { setDefaultCommands } from "./toolkit/index.js";
import { startScheduler } from "./handlers/standup.js";

async function main() {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    console.error("BOT_TOKEN is required");
    process.exit(1);
  }
  const bot = await buildBot(token);

  // Start the standup scheduler — it uses the bot's api to send messages
  startScheduler(() => bot.api);

  // Publish the "/" command list to Telegram (discoverability).
  await setDefaultCommands(bot);
  bot.start();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
