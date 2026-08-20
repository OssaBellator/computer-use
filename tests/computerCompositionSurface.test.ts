import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputerRuntimeComposition,
  createComputerRuntimeComposition,
} from '../src/index.js';

type DirectActIsAbsent = 'act' extends keyof ComputerRuntimeComposition ? false : true;
const directActIsAbsent: DirectActIsAbsent = true;

test('composition root keeps effectful action dispatch off the convenience surface', () => {
  const composition = createComputerRuntimeComposition();

  assert.equal(directActIsAbsent, true);
  assert.equal('act' in composition, false);
  assert.equal(typeof composition.observe, 'function');
  assert.equal(typeof composition.createTaskRuntime, 'function');
});
