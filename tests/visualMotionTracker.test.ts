import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VisualMotionTracker,
  projectVisualMotionTrack,
} from '../src/browser/visualMotionTracker.js';
import type {
  VisualDifferenceTile,
  VisualMotionSample,
} from '../src/browser/visualDiff.js';
import type { VisualSnapshot } from '../src/browser/visualObserver.js';

function tile(
  x: number,
  y: number,
  width = 8,
  height = 8,
  viewport = false,
): VisualDifferenceTile {
  return {
    imageRect: { x, y, width, height },
    changedPixelFraction: 1,
    meanAbsoluteDifference: 255,
    ...(viewport
      ? { viewportRect: { x: x * 2, y: y * 2, width: width * 2, height: height * 2 } }
      : {}),
  };
}

function bounds(tiles: readonly VisualDifferenceTile[], viewport = false) {
  const rects = tiles.map((entry) => viewport ? entry.viewportRect! : entry.imageRect);
  if (!rects.length) return undefined;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function sample(
  sequence: number,
  tiles: VisualDifferenceTile[],
  compatible = true,
): VisualMotionSample {
  const motionBounds = bounds(tiles);
  const allViewport = tiles.length > 0 && tiles.every((entry) => entry.viewportRect);
  const viewportMotionBounds = allViewport ? bounds(tiles, true) : undefined;
  const snapshot: VisualSnapshot = {
    format: 'png',
    mimeType: 'image/png',
    dataBase64: '',
    byteLength: 0,
    sha256: '0'.repeat(64),
    width: 128,
    height: 64,
  };
  return {
    sequence,
    snapshot,
    difference: {
      compatible,
      changed: tiles.length > 0,
      width: 128,
      height: 64,
      sampledPixels: 8_192,
      changedPixelFraction: tiles.length ? 0.1 : 0,
      meanAbsoluteDifference: tiles.length ? 25 : 0,
      changedTiles: tiles,
      ...(motionBounds ? { motionBounds } : {}),
      ...(viewportMotionBounds ? { viewportMotionBounds } : {}),
      ...(!compatible ? { reason: 'dimensions-changed' as const } : {}),
    },
  };
}

test('visual motion tracker follows connected regions with velocity and bounded projection', () => {
  const tracker = new VisualMotionTracker({ velocityAlpha: 1 });

  let frame = tracker.update(sample(1, [tile(8, 24), tile(16, 24)]), 100);
  assert.equal(frame.regions.length, 1);
  assert.equal(frame.tracks.length, 1);
  assert.deepEqual(frame.tracks[0].rect, { x: 8, y: 24, width: 16, height: 8 });

  frame = tracker.update(sample(2, [tile(16, 24), tile(24, 24)]), 200);
  assert.equal(frame.tracks[0].id, 1);
  assert.deepEqual(frame.tracks[0].velocityPxPerSecond, { x: 80, y: 0 });
  assert.deepEqual(
    projectVisualMotionTrack(frame.tracks[0], 100),
    { x: 24, y: 24, width: 16, height: 8 },
  );
  // The default public projection horizon is capped at 250 ms.
  assert.deepEqual(
    projectVisualMotionTrack(frame.tracks[0], 1_000),
    { x: 36, y: 24, width: 16, height: 8 },
  );
});

test('visual motion tracker decays and expires missed regions', () => {
  const tracker = new VisualMotionTracker({
    maxMissedSamples: 1,
    confidenceDecay: 0.3,
    initialConfidence: 0.5,
  });

  tracker.update(sample(1, [tile(0, 0)]), 0);
  let frame = tracker.update(sample(2, []), 50);
  assert.equal(frame.tracks.length, 1);
  assert.equal(frame.tracks[0].missedSamples, 1);
  assert.equal(frame.tracks[0].confidence, 0.2);

  frame = tracker.update(sample(3, []), 100);
  assert.equal(frame.tracks.length, 0);
});

test('visual motion tracker resets identities when coordinate space changes', () => {
  const tracker = new VisualMotionTracker();

  let frame = tracker.update(sample(1, [tile(0, 0)]), 0);
  assert.equal(frame.coordinateSpace, 'image');
  assert.equal(frame.tracks[0].id, 1);

  frame = tracker.update(sample(2, [tile(0, 0, 8, 8, true)]), 100);
  assert.equal(frame.coordinateSpace, 'viewport');
  assert.equal(frame.tracks.length, 1);
  assert.equal(frame.tracks[0].id, 2);
});

test('visual motion tracker collapses excessive tile input to one bounded coarse region', () => {
  const tracker = new VisualMotionTracker({ maxChangedTiles: 2 });
  const frame = tracker.update(
    sample(1, [tile(0, 0), tile(8, 0), tile(16, 0)]),
    0,
  );

  assert.equal(frame.collapsedInput, true);
  assert.equal(frame.regions.length, 1);
  assert.deepEqual(frame.regions[0], {
    rect: { x: 0, y: 0, width: 24, height: 8 },
    tileCount: 3,
  });
});

test('incompatible frame dimensions clear temporal tracks before association', () => {
  const tracker = new VisualMotionTracker();
  tracker.update(sample(1, [tile(0, 0)]), 0);
  const frame = tracker.update(sample(2, [tile(0, 0)], false), 100);

  assert.equal(frame.coordinateSpace, undefined);
  assert.deepEqual(frame.regions, []);
  assert.deepEqual(frame.tracks, []);
});

test('visual motion tracker rejects non-monotonic samples without mutating live tracks', () => {
  const tracker = new VisualMotionTracker();
  tracker.update(sample(1, [tile(0, 0)]), 100);

  assert.throws(
    () => tracker.update(sample(1, [tile(8, 0)]), 200),
    /strictly increasing/,
  );
  assert.throws(
    () => tracker.update(sample(2, [tile(8, 0)]), 99),
    /non-decreasing/,
  );
  assert.equal(tracker.tracks()[0].rect.x, 0);
});
