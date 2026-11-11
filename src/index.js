/**
 * MEDBOT entry point: `npm start` / `node src/index.js` AND Vercel Node.js Framework Preset.
 *
 * Two independent concerns start here when run as a standalone CLI/container process:
 * the container healthcheck server (so Hugging Face Spaces / Render / Cloud Run sees a
 * healthy HTTP endpoint) and the Telegram long-poll loop.
 *
 * When imported by Vercel's Node.js Framework Preset (`"main": "src/index.js"`), this
 * module has zero side effects on import and exports the universal serverless HTTP
 * handler (`export default vercelHandler`) so Vercel never fails with
 * `500 FUNCTION_INVOCATION_FAILED`.
 */

import 'dotenv/config';

import vercelHandler from '../api/index.js';
import { createBot, runBot } from './telegram/bot.js';
import { startHealthServer } from './server.js';

/**
 * Boot MEDBOT: start the health server, then run the Telegram long-poll loop.
 *
 * The two concerns are independent by design — the HTTP listener serves the
 * host's health probe while polling continues regardless of inbound requests —
 * and the server is started first so a slow probe can never delay the bot.
 *
 * Returns `{ healthServer, done }` so the caller (and tests) can observe or stop
 * the process without a signal. A missing token is a fatal configuration error,
 * reported and surfaced as a non-zero exit code rather than a silent no-op.
 */
export function startApp({ token: botToken = process.env.BOT_TOKEN } = {}) {
  const startedAt = Date.now();
  console.log(`[MEDBOT] STARTUP pid=${process.pid} node=${process.version}`);

  if (!botToken) {
    console.error(
      'BOT_TOKEN is not set. Copy .env.example to .env and add your Telegram bot token.',
    );
    process.exitCode = 1;
    return { healthServer: null, done: Promise.resolve() };
  }

  const healthServer = startHealthServer({
    onListening: (port) => console.log(`[MEDBOT] HTTP_LISTENING port=${port}`),
  });

  const done = runBot({ token: botToken })
    .catch((error) => {
      // A fatal startup error is a real failure: report it and mark the exit
      // code, but let the graceful-shutdown path below release the port.
      console.error('[MEDBOT] FATAL startup error:', error?.message ?? error);
      process.exitCode = 1;
    })
    .finally(() => {
      healthServer.close();
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`[MEDBOT] SHUTDOWN uptime=${seconds}s`);
    });

  return { healthServer, done };
}

/**
 * Install the last-resort process handlers.
 */
export function installProcessHandlers() {
  let handling = false;

  const shutdown = (reason, error) => {
    if (handling) return;
    handling = true;
    console.error(`[MEDBOT] ${reason}:`, error?.message ?? error);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 5000).unref();
    process.kill(process.pid, 'SIGTERM');
  };

  process.on('uncaughtException', (error) => shutdown('UNCAUGHT_EXCEPTION', error));
  process.on('unhandledRejection', (reason) =>
    shutdown('UNHANDLED_REJECTION', reason instanceof Error ? reason : new Error(String(reason))),
  );
}

// Only a real `node src/index.js` invocation (outside Vercel serverless) boots the
// persistent HTTP server and polling loop; importing the module (tests or Vercel)
// has no side effects.
if (import.meta.url === `file://${process.argv[1]}` && !process.env.VERCEL) {
  installProcessHandlers();
  if (process.env.BOT_TOKEN) {
    startApp();
  } else {
    console.warn(
      'BOT_TOKEN is not set. Starting HTTP health server in standalone mode until BOT_TOKEN is configured.',
    );
    startHealthServer({
      onListening: (port) => console.log(`[MEDBOT] HTTP_LISTENING port=${port}`),
    });
  }
}

export default vercelHandler;
export {
  createBot,
  startHealthServer,
  vercelHandler as fetch,
  vercelHandler as GET,
  vercelHandler as POST,
  vercelHandler as PUT,
  vercelHandler as DELETE,
  vercelHandler as OPTIONS,
};
