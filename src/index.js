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
 *
 * These are NOT a substitute for handling errors where they occur — the polling
 * loop already retries recoverable failures and every subsystem isolates its own
 * faults. They exist so that a genuinely unexpected throw is logged with a
 * non-secret message and the process shuts down *cleanly* (releasing the port and
 * the SQLite file) instead of dying in an undefined state that the host would
 * have to restart blindly.
 */
export function installProcessHandlers() {
  let handling = false;

  const shutdown = (reason, error) => {
    if (handling) return;
    handling = true;
    console.error(`[MEDBOT] ${reason}:`, error?.message ?? error);
    process.exitCode = 1;
    // Stop accepting probes, then let the event loop drain. A second signal or a
    // hung handle falls back to a hard exit so the host is never left waiting.
    setTimeout(() => process.exit(1), 5000).unref();
    process.kill(process.pid, 'SIGTERM');
  };

  process.on('uncaughtException', (error) => shutdown('UNCAUGHT_EXCEPTION', error));
  process.on('unhandledRejection', (reason) =>
    shutdown('UNHANDLED_REJECTION', reason instanceof Error ? reason : new Error(String(reason))),
  );
}

// Only a real `node src/index.js` invocation boots the process and installs the
// global handlers; importing the module (tests) must have no side effects.
if (import.meta.url === `file://${process.argv[1]}`) {
  installProcessHandlers();
  startApp();
}

export { createBot, startHealthServer };
