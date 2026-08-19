import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureCdpIdentityIndex,
  enrichInteractionNodesWithCdpIdentity,
  type CdpSessionLike,
} from '../src/browser/cdpIdentity.js';
import type { InteractionNode } from '../src/types.js';

const session: CdpSessionLike = {
  async send(method: string) {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'FRAME_MAIN' } } };
    if (method === 'Accessibility.getFullAXTree') {
      return {
        nodes: [
          { nodeId: 'AX-7', backendDOMNodeId: 7, role: { value: 'button' }, name: { value: 'Shadow action' } },
        ],
      };
    }
    if (method === 'DOM.getDocument') {
      return {
        root: {
          nodeId: 1, backendNodeId: 1, nodeType: 9, nodeName: '#document',
          children: [{
            nodeId: 2, backendNodeId: 2, nodeType: 1, nodeName: 'HTML', children: [{
              nodeId: 3, backendNodeId: 3, nodeType: 1, nodeName: 'BODY', children: [{
                nodeId: 4, backendNodeId: 4, nodeType: 1, nodeName: 'DIV', attributes: ['id', 'host'],
                shadowRoots: [{
                  nodeId: 6, backendNodeId: 6, nodeType: 11, nodeName: '#document-fragment', children: [{
                    nodeId: 7, backendNodeId: 7, nodeType: 1, nodeName: 'BUTTON', attributes: ['aria-label', 'Shadow action'],
                  }],
                }],
              }],
            }],
          }],
        },
      };
    }
    throw new Error(`Unexpected method ${method}`);
  },
};

test('CDP identity capture reconstructs shadow-aware paths and AX join', async () => {
  const index = await captureCdpIdentityIndex(session);
  const identity = index.byBackendNodeId.get(7);
  assert.equal(identity?.path, 'body:nth-of-type(1) > div:nth-of-type(1) > ::shadow > button:nth-of-type(1)');
  assert.equal(identity?.axNodeId, 'AX-7');
  assert.equal(identity?.role, 'button');
  assert.equal(identity?.name, 'Shadow action');
});

test('interaction nodes are enriched only when path/frame identity is unambiguous', async () => {
  const index = await captureCdpIdentityIndex(session);
  const node: InteractionNode = {
    id: 'main:body:nth-of-type(1) > div:nth-of-type(1) > ::shadow > button:nth-of-type(1)',
    frameId: 'main',
    focused: true,
    disabled: false,
    focusable: true,
    clickable: true,
    editable: false,
    scrollable: false,
    capabilities: ['focus', 'activate'],
    interactionConfidence: 1,
  };
  const [enriched] = enrichInteractionNodesWithCdpIdentity([node], index);
  assert.equal(enriched.backendNodeId, 7);
  assert.equal(enriched.axNodeId, 'AX-7');
  assert.equal(enriched.name, 'Shadow action');
});
