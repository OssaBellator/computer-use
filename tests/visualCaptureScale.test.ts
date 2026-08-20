import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpVisualObserver } from '../src/browser/visualObserver.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S8AAAAASUVORK5CYII=';

class Session {
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  async send(method: string, params: Record<string, unknown> = {}) {
    this.calls.push([method, params]);
    return { data: PNG };
  }
}

test('clipped visual capture forwards an explicit downscale to Chromium', async () => {
  const session = new Session();
  await new CdpVisualObserver(session).capture({
    clip: { x: 10, y: 20, width: 200, height: 100 },
    scale: 0.25,
  });
  assert.equal(session.calls[0][0], 'Page.captureScreenshot');
  assert.deepEqual(session.calls[0][1].clip, {
    x: 10, y: 20, width: 200, height: 100, scale: 0.25,
  });
});

test('visual capture rejects scale without a clip or scale above one', async () => {
  const observer = new CdpVisualObserver(new Session());
  await assert.rejects(() => observer.capture({ scale: 0.5 }), /scale requires clip/);
  await assert.rejects(() => observer.capture({
    clip: { x: 0, y: 0, width: 10, height: 10 },
    scale: 1.1,
  }), /scale must be in/);
});
