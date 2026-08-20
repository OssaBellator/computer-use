import test from 'node:test';
import assert from 'node:assert/strict';
import { observePermissionState } from '../src/browser/permissionState.js';

test('permission observer distinguishes page-effective, policy, custom-policy, and unknown browser-level state', async () => {
  const calls: string[] = [];
  const session = {
    async send(method: string): Promise<any> {
      calls.push(method);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.getPermissionsPolicyState') {
        return { states: [
          { feature: 'camera', allowed: false, locator: { frameId: 'main', blockReason: 'Header' } },
          { feature: 'microphone', allowed: true },
          { feature: 'geolocation', allowed: true },
          { feature: 'clipboard-read', allowed: true },
          { feature: 'clipboard-write', allowed: true },
          { feature: 'midi', allowed: false, locator: { frameId: 'main', blockReason: 'Header' } },
        ] };
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 3 };
      if (method === 'Runtime.evaluate') {
        return { result: { value: {
          origin: 'https://fixture.invalid', secureContext: true, apiAvailable: true,
          results: [
            { name: 'camera', state: 'prompt' },
            { name: 'microphone', state: 'granted' },
            { name: 'notifications', state: 'denied' },
            { name: 'geolocation', state: 'prompt' },
            { name: 'clipboard-read', state: 'prompt' },
            { name: 'clipboard-write', state: 'granted' },
            { name: 'midi', state: 'prompt' },
          ],
        } } };
      }
      throw new Error(`Unexpected ${method}`);
    },
  };

  const snapshot = await observePermissionState(session, {
    permissions: ['camera', 'microphone', 'notifications', 'geolocation', 'clipboard-read', 'clipboard-write', 'midi'],
  });
  const permissions = new Map(snapshot.frames[0].permissions.map((permission) => [permission.name, permission]));
  assert.equal(permissions.get('camera')?.pageState, 'prompt');
  assert.equal(permissions.get('camera')?.policy.state, 'blocked');
  assert.equal(permissions.get('camera')?.state, 'denied');
  assert.equal(permissions.get('camera')?.browserState, 'unknown');
  assert.equal(permissions.get('microphone')?.state, 'granted');
  assert.equal(permissions.get('notifications')?.policy.state, 'not-applicable');
  assert.equal(permissions.get('midi')?.policy.state, 'blocked');
  assert.equal(permissions.get('midi')?.state, 'denied');
  assert.equal(calls.includes('Browser.setPermission'), false);
  assert.equal(calls.includes('Browser.grantPermissions'), false);
  assert.equal(calls.includes('Browser.resetPermissions'), false);
});

test('permission observer bounds requested names and reports unsupported queries as unknown', async () => {
  const session = {
    async send(method: string): Promise<any> {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.getPermissionsPolicyState') throw new Error('Method not found');
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 3 };
      if (method === 'Runtime.evaluate') {
        return { result: { value: {
          origin: 'http://example.test', secureContext: false, apiAvailable: true,
          results: [{ name: 'camera', state: 'unknown', error: 'unsupported descriptor' }],
        } } };
      }
      throw new Error(`Unexpected ${method}`);
    },
  };
  const snapshot = await observePermissionState(session, {
    permissions: ['camera', 'camera', 'x'.repeat(500), 'made-up'],
    maxPermissions: 1,
    maxTextLength: 64,
  });
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.frames[0].permissions.length, 1);
  assert.equal(snapshot.frames[0].permissions[0].name, 'camera');
  assert.equal(snapshot.frames[0].permissions[0].state, 'unknown');
  assert.equal(snapshot.frames[0].permissions[0].errorText, 'unsupported descriptor');
  assert.equal(snapshot.errors[0].scope, 'permissions-policy');
  assert.equal(JSON.stringify(snapshot).includes('x'.repeat(100)), false);
});

test('permission observer marks the snapshot truncated when bounded frame errors are dropped', async () => {
  const session = {
    async send(method: string): Promise<any> {
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'child' } }] } };
      }
      if (method === 'Page.getPermissionsPolicyState') throw new Error('policy unavailable');
      if (method === 'Page.createIsolatedWorld') throw new Error('frame unavailable');
      throw new Error(`Unexpected ${method}`);
    },
  };
  const snapshot = await observePermissionState(session, { permissions: ['camera'], maxErrors: 1 });
  assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.frames.length, 2);
  assert.equal(snapshot.frames.every((frame) => frame.permissions[0].state === 'unknown'), true);
});
