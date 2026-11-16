import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientNetworkError, NetworkErrorBudget } from '../src/network-errors.js';

function withStack(message: string, frames: string[], code?: string): Error {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.stack = [`Error: ${message}`, ...frames.map((f) => `    at ${f}`)].join('\n');
  if (code) error.code = code;
  return error;
}

test('library network errors seen in production are survivable', () => {
  // Stacks copied from a real service log.
  assert.equal(
    isTransientNetworkError(
      withStack('socket hang up', [
        'TLSSocket.socketOnEnd (node:_http_client:599:25)',
        'TLSSocket.emit (node:events:531:35)',
      ]),
    ),
    true,
  );
  assert.equal(
    isTransientNetworkError(
      withStack('Opening handshake has timed out', [
        'ClientRequest.<anonymous> (/x/app/node_modules/ws/lib/websocket.js:890:7)',
        'Socket._onTimeout (node:net:604:8)',
      ]),
    ),
    true,
  );
  assert.equal(
    isTransientNetworkError(withStack('read failed', ['TCP.onStreamRead (node:x)'], 'ECONNRESET')),
    true,
  );
});

test('errors from Clawstrum code or unknown errors still stop the daemon', () => {
  assert.equal(
    isTransientNetworkError(
      withStack('socket hang up', ['Engine.tick (/x/app/dist/engine.js:10:2)']),
    ),
    false,
  );
  assert.equal(
    isTransientNetworkError(withStack('x is not a function', ['TLSSocket.emit (node:events:1:1)'])),
    false,
  );
  assert.equal(isTransientNetworkError('socket hang up'), false);
});

test('a burst of network errors exhausts the budget', () => {
  const budget = new NetworkErrorBudget(3, 1000);
  assert.deepEqual(
    [0, 10, 20, 30].map((t) => budget.allow(t)),
    [true, true, true, false],
  );
  assert.equal(budget.allow(2000), true);
});
