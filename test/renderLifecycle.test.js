/**
 * Render / process-lifecycle tests.
 *
 * Covers the reliability contract added for Render:
 *   * the health server starts independently and answers `GET /health` with 200;
 *   * it uses `process.env.PORT`;
 *   * it never exposes a secret;
 *   * Telegram polling starts exactly once, survives a recoverable failure, and
 *     is independent of inbound HTTP;
 *   * shutdown is graceful and the lifecycle is logged.
 *
 * No live Telegram, PubMed or AI provider is contacted.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PORT, HEALTH_PATH, healthPayload, resolvePort, startHealthServer } from '../src/server.js';
import { cleanupDb, FakeBot, freshDb } from './helpers/harness.js';

let dbPath;
let botModule;
let adapter;

const servers = [];

before(async () => {
  dbPath = freshDb('render-lifecycle');
  botModule = await import('../src/telegram/bot.js');
  adapter = await import('../src/telegram/adapter.js');
});

after(() => {
  for (const server of servers) server.close();
  cleanupDb(dbPath);
});

/** Start the real health server on an ephemeral port and await the bind. */
function start(extra = {}) {
  const server = startHealthServer({ port: 0, host: '127.0.0.1', ...extra });
  servers.push(server);
  return new Promise((resolve) => server.once('listening', () => resolve(server)));
}

