import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichInteractionNodesWithCdpGeometry,
  findCdpHitTestedTargetPoint,
  pointHitsCdpInteractionNode,
  quadToRect,
} from '../src/browser/cdpGeometry.js';
import { CdpIdentityIndex, type CdpSessionLike } from '../src/browser/cdpIdentity.js';
import type { InteractionNode } from '../src/types.js';

const node: InteractionNode = {
  id: 'frame-1:body:nth-of-type(1) > button:nth-of-type(1)', frameId: 'frame-1', backendNodeId: 7,
  focused: false, disabled: false, rect: { x: 10, y: 20, width: 80, height: 30 }, viewportVisible: true,
  focusable: true, clickable: true, editable: false, scrollable: false,
  capabilities: ['focus', 'activate'], interactionConfidence: 1,
};

test('quad normalization produces an axis-aligned rectangle', () => {
  assert.deepEqual(quadToRect([10, 20, 90, 20, 90, 50, 10, 50]), { x: 10, y: 20, width: 80, height: 30 });
  assert.equal(quadToRect([1, 2]), null);
});

test('CDP geometry enrichment stores main-viewport and clipped geometry', async () => {
  const session: CdpSessionLike = { async send(method: string) {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 100, clientHeight: 100, pageX: 0, pageY: 0, scale: 1 } };
    if (method === 'DOM.getBoxModel') return { model: { border: [80, 80, 130, 80, 130, 110, 80, 110] } };
    throw new Error(method);
  } };
  const [enriched] = await enrichInteractionNodesWithCdpGeometry([node], session);
  assert.deepEqual(enriched.mainViewportRect, { x: 80, y: 80, width: 50, height: 30 });
  assert.deepEqual(enriched.mainViewportVisibleRect, { x: 80, y: 80, width: 20, height: 20 });
  assert.equal(enriched.mainViewportVisible, true);
});

test('backend hit testing accepts descendants of the interaction node', async () => {
  const identities = new CdpIdentityIndex('MAIN');
  identities.add({ nodeId: 1, backendNodeId: 7, frameId: 'CHILD', path: 'body:nth-of-type(1) > button:nth-of-type(1)', nodeName: 'button', attributes: {} });
  identities.add({ nodeId: 2, backendNodeId: 8, frameId: 'CHILD', path: 'body:nth-of-type(1) > button:nth-of-type(1) > span:nth-of-type(1)', nodeName: 'span', attributes: {} });
  const session: CdpSessionLike = { async send(method: string) {
    if (method === 'DOM.getNodeForLocation') return { backendNodeId: 8, frameId: 'CHILD' };
    throw new Error(method);
  } };
  const result = await pointHitsCdpInteractionNode(session, identities, node, { x: 20, y: 20 });
  assert.equal(result.hit, true);
  assert.equal(result.backendNodeId, 8);
});

test('CDP target probing skips an occluded center and chooses a later valid point', async () => {
  const identities = new CdpIdentityIndex('MAIN');
  identities.add({ nodeId: 1, backendNodeId: 7, frameId: 'CHILD', path: 'body:nth-of-type(1) > button:nth-of-type(1)', nodeName: 'button', attributes: {} });
  const target = { ...node, mainViewportRect: { x: 0, y: 0, width: 100, height: 40 }, mainViewportVisible: true };
  const session: CdpSessionLike = { async send(method: string, params?: Record<string, unknown>) {
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 100, clientHeight: 100 } };
    if (method === 'DOM.getNodeForLocation') {
      const x = params?.x as number;
      return x === 50 ? { backendNodeId: 99, frameId: 'CHILD' } : { backendNodeId: 7, frameId: 'CHILD' };
    }
    throw new Error(method);
  } };
  const point = await findCdpHitTestedTargetPoint(session, identities, target);
  assert.deepEqual(point, { x: 27, y: 20 });
});
