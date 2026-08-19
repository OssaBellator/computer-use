import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpDownloadController } from '../src/browser/downloadController.js';

test('download controller requires an absolute root and forces GUID filenames', async () => {
  assert.throws(
    () => new CdpDownloadController({ on() {}, async send() { return {}; } }, { downloadPath: 'relative' }),
    /absolute path/,
  );
  const root = '/tmp/browser-download-controller-test';
  const listeners = new Map<string, (params: any) => void>();
  const calls: Array<[string, any]> = [];
  const session = {
    on(event: string, listener: (params: any) => void) { listeners.set(event, listener); },
    async send(method: string, params?: any) { calls.push([method, params]); return {}; },
  };
  const controller = new CdpDownloadController(session, { downloadPath: root });
  await controller.start();
  assert.deepEqual(calls.at(-1), ['Browser.setDownloadBehavior', {
    behavior: 'allowAndName', downloadPath: root, eventsEnabled: true,
  }]);

  listeners.get('Browser.downloadWillBegin')?.({
    guid: 'opaque-guid', url: 'https://secret.test/file', suggestedFilename: '../evil.txt',
  });
  listeners.get('Browser.downloadProgress')?.({
    guid: 'opaque-guid', state: 'completed', receivedBytes: 12, totalBytes: 12,
  });
  assert.deepEqual(controller.summary(), {
    total: 1, inProgress: 0, completed: 1, canceled: 0,
    latest: { guid: 'opaque-guid', state: 'completed', receivedBytes: 12, totalBytes: 12, sequence: 1 },
    latestCompleted: { guid: 'opaque-guid', state: 'completed', receivedBytes: 12, totalBytes: 12, sequence: 1 },
  });
  assert.equal(controller.completedPath('opaque-guid'), `${root}/opaque-guid`);
  assert.equal(JSON.stringify(controller.downloads()).includes('secret.test'), false);
  assert.equal(JSON.stringify(controller.downloads()).includes('evil.txt'), false);
});

test('download controller keeps active transfers when trimming terminal history', async () => {
  const root = '/tmp/browser-download-controller-trim-test';
  const listeners = new Map<string, (params: any) => void>();
  const session = {
    on(event: string, listener: (params: any) => void) { listeners.set(event, listener); },
    async send() { return {}; },
  };
  const controller = new CdpDownloadController(session, { downloadPath: root, maxTrackedDownloads: 1 });
  await controller.start();
  listeners.get('Browser.downloadWillBegin')?.({ guid: 'active' });
  listeners.get('Browser.downloadWillBegin')?.({ guid: 'done' });
  listeners.get('Browser.downloadProgress')?.({ guid: 'done', state: 'completed', receivedBytes: 1 });
  assert.equal(controller.downloads().some((item) => item.guid === 'active'), true);
});
