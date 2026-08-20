import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshotInteractiveDomBounded } from '../src/browser/boundedSemanticSnapshot.js';

test('tiny semantic limits use only bounded frame acquisition and one bounded frame evaluation', async () => {
  let fullFramesCalls = 0;
  let boundedCalls = 0;
  let requestedMaxFrames = 0;
  let evaluations = 0;
  let evaluatedSource = '';

  const frame = {
    async evaluate(pageFunction: () => unknown) {
      evaluations += 1;
      evaluatedSource = pageFunction.toString();
      return {
        nodes: [{
          path: 'button:nth-of-type(1)',
          role: 'button',
          name: 'A',
          focused: false,
          disabled: false,
          viewportVisible: true,
          focusable: true,
          clickable: true,
          editable: false,
          scrollable: false,
          capabilities: ['activate'],
          interactionConfidence: 1,
        }],
        truncated: true,
        textBytes: 7,
      };
    },
    parentFrame: () => null,
  };

  const page = {
    frames() {
      fullFramesCalls += 1;
      throw new Error('unbounded frame enumeration must not run');
    },
    boundedFrames(maxFrames: number) {
      boundedCalls += 1;
      requestedMaxFrames = maxFrames;
      return { frames: [frame], complete: false };
    },
  };

  const result = await snapshotInteractiveDomBounded(page as any, {
    maxItems: 1,
    maxTextBytes: 16,
    maxDepth: 1,
  });

  assert.equal(fullFramesCalls, 0);
  assert.equal(boundedCalls, 1);
  assert.equal(requestedMaxFrames, 1);
  assert.equal(evaluations, 1);
  assert.equal(result.nodes.length, 1);
  assert.equal(result.nodes[0].frameId, 'main');
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  assert.match(evaluatedSource, /const MAX_ITEMS = 1;/);
  assert.match(evaluatedSource, /const MAX_TEXT_BYTES = 16;/);
  assert.match(evaluatedSource, /const MAX_DEPTH = 1;/);
  assert.match(evaluatedSource, /MAX_VISITED = Math\.min\(16384, Math\.max\(64, MAX_ITEMS \* 64\)\)/);
});
