/**
 * MEDBOT entry point: `npm start` / `node src/index.js`.
 *
 * Two independent concerns start here: the container healthcheck server (so
 * Hugging Face Spaces sees a healthy HTTP endpoint) and the Telegram long-poll
 * loop. The server is started first and is never awaited, so a bind failure or a
 * slow probe can neither delay nor block the bot.
 */

import 'dotenv/config';

import { createBot, runBot } from './telegram/bot.js';
import { startHealthServer } from './server.js';

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error(
    'BOT_TOKEN is not set. Copy .env.example to .env and add your Telegram bot token.',
  );
  process.exit(1);
}

const healthServer = startHealthServer();

runBot({ token })
  .catch((error) => {
    console.error('Fatal startup error:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    // The bot has stopped (signal or fatal error): release the port so the
    // container can exit cleanly instead of lingering on the open socket.
    healthServer.close();
  });

export { createBot, startHealthServer };
