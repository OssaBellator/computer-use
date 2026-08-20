import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpGameVisualPipeline,
  type GameRegionLeasePipelineLike,
  type VisualMotionSamplerPipelineLike,
  type VisualMotionTrackerPipelineLike,
} from '../src/browser/gameVisualPipeline.js';
import type { GameRegionCandidate } from '../src/browser/gameRegionLocator.js';
import type { GameRegionLeaseSnapshot } from '../src/browser/gameRegionLease.js';
import type { VisualMotionSample } from '../src/browser/visualDiff.js';

function region(
  backendNodeId: number,
  width = 128,
  height = 64,
): GameRegionCandidate {
  return {
    kind: 'canvas',
    backendNodeId,
    rect: { x: 0, y: 0, width, height },
    clip: { x: 0, y: 0, width, height },
    visibleFraction: 1,
    viewportCoverage: 0.5,
    score: width * height,
  };
}

function leaseState(
  status: GameRegionLeaseSnapshot['status'],
  generation: number,
  current?: GameRegionCandidate,
  geometryChanged = false,
): GameRegionLeaseSnapshot {
  return {
    status,
    generation,
    ...(current ? { region: current } : {}),
    geometryChanged,
  };
}

function visualSample(sequence: number): VisualMotionSample {
  return {
    sequence,
    snapshot: {
      format: 'png',
      mimeType: 'image/png',
      dataBase64: '',
      byteLength: 0,
      sha256: '0'.repeat(64),
      width: 128,
      height: 64,
    },
    difference: null,
  };
}

function fixture(states: GameRegionLeaseSnapshot[]) {
  let leaseCalls = 0;
  const lease: GameRegionLeasePipelineLike = {
    async acquire() {
      leaseCalls += 1;
      const state = states.shift();
      if (!state) throw new Error('no fake acquire state');
      return state;
    },
    async refresh() {
      leaseCalls += 1;
      const state = states.shift();
      if (!state) throw new Error('no fake refresh state');
      return state;
    },
  };

  let samplerFactories = 0;
  const createSampler = (): VisualMotionSamplerPipelineLike => {
    samplerFactories += 1;
    let sequence = 0;
    return {
      async sample() {
        sequence += 1;
        return visualSample(sequence);
      },
    };
  };

  let trackerResets = 0;
  let trackerUpdates = 0;
  const tracker: VisualMotionTrackerPipelineLike = {
    reset() { trackerResets += 1; },
    update(sample, timestampMs) {
      trackerUpdates += 1;
      return {
        sequence: sample.sequence,
        timestampMs,
        regions: [],
        tracks: [],
        collapsedInput: false,
      };
    },
  };

  const pipeline = new CdpGameVisualPipeline(
    { async send() { return {}; } },
    {},
    { lease, tracker, createSampler },
  );
  return {
    pipeline,
    counts: () => ({ leaseCalls, samplerFactories, trackerResets, trackerUpdates }),
  };
}

test('game visual pipeline reuses sampler and tracker state for stable renderer geometry', async () => {
  const { pipeline, counts } = fixture([
    leaseState('acquired', 1, region(1)),
    leaseState('refreshed', 1, region(1)),
  ]);

  const baseline = await pipeline.sample(0);
  const sampled = await pipeline.sample(100);

  assert.equal(baseline.status, 'baseline');
  assert.equal(baseline.baselineReset, true);
  assert.equal(baseline.perceptionGeneration, 1);
  assert.equal(sampled.status, 'sampled');
  assert.equal(sampled.baselineReset, false);
  assert.equal(sampled.perceptionGeneration, 1);
  assert.deepEqual(counts(), {
    leaseCalls: 2,
    samplerFactories: 1,
    trackerResets: 1,
    trackerUpdates: 2,
  });
});

test('game visual pipeline rebuilds its baseline when clip geometry changes', async () => {
  const { pipeline, counts } = fixture([
    leaseState('acquired', 1, region(1)),
    leaseState('refreshed', 1, region(1, 160, 80), true),
  ]);

  await pipeline.sample(0);
  const resized = await pipeline.sample(100);

  assert.equal(resized.status, 'baseline');
  assert.equal(resized.baselineReset, true);
  assert.equal(resized.rendererGeneration, 1);
  assert.equal(resized.perceptionGeneration, 2);
  assert.deepEqual(counts(), {
    leaseCalls: 2,
    samplerFactories: 2,
    trackerResets: 2,
    trackerUpdates: 2,
  });
});

test('game visual pipeline rebuilds baseline when renderer generation changes at the same clip', async () => {
  const { pipeline } = fixture([
    leaseState('acquired', 1, region(1)),
    leaseState('reacquired', 2, region(2), true),
  ]);

  await pipeline.sample(0);
  const replaced = await pipeline.sample(100);

  assert.equal(replaced.status, 'baseline');
  assert.equal(replaced.rendererGeneration, 2);
  assert.equal(replaced.perceptionGeneration, 2);
});

test('game visual pipeline clears active perception while renderer is missing then starts a new baseline', async () => {
  const { pipeline, counts } = fixture([
    leaseState('missing', 0),
    leaseState('reacquired', 1, region(3)),
  ]);

  const missing = await pipeline.sample(0);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.perceptionGeneration, 0);
  assert.equal(missing.sample, undefined);
  assert.equal(missing.tracking, undefined);

  const acquired = await pipeline.sample(100);
  assert.equal(acquired.status, 'baseline');
  assert.equal(acquired.perceptionGeneration, 1);
  assert.deepEqual(counts(), {
    leaseCalls: 2,
    samplerFactories: 1,
    trackerResets: 1,
    trackerUpdates: 1,
  });
});

test('game visual pipeline rejects time reversal before lease or capture work', async () => {
  const { pipeline, counts } = fixture([
    leaseState('acquired', 1, region(1)),
    leaseState('refreshed', 1, region(1)),
  ]);

  await pipeline.sample(100);
  await assert.rejects(pipeline.sample(99), /non-decreasing/);
  assert.equal(counts().leaseCalls, 1);
});