// ---------------------------------------------------------------------------
// 19-22: HTTP server, /health, PORT, no secret exposure
// ---------------------------------------------------------------------------
describe('HTTP health server', () => {
  it('starts independently and answers GET /health with 200 JSON', async () => {
    const server = await start();
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);

    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime_seconds, 'number');
  });

  it('keeps the legacy root probe working (200 text)', async () => {
    const server = await start();
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
  });

  it('never exposes a secret in the health response', async () => {
    process.env.BOT_TOKEN = 'super-secret-token-value';
    process.env.GROQ_API_KEY = 'secret-groq-key';
    try {
      const server = await start();
      const { port } = server.address();
      const raw = await (await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`)).text();
      assert.doesNotMatch(raw, /super-secret-token-value/);
      assert.doesNotMatch(raw, /secret-groq-key/);
      assert.doesNotMatch(raw, /BOT_TOKEN|GROQ_API_KEY/);
      // The payload is intentionally tiny and has no env-derived fields.
      assert.deepEqual(Object.keys(healthPayload()).sort(), ['status', 'uptime_seconds']);
    } finally {
      delete process.env.BOT_TOKEN;
      delete process.env.GROQ_API_KEY;
    }
  });

  it('uses process.env.PORT with a safe local fallback', () => {
    assert.equal(resolvePort('10000'), 10000);
    assert.equal(resolvePort('7860'), 7860);
    assert.equal(resolvePort(undefined), DEFAULT_PORT);
    assert.equal(resolvePort('not-a-port'), DEFAULT_PORT);
    assert.equal(resolvePort('0'), DEFAULT_PORT);
  });

  it('invokes onListening with the bound port', async () => {
    let seen = null;
    await start({ onListening: (port) => { seen = port; } });
    assert.equal(typeof seen, 'number');
    assert.ok(seen > 0);
  });
});

// ---------------------------------------------------------------------------
// 23-25: Telegram polling lifecycle
// ---------------------------------------------------------------------------
describe('Telegram polling lifecycle', () => {
  it('starts polling independently of any HTTP request', async () => {
    const seen = [];
    const transport = {
      async getMe() { return { id: 1, username: 'medbot' }; },
      async getUpdates(offset) {
        seen.push(offset);
        return [];
      },
      async sendMessage() { return { message_id: 1 }; },
      async editMessageText() { return { message_id: 1 }; },
      async answerCallbackQuery() { return true; },
      async setMyCommands() { return true; },
    };

    // Polling is driven by the loop itself; no HTTP request is issued here.
    let rounds = 0;
    await adapter.pollUpdates(transport, { shouldStop: () => rounds++ > 2 });
    assert.ok(seen.length >= 3, 'the poll loop ran without any inbound request');
  });

  it('retries a recoverable polling failure with controlled backoff', async () => {
    let calls = 0;
    const errors = [];
    const retries = [];
    const transport = {
      async getUpdates() {
        calls += 1;
        if (calls <= 2) throw new Error('network blip');
        return [];
      },
    };

    await adapter.pollUpdates(transport, {
      shouldStop: () => calls >= 4,
      onError: (error) => errors.push(error.message),
      onRetry: (error, waitSeconds) => retries.push(waitSeconds),
    });

    assert.equal(errors.length, 2, 'each failure is reported, never swallowed');
    assert.deepEqual(retries, [1, 2], 'backoff grows 1s → 2s, capped');
    assert.ok(calls >= 4, 'polling resumed after each failure');
  });

  it('does not start a duplicate polling loop', async () => {
    const transport = new FakeBot();
    transport.getMe = async () => ({ id: 1, username: 'medbot' });
    transport.getUpdates = async () => {
      // Yield so the loop is genuinely in flight when the second call is made.
      await new Promise((resolve) => setTimeout(resolve, 2));
      return [];
    };
    transport.setMyCommands = async () => true;

    let stop = false;
    const first = botModule.runBot({ token: 'test-token', transport, shouldStop: () => stop });
    const second = botModule.runBot({ token: 'test-token', transport, shouldStop: () => stop });

    // `runBot` is synchronous, so a second call returns the exact same loop.
    assert.equal(second, first, 'a second call returns the in-flight loop');

    stop = true;
    await first;
    // Once the loop has ended, a fresh call may start a new one.
    assert.notEqual(botModule.runBot({ token: 'test-token', transport, shouldStop: () => true }), first);
  });

  it('logs the polling lifecycle without leaking the token', async () => {
    const lines = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args) => lines.push(args.join(' '));
    console.warn = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));

    const transport = new FakeBot();
    let calls = 0;
    transport.getMe = async () => ({ id: 1, username: 'medbot' });
    transport.getUpdates = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient blip');
      return [];
    };
    transport.setMyCommands = async () => true;

    try {
      // The retry path sleeps for the backoff, so the loop is bounded by `calls`.
      await botModule.runBot({
        token: 'test-token-abcdefghijklmnop',
        transport,
        shouldStop: () => calls >= 3,
      });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }

    const joined = lines.join('\n');
    assert.match(joined, /TELEGRAM_POLLING_STARTED/);
    assert.match(joined, /TELEGRAM_POLLING_STOPPED/);
    assert.match(joined, /TELEGRAM_POLLING_ERROR/);
    assert.match(joined, /TELEGRAM_POLLING_RETRY/);
    assert.doesNotMatch(joined, /test-token-abcdefghijklmnop/, 'the token must never be logged');
  });

  it('redacts a token that appears inside an error message', () => {
    const error = new Error('getUpdates failed (0): network error for bot123456789:ABCDEF');
    const safe = botModule.safeErrorMessage(error);
    assert.doesNotMatch(safe, /bot123456789:ABCDEF/);
    assert.match(safe, /bot<redacted>/);
  });
});

// ---------------------------------------------------------------------------
// Process entry point: no import side effects, clean lifecycle
// ---------------------------------------------------------------------------
describe('process entry point', () => {
  it('has no side effects when imported (no listeners installed on import)', async () => {
    const before = {
      uncaught: process.listenerCount('uncaughtException'),
      rejection: process.listenerCount('unhandledRejection'),
    };

    await import('../src/index.js');

    assert.equal(process.listenerCount('uncaughtException'), before.uncaught);
    assert.equal(process.listenerCount('unhandledRejection'), before.rejection);
  });

  it('reports a missing token as a fatal config error without starting the bot', async () => {
    const index = await import('../src/index.js');
    const lines = [];
    const originalError = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      const { healthServer, done } = index.startApp({ token: null });
      await done;
      assert.equal(healthServer, null, 'no health server without a token');
      assert.equal(process.exitCode, 1, 'a missing token is a non-zero exit');
      assert.match(lines.join('\n'), /BOT_TOKEN is not set/);
    } finally {
      console.error = originalError;
      process.exitCode = 0;
    }
  });

  it('registers exactly one handler for each fatal process event', async () => {
    const index = await import('../src/index.js');
    const beforeUncaught = process.listenerCount('uncaughtException');
    const beforeRejection = process.listenerCount('unhandledRejection');

    index.installProcessHandlers();

    assert.equal(process.listenerCount('uncaughtException'), beforeUncaught + 1);
    assert.equal(process.listenerCount('unhandledRejection'), beforeRejection + 1);

    // Clean up the handlers this test installed so later tests are unaffected.
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });
});

// ---------------------------------------------------------------------------
// 26: graceful shutdown
// ---------------------------------------------------------------------------
describe('graceful shutdown', () => {
  it('stops the polling loop when the signal flag is set', async () => {
    const transport = {
      async getUpdates() { return []; },
    };
    let stopping = false;

    const loop = adapter.pollUpdates(transport, {
      shouldStop: () => stopping,
      onError: () => {},
    });

    stopping = true;
    const offset = await loop;
    assert.equal(offset, 0, 'the loop returned cleanly on shutdown');
  });

  it('closes the health server without leaving the port bound', async () => {
    const server = await start();
    const { port } = server.address();

    await new Promise((resolve) => server.close(resolve));

    // The port is free again: a fresh bind on the same port succeeds.
    const rebound = startHealthServer({ port, host: '127.0.0.1' });
    servers.push(rebound);
    await new Promise((resolve, reject) => {
      rebound.once('listening', resolve);
      rebound.once('error', reject);
    });
    assert.ok(rebound.listening);
  });

  it('bounds the drain so a slow in-flight poll cannot outlive the host grace window', () => {
    // The transport's long poll can take up to 40s, but a host SIGKILLs sooner;
    // the drain timer must therefore fire well within that window.
    assert.ok(botModule.SHUTDOWN_DRAIN_GRACE_MS > 0);
    assert.ok(
      botModule.SHUTDOWN_DRAIN_GRACE_MS < 30000,
      'the drain must finish before a typical 30s SIGKILL grace',
    );
  });
});
