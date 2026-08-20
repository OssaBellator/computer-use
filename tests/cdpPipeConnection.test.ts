import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  CdpPipeConnection,
  CdpProtocolError,
} from '../src/runtime/cdpPipeConnection.js';

function harness(options: ConstructorParameters<typeof CdpPipeConnection>[2] = {}) {
  const browserToClient = new PassThrough();
  const clientToBrowser = new PassThrough();
  const connection = new CdpPipeConnection(browserToClient, clientToBrowser, options);
  const outbound: any[] = [];
  let buffer = Buffer.alloc(0);
  clientToBrowser.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const boundary = buffer.indexOf(0);
      if (boundary < 0) break;
      const frame = buffer.subarray(0, boundary);
      buffer = buffer.subarray(boundary + 1);
      if (frame.length) outbound.push(JSON.parse(frame.toString('utf8')));
    }
  });
  const inbound = (message: any, split?: number) => {
    const frame = Buffer.from(`${JSON.stringify(message)}\0`);
    if (split !== undefined) {
      browserToClient.write(frame.subarray(0, split));
      browserToClient.write(frame.subarray(split));
    } else {
      browserToClient.write(frame);
    }
  };
  return { connection, outbound, inbound, browserToClient };
}

test('CDP pipe frames commands and routes flattened-session responses/events', async () => {
  const h = harness();
  const events: unknown[] = [];
  h.connection.on('Runtime.consoleAPICalled', (params, sessionId) => {
    events.push([params.type, sessionId]);
  });

  const pending = h.connection.send(
    'Runtime.evaluate',
    { expression: '1+1' },
    'session-1',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.outbound[0], {
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: '1+1' },
    sessionId: 'session-1',
  });

  h.inbound({
    method: 'Runtime.consoleAPICalled',
    params: { type: 'log' },
    sessionId: 'session-1',
  }, 7);
  h.inbound({
    id: 1,
    result: { result: { value: 2 } },
    sessionId: 'session-1',
  });

  assert.deepEqual(await pending, { result: { value: 2 } });
  assert.deepEqual(events, [['log', 'session-1']]);
});

test('CDP protocol errors preserve method, code, and data', async () => {
  const h = harness();
  const pending = h.connection.send('Page.navigate');
  await new Promise((resolve) => setImmediate(resolve));
  h.inbound({
    id: 1,
    error: { code: -32000, message: 'bad', data: { why: 1 } },
  });

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof CdpProtocolError &&
      error.method === 'Page.navigate' &&
      error.code === -32000 &&
      (error.data as { why?: number }).why === 1,
  );
});

test('oversized inbound data fails closed and rejects pending work', async () => {
  const h = harness({ maxMessageBytes: 32 });
  const pending = h.connection.send('A');
  h.browserToClient.write(Buffer.alloc(33, 65));
  await assert.rejects(pending, /maxMessageBytes/);
  assert.equal(h.connection.closed, true);
});

test('pending command budget rejects before another command is written', async () => {
  const h = harness({ maxPendingCommands: 1, commandTimeoutMs: 0 });
  const first = h.connection.send('First');
  await assert.rejects(h.connection.send('Second'), /pending command limit/);
  h.inbound({ id: 1, result: {} });
  await first;
  assert.equal(h.outbound.length, 1);
});

test('event listener exceptions are isolated from transport state', async () => {
  const errors: string[] = [];
  const h = harness({
    onListenerError: (error, method) => errors.push(`${method}:${String(error)}`),
  });
  h.connection.on('X.event', () => {
    throw new Error('listener failed');
  });
  h.inbound({ method: 'X.event', params: {} });

  const pending = h.connection.send('Still.alive');
  await new Promise((resolve) => setImmediate(resolve));
  h.inbound({ id: 1, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(errors.length, 1);
});
