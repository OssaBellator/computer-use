import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpVisualObserver } from '../src/browser/visualObserver.js';

const PNG_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2S8AAAAASUVORK5CYII=';
const PNG_B = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

class Session {
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  constructor(private readonly screenshots: string[]) {}
  async send(method: string, params: Record<string, unknown> = {}) {
    this.calls.push([method, params]);
    if (method === 'Page.captureScreenshot') return { data: this.screenshots.shift() ?? PNG_A };
    return {};
  }
}

test('visual observer captures bounded PNG bytes with dimensions and fingerprint', async () => {
  const session = new Session([PNG_A]);
  const snapshot = await new CdpVisualObserver(session).capture({ maxBytes: 1024 });
  assert.equal(snapshot.format, 'png');
  assert.equal(snapshot.mimeType, 'image/png');
  assert.equal(snapshot.width, 1);
  assert.equal(snapshot.height, 1);
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
  assert.ok(snapshot.byteLength > 0);
});

test('visual observer rejects invalid clip/quality and oversized payloads', async () => {
  const observer = new CdpVisualObserver(new Session([PNG_A, PNG_A, PNG_A]));
  await assert.rejects(() => observer.capture({ clip: { x: 0, y: 0, width: 0, height: 10 } }), /clip/);
  await assert.rejects(() => observer.capture({ format: 'jpeg', quality: 101 }), /quality/);
  await assert.rejects(() => observer.capture({ maxBytes: 1 }), /maxBytes/);
});

test('visual wait detects a later paint change and stays bounded', async () => {
  const session = new Session([PNG_A, PNG_A, PNG_B]);
  const observer = new CdpVisualObserver(session);
  const before = await observer.capture();
  const result = await observer.waitForChange(before.sha256, {
    maxSamples: 2,
    pollIntervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.changed, true);
  assert.equal(result.samples, 2);
  assert.notEqual(result.snapshot.sha256, before.sha256);
});

test('visual wait returns unchanged after its sample budget', async () => {
  const observer = new CdpVisualObserver(new Session([PNG_A, PNG_A, PNG_A]));
  const before = await observer.capture();
  const result = await observer.waitForChange(before.sha256, {
    maxSamples: 2,
    pollIntervalMs: 0,
    sleep: async () => {},
  });
  assert.equal(result.changed, false);
  assert.equal(result.samples, 2);
});
