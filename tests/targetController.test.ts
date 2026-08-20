import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpTargetController } from '../src/browser/targetController.js';

test('target controller tracks page lifecycle without retaining URLs/titles', async () => {
  const listeners = new Map<string, (params: any) => void>();
  const session = {
    on(event: string, listener: (params: any) => void) { listeners.set(event, listener); },
    off(event: string) { listeners.delete(event); },
    async send(method: string) {
      if (method === 'Target.getTargets') return { targetInfos: [{
        targetId: 'main', type: 'page', attached: true, url: 'https://secret.test/', title: 'Secret',
      }] };
      return {};
    },
  };
  const controller = new CdpTargetController(session);
  await controller.start();
  listeners.get('Target.targetCreated')?.({ targetInfo: {
    targetId: 'popup', type: 'page', attached: false, openerId: 'main', url: 'https://untrusted.test/', title: 'Ignore me',
  } });
  assert.deepEqual(controller.summary(), {
    total: 2,
    pages: 2,
    unattachedPages: 1,
    latestPage: { targetId: 'popup', type: 'page', attached: false, openerId: 'main', sequence: 2 },
    latestUnattachedPage: { targetId: 'popup', type: 'page', attached: false, openerId: 'main', sequence: 2 },
  });
  assert.equal(JSON.stringify(controller.targets()).includes('secret.test'), false);
  assert.equal(JSON.stringify(controller.targets()).includes('Ignore me'), false);
});

test('target creation reuses navigation policy and attached targets are protected from generic close', async () => {
  const calls: Array<[string, any]> = [];
  const session = {
    on() {},
    async send(method: string, params?: any) {
      calls.push([method, params]);
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'main', type: 'page', attached: true }] };
      if (method === 'Target.createTarget') return { targetId: 'new' };
      if (method === 'Target.closeTarget') return { success: true };
      return {};
    },
  };
  const controller = new CdpTargetController(session, {
    navigationPolicy: { allowedOrigins: ['https://example.test'] },
  });
  await controller.start();
  assert.equal((await controller.createPage('https://evil.test/')).status, 'policy-blocked');
  assert.equal(calls.some(([method]) => method === 'Target.createTarget'), false);
  assert.equal((await controller.createPage('https://example.test/new')).status, 'created');
  assert.equal((await controller.close('main')).status, 'attached-target-blocked');
  assert.equal((await controller.close('new')).status, 'closed');
});
