/**
 * MEDBOT entry point: `npm start` / `node src/index.js`.
 */

import 'dotenv/config';

import { createBot, runBot } from './telegram/bot.js';

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error(
    'BOT_TOKEN is not set. Copy .env.example to .env and add your Telegram bot token.',
  );
  process.exit(1);
}

runBot({ token }).catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});

export { createBot };
