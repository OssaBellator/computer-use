// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { EditCodeBufferIntent } from '../src/computer/documentModels.js';
import { CodeBufferSemanticController, DeterministicCodeBufferBackend, type CodeBufferDispatchResult, type ResolvedCodeRange } from '../src/application/codeBufferSemanticAdapter.js';
const bounds = { maxItems: 1, maxTextBytes: 256 };
function edit(backend: DeterministicCodeBufferBackend, text = 'MODEL', start = { line: 0, column: 0 }, end = { line: 0, column: 0 }): EditCodeBufferIntent {
  const target = backend.bufferRef();
  return { kind: 'edit-code-buffer', intentId: 'code-edit-1', document: backend.currentDocument(), effect: 'local-reversible-edit', target, range: { buffer: target, start: { ...start }, end: { ...end } }, text };
}
test('document replacement rejects stale intent before dispatch', async () => {
  class B extends DeterministicCodeBufferBackend { private once = true; override async resolveCodeRange(r: Parameters<DeterministicCodeBufferBackend['resolveCodeRange']>[0]): Promise<ResolvedCodeRange> { const x = await super.resolveCodeRange(r); if (this.once) { this.once = false; this.replaceDocument(); } return x; } }
  const b = new B('doc', 'abc'); const result = await new CodeBufferSemanticController(b).execute(edit(b), bounds); assert.equal(result.status, 'rejected'); assert.equal(b.dispatchCount, 0);
});
test('stale buffer generation rejects before dispatch', async () => {
  class B extends DeterministicCodeBufferBackend { private once = true; override async resolveCodeRange(r: Parameters<DeterministicCodeBufferBackend['resolveCodeRange']>[0]): Promise<ResolvedCodeRange> { const x = await super.resolveCodeRange(r); if (this.once) { this.once = false; this.replaceBuffer(); } return x; } }
  const b = new B('buf', 'abc'); assert.equal((await new CodeBufferSemanticController(b).execute(edit(b), bounds)).status, 'rejected'); assert.equal(b.dispatchCount, 0);
});
test('range resolution is revision-bound before dispatch', async () => {
  class B extends DeterministicCodeBufferBackend { override async resolveCodeRange(r: Parameters<DeterministicCodeBufferBackend['resolveCodeRange']>[0]): Promise<ResolvedCodeRange> { const x = await super.resolveCodeRange(r); this.mutateTextBeforeDispatch(`prefix\n${this.currentText()}`); return x; } }
  const b = new B('race', 'abc'); const result = await new CodeBufferSemanticController(b).execute(edit(b), bounds); assert.equal(result.status, 'rejected'); assert.equal(b.dispatchCount, 0);
});
test('line-column replacement dispatches once and verifies model state', async () => {
  const b = new DeterministicCodeBufferBackend('replace', 'const old = 1;\nreturn old;', 'typescript'); const before = await b.readRevision(); const result = await new CodeBufferSemanticController(b).execute(edit(b, 'value', { line: 0, column: 6 }, { line: 0, column: 9 }), bounds); assert.equal(result.status, 'verified'); assert.equal(b.currentText(), 'const value = 1;\nreturn old;'); assert.equal(await b.readRevision(), before + 1); assert.equal(b.dispatchCount, 1);
});
test('multi-line replacement resolves semantic coordinates', async () => {
  const b = new DeterministicCodeBufferBackend('multi', 'alpha\nbeta\ngamma'); assert.equal((await new CodeBufferSemanticController(b).execute(edit(b, 'B', { line: 0, column: 2 }, { line: 1, column: 3 }), bounds)).status, 'verified'); assert.equal(b.currentText(), 'alBa\ngamma');
});
test('caller intent is snapshotted before awaits', async () => {
  const b = new DeterministicCodeBufferBackend('snap', 'abc'); const intent = edit(b, 'original', { line: 0, column: 1 }, { line: 0, column: 2 }); const p = new CodeBufferSemanticController(b).execute(intent, bounds); intent.text = 'mutated'; intent.target.generation = 99; intent.range.buffer.generation = 99; assert.equal((await p).status, 'verified'); assert.equal(b.currentText(), 'aoriginalc');
});
test('out-of-bounds range rejects without dispatch', async () => {
  const b = new DeterministicCodeBufferBackend('invalid', 'abc'); const result = await new CodeBufferSemanticController(b).execute(edit(b, 'x', { line: 2, column: 0 }, { line: 2, column: 0 }), bounds); assert.equal(result.status, 'rejected'); assert.equal(b.dispatchCount, 0);
});
test('truncated observation cannot prove success', async () => {
  const b = new DeterministicCodeBufferBackend('trunc', 'abc'); const result = await new CodeBufferSemanticController(b).execute(edit(b, 'long-result', { line: 0, column: 1 }, { line: 0, column: 1 }), { maxItems: 1, maxTextBytes: 3 }); assert.equal(result.status, 'verification-failed');
});
test('backend result metadata cannot substitute for model verification', async () => {
  class B extends DeterministicCodeBufferBackend { override async dispatchSemanticEdit(i: EditCodeBufferIntent): Promise<CodeBufferDispatchResult> { const r = await super.dispatchSemanticEdit(i); r.revision = -999; return r; } }
  const b = new B('result', 'abc'); assert.equal((await new CodeBufferSemanticController(b).execute(edit(b, 'Q'), bounds)).status, 'verified');
});
test('backend that mutates then throws is uncertain and not replayed', async () => {
  class B extends DeterministicCodeBufferBackend { override async dispatchSemanticEdit(i: EditCodeBufferIntent): Promise<CodeBufferDispatchResult> { await super.dispatchSemanticEdit(i); throw new Error('lost after dispatch'); } }
  const b = new B('throw', 'abc'); const result = await new CodeBufferSemanticController(b).execute(edit(b, 'Q'), bounds); assert.equal(result.status, 'uncertain'); assert.equal(result.dispatch, 'uncertain'); assert.equal(b.dispatchCount, 1); if (result.status === 'uncertain') assert.equal(result.verification.status, 'verified');
});
test('explicit uncertain dispatch is never replayed', async () => {
  const b = new DeterministicCodeBufferBackend('uncertain', 'abc'); b.markNextDispatchUncertain(); const result = await new CodeBufferSemanticController(b).execute(edit(b, 'Q'), bounds); assert.equal(result.status, 'uncertain'); assert.equal(b.dispatchCount, 1);
});
