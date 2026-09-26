/**
 * Container healthcheck HTTP server.
 *
 * Hugging Face Spaces (Docker SDK) expects the container to answer an HTTP
 * request on `$PORT` (7860 by default); a process that only long-polls Telegram
 * is otherwise reported as unhealthy and restarted. This tiny native `http`
 * server exists solely to satisfy that probe, so it is deliberately independent
 * of the bot: it holds no state, never touches the database, and a request can
 * never throw into the polling loop.
 *
 * It binds to `0.0.0.0` because the healthcheck reaches the container from
 * outside its network namespace — `127.0.0.1` would be unreachable.
 */

import http from 'node:http';

export const DEFAULT_PORT = 7860;
export const HEALTH_TEXT = 'MEDBOT is active and running';
/** Health check path a host should be pointed at (see `render.yaml`). */
export const HEALTH_PATH = '/health';

/** Resolve the listen port: `PORT` when valid, else the container default. */
export function resolvePort(value = process.env.PORT) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
}

/**
 * The lightweight health payload. Never contains a secret, a token, a database
 * path or an environment value: only liveness and process uptime.
 */
export function healthPayload() {
  return { status: 'ok', uptime_seconds: Math.floor(process.uptime()) };
}

/**
 * Start the healthcheck server.
 *
 * `GET /health` answers 200 with a small JSON liveness body; any other path
 * answers 200 with `HEALTH_TEXT`, so a probe pointed at `/` (the earlier
 * Hugging Face contract) keeps working. Returns the `http.Server` so the caller
 * (and tests) can close it, and calls `onListening(port)` once bound so the
 * startup lifecycle can log the real port.
 */
export function startHealthServer({
  port = resolvePort(),
  host = '0.0.0.0',
  onListening = null,
} = {}) {
  const server = http.createServer((request, response) => {
    const path = String(request.url ?? '/').split('?')[0];

    if (path === HEALTH_PATH) {
      const body = JSON.stringify(healthPayload());
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
      return;
    }

    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(HEALTH_TEXT);
  });

  // A failed bind (port in use, permission denied) must surface as a log line,
  // not an unhandled 'error' event that takes the whole process down with it.
  server.on('error', (error) => {
    console.error('Healthcheck server error:', error.message ?? error);
  });

  server.listen(port, host, () => {
    const bound = server.address()?.port ?? port;
    console.log(`MEDBOT healthcheck listening on http://${host}:${bound}`);
    if (typeof onListening === 'function') onListening(bound);
  });

  return server;
}
