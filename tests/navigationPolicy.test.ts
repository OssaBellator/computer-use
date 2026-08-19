import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpNavigationController } from '../src/browser/navigationController.js';

function state(url: string, timeOrigin: number) {
  return { result: { value: {
    url, origin: new URL(url).origin, title: '', readyState: 'complete', historyLength: 2, timeOrigin,
  } } };
}

test('navigation policy blocks non-allowlisted origins and URL credentials before dispatch', async () => {
  let navigateCalls = 0;
  const session = { async send(method: string) { if (method === 'Page.navigate') navigateCalls += 1; return {}; } };
  const controller = new CdpNavigationController(session, { allowedOrigins: ['https://example.test'] });
  const originBlocked = await controller.navigate('https://evil.test/path');
  assert.equal(originBlocked.status, 'policy-blocked');
  const credentialsBlocked = await controller.navigate('https://user:pass@example.test/private');
  assert.equal(credentialsBlocked.status, 'policy-blocked');
  assert.equal(navigateCalls, 0);
});

test('data navigation is disabled by default and can be explicitly enabled', async () => {
  const calls: string[] = [];
  const states = [state('about:blank', 1000), state('data:text/plain,ok', 2000)];
  const session = { async send(method: string) {
    calls.push(method);
    if (method === 'Runtime.evaluate') return states.shift();
    return { frameId: 'main' };
  } };
  const blocked = await new CdpNavigationController(session).navigate('data:text/plain,ok');
  assert.equal(blocked.status, 'policy-blocked');
  assert.equal(calls.includes('Page.navigate'), false);

  const allowed = await new CdpNavigationController(session, { allowData: true }).navigate(
    'data:text/plain,ok', { pollIntervalMs: 0, maxPolls: 2 },
  );
  assert.equal(allowed.status, 'navigated');
});

test('final redirect origin is checked against the same allowlist', async () => {
  const states = [state('https://example.test/start', 1000), state('https://evil.test/redirected', 2000)];
  const session = { async send(method: string) {
    if (method === 'Runtime.evaluate') return states.shift();
    return { frameId: 'main', loaderId: 'loader' };
  } };
  const result = await new CdpNavigationController(session, {
    allowedOrigins: ['https://example.test'],
  }).navigate('https://example.test/redirect-me', { pollIntervalMs: 0, maxPolls: 2 });
  assert.equal(result.status, 'policy-blocked');
  assert.match(result.policyReason ?? '', /final URL blocked/);
  assert.equal(result.after?.url, 'https://evil.test/redirected');
});

test('navigation allowlist entries must be exact origins', () => {
  assert.throws(
    () => new CdpNavigationController({ async send() { return {}; } }, {
      allowedOrigins: ['https://example.test/path'],
    }),
    /must be origins/,
  );
});
