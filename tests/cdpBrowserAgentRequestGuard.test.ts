import test from 'node:test';
import assert from 'node:assert/strict';
import { createCdpBrowserAgentEngine } from '../src/engine/cdpBrowserAgentEngine.js';

function page() {
  return { frames: () => [] };
}

function eventSession() {
  const listeners = new Map<string, Set<(params: any) => void>>();
  return {
    async send() { return {}; },
    on(event: string, listener: (params: any) => void) {
      let set = listeners.get(event);
      if (!set) { set = new Set(); listeners.set(event, set); }
      set.add(listener);
    },
    off(event: string, listener: (params: any) => void) {
      listeners.get(event)?.delete(listener);
    },
  };
}

test('browser-agent factory installs request-boundary guard when navigation policy is configured', () => {
  const session = eventSession();
  const engine = createCdpBrowserAgentEngine(page(), session, {
    navigationPolicy: { allowedOrigins: ['https://allowed.example'] },
  });
  assert.ok(engine.navigationGuard);
  assert.deepEqual(engine.navigationGuard.policy.allowedOrigins, ['https://allowed.example']);
});

test('request-boundary guard can be explicitly disabled without disabling explicit navigation policy', () => {
  const session = eventSession();
  const engine = createCdpBrowserAgentEngine(page(), session, {
    navigationPolicy: { allowedOrigins: ['https://allowed.example'] },
    enforceNavigationPolicyAtRequestBoundary: false,
  });
  assert.equal(engine.navigationGuard, undefined);
  assert.deepEqual(
    (engine.navigator as { policy?: { allowedOrigins?: readonly string[] } }).policy?.allowedOrigins,
    ['https://allowed.example'],
  );
});

test('no navigation policy leaves Fetch interception off by default', () => {
  const engine = createCdpBrowserAgentEngine(page(), eventSession());
  assert.equal(engine.navigationGuard, undefined);
});

test('request-boundary enforcement can be explicitly enabled with the default navigation policy', () => {
  const engine = createCdpBrowserAgentEngine(page(), eventSession(), {
    enforceNavigationPolicyAtRequestBoundary: true,
  });
  assert.ok(engine.navigationGuard);
});
