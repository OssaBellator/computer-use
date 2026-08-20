import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichInteractionNodesWithFrameHierarchy,
  isDirectChildFrame,
  isDirectParentFrame,
} from '../src/browser/frameHierarchy.js';
import type { InteractionNode } from '../src/types.js';

function node(id: string, frameId: string): InteractionNode {
  return {
    id,
    frameId,
    focused: false,
    disabled: false,
    focusable: true,
    clickable: true,
    editable: false,
    scrollable: false,
    capabilities: ['focus'],
    interactionConfidence: 1,
  };
}

test('frame hierarchy enrichment attaches parent to child-frame nodes only', () => {
  const main = node('main-node', 'frame-main');
  const child = node('child-node', 'frame-child');
  const enriched = enrichInteractionNodesWithFrameHierarchy(
    [main, child],
    { frameToParentFrame: new Map([['frame-child', 'frame-main']]) },
  );
  assert.equal(enriched[0].parentFrameId, undefined);
  assert.equal(enriched[1].parentFrameId, 'frame-main');
  assert.equal(isDirectChildFrame(enriched[1], enriched[0]), true);
  assert.equal(isDirectParentFrame(enriched[0], enriched[1]), true);
});

test('sibling frames are not mistaken for direct parent/child ownership', () => {
  const nodes = enrichInteractionNodesWithFrameHierarchy(
    [node('a', 'frame-a'), node('b', 'frame-b')],
    {
      frameToParentFrame: new Map([
        ['frame-a', 'frame-main'],
        ['frame-b', 'frame-main'],
      ]),
    },
  );
  assert.equal(isDirectChildFrame(nodes[0], nodes[1]), false);
  assert.equal(isDirectParentFrame(nodes[0], nodes[1]), false);
});
