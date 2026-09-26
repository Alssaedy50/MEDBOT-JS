/**
 * Healthcheck server tests.
 *
 * Hugging Face Spaces probes `$PORT` for a 200. These tests start the real
 * server on an ephemeral port, issue a real HTTP request against it, and assert
 * the status and body, so the container contract is exercised end to end rather
 * than through a stub.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PORT, HEALTH_TEXT, resolvePort, startHealthServer } from '../src/server.js';

const servers = [];

after(() => {
  for (const server of servers) server.close();
});

function start() {
  const server = startHealthServer({ port: 0, host: '127.0.0.1' });
  servers.push(server);
  return new Promise((resolve) => {
    server.once('listening', () => resolve(server));
  });
}

describe('resolvePort', () => {
  it('falls back to the Hugging Face default when unset or invalid', () => {
    assert.equal(resolvePort(undefined), DEFAULT_PORT);
    assert.equal(resolvePort(''), DEFAULT_PORT);
    assert.equal(resolvePort('not-a-port'), DEFAULT_PORT);
    assert.equal(resolvePort('0'), DEFAULT_PORT);
    assert.equal(resolvePort('99999'), DEFAULT_PORT);
  });

  it('honours a valid PORT override', () => {
    assert.equal(resolvePort('3000'), 3000);
    assert.equal(resolvePort('7860'), 7860);
  });
});

describe('healthcheck endpoint', () => {
  it('answers GET / with 200 and the health text', async () => {
    const server = await start();
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), HEALTH_TEXT);
  });

  it('answers an arbitrary probe path too', async () => {
    const server = await start();
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
  });
});
