import { describe, expect, it } from 'vitest';
import {
  InteractionGraph,
  bestDirectionalCandidate,
} from '../src/graph.js';
import type { InteractionNode } from '../src/types.js';

function node(id: string, x: number, y: number, confidence = 1): InteractionNode {
  return {
    id,
    frameId: 'main',
    focused: false,
    disabled: false,
    rect: { x, y, width: 20, height: 20 },
    focusable: true,
    clickable: true,
    editable: false,
    scrollable: false,
    capabilities: ['focus', 'activate'],
    interactionConfidence: confidence,
  };
}

describe('directional navigation', () => {
  it('prefers aligned candidates over diagonally closer ones', () => {
    const origin = node('origin', 0, 0);
    const aligned = node('aligned', 100, 0);
    const diagonal = node('diagonal', 55, 65);

    expect(bestDirectionalCandidate(origin, [diagonal, aligned], 'right')?.id).toBe('aligned');
  });
});

describe('InteractionGraph', () => {
  it('finds the lowest weighted interaction path', () => {
    const graph = new InteractionGraph();
    for (const n of [node('a', 0, 0), node('b', 10, 0), node('c', 20, 0)]) {
      graph.upsertNode(n);
    }

    graph.addEdge({
      from: 'a',
      to: 'c',
      kind: 'pointer-move',
      estimatedTimeMs: 100,
      failureProbability: 0.8,
    });
    graph.addEdge({ from: 'a', to: 'b', kind: 'focus-next', estimatedTimeMs: 120 });
    graph.addEdge({ from: 'b', to: 'c', kind: 'activate', estimatedTimeMs: 120 });

    const path = graph.shortestPath('a', 'c');
    expect(path?.map((edge) => edge.to)).toEqual(['b', 'c']);
  });
});
