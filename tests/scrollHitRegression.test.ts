import test from 'node:test';
import assert from 'node:assert/strict';
import { pointHitsCdpInteractionNode } from '../src/browser/cdpGeometry.js';
import { CdpIdentityIndex, type CdpSessionLike } from '../src/browser/cdpIdentity.js';
import type { InteractionNode } from '../src/types.js';

const target: InteractionNode = {
  id: 'backend:7',
  structuralId: 'main:body:nth-of-type(1) > button:nth-of-type(1)',
  frameId: 'main',
  backendNodeId: 7,
  focused: false,
  disabled: false,
  mainViewportRect: { x: 10, y: 20, width: 100, height: 40 },
  mainViewportVisible: true,
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['focus', 'activate'],
  interactionConfidence: 1,
};

function identities() {
  const index = new CdpIdentityIndex('MAIN');
  index.add({
    nodeId: 1,
    backendNodeId: 7,
    frameId: 'MAIN',
    path: 'body:nth-of-type(1) > button:nth-of-type(1)',
    nodeName: 'button',
    attributes: {},
  });
  return index;
}

test('CDP hit testing translates viewport coordinates by current page scroll offset', async () => {
  let location: Record<string, unknown> | undefined;
  const session: CdpSessionLike = {
    async send(method, params) {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 12, pageY: 1411 } };
      }
      if (method === 'DOM.getNodeForLocation') {
        location = params;
        return { backendNodeId: 7, frameId: 'MAIN' };
      }
      throw new Error(method);
    },
  };
  const result = await pointHitsCdpInteractionNode(session, identities(), target, { x: 320, y: 312 });
  assert.equal(result.hit, true);
  assert.equal(location?.x, 332);
  assert.equal(location?.y, 1723);
});

test('transient no-node CDP lookup is a retryable miss instead of an exception', async () => {
  const session: CdpSessionLike = {
    async send(method) {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 100 } };
      }
      if (method === 'DOM.getNodeForLocation') throw new Error('No node found at given location');
      throw new Error(method);
    },
  };
  assert.deepEqual(
    await pointHitsCdpInteractionNode(session, identities(), target, { x: 20, y: 30 }),
    { hit: false },
  );
});
