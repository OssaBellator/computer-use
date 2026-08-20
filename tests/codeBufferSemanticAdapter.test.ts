// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { EditCodeBufferIntent } from '../src/computer/documentModels.js';
import {
  CodeBufferSemanticController,
  DeterministicCodeBufferBackend,
  type CodeBufferDispatchResult,
  type ResolvedCodeRange,
} from '../src/application/codeBufferSemanticAdapter.js';

const verificationBounds = { maxItems: 1, maxTextBytes: 256 };

function edit(
  backend: DeterministicCodeBufferBackend,
  text = 'MODEL',
  start = { line: 0, column: 0 },
  end = { line: 0, column: 0 },
): EditCodeBufferIntent {
  const target = backend.bufferRef();
  return {
    kind: 'edit-code-buffer',
    intentId: 'code-edit-1',
    document: backend.currentDocument(),
    effect: 'local-reversible-edit',
    target,
    range: { buffer: target, start: { ...start }, end: { ...end } },
    text,
  };
}

test('document replacement rejects stale code intent before dispatch', async () => {
  class ReplacingBackend extends DeterministicCodeBufferBackend {
    private replaceBeforeIdentity = true;
    override async resolveCodeRange(range: Parameters<DeterministicCodeBufferBackend['resolveCodeRange']>[0]): Promise<ResolvedCodeRange> {
      const resolved = await super.resolveCodeRange(range);
      if (this.replaceBeforeIdentity) {
        this.replaceBeforeIdentity = false;
        this.replaceDocument();
      }
      return resolved;
    }
  }

  const backend = new ReplacingBackend('code-doc-replace', 'abc');
  const result = await new CodeBufferSemanticController(backend).execute(edit(backend), verificationBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(result.reason, 'document-generation-stale');
  assert.equal(backend.dispatchCount, 0);
});

test('fresh generation revalidation rejects stale code buffer immediately before dispatch', async () => {
  class ReplacingBufferBackend extends DeterministicCodeBufferBackend {
    private replaceBeforeIdentity = true;
    override async resolveCodeRange(range: Parameters<DeterministicCodeBufferBackend['resolveCodeRange']>[0]): Promise<ResolvedCodeRange> {
      const resolved = await super.resolveCodeRange(range);
      if (this.replaceBeforeIdentity) {
        this.replaceBeforeIdentity = false;
        this.replaceBuffer();
      }
      return resolved;
    }
  }

  const backend = new ReplacingBufferBackend('code-buffer-replace', 'abc');
  const result = await new CodeBufferSemanticController(backend).execute(edit(backend), verificationBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'entity-generation-stale');
  assert.equal(backend.dispatchCount, 0);
});

test('code range resolution is revision-bound before dispatch', async () => {
  class MutatingResolutionBackend extends DeterministicCodeBufferBackend {
    override async resolveCodeRange(range: Parameters<DeterministicCodeBufferBackend['resolveCodeRange']>[0]): Promise<ResolvedCodeRange> {
      const resolved = await super.resolveCodeRange(range);
      this.mutateTextBeforeDispatch(`prefix\n${this.currentText()}`);
      return resolved;
    }
  }

  const backend = new MutatingResolutionBackend('code-revision-race', 'abc');
  const result = await new CodeBufferSemanticController(backend).execute(edit(backend), verificationBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'code-buffer-revision-changed-before-dispatch');
  assert.equal(backend.dispatchCount, 0);
});

test('native line-column replacement dispatches exactly once and verifies resulting model state', async () => {
  const backend = new DeterministicCodeBufferBackend('code-replace', 'const old = 1;\nreturn old;', 'typescript');
  const before = await backend.readRevision();
  const result = await new CodeBufferSemanticController(backend).execute(
    edit(backend, 'value', { line: 0, column: 6 }, { line: 0, column: 9 }),
    verificationBounds,
  );
  assert.equal(result.status, 'verified');
  assert.equal(result.dispatch, 'dispatched');
  assert.deepEqual(result.verification.evidence, ['text-model-matches']);
  assert.equal(backend.dispatchCount, 1);
  assert.equal(await backend.readRevision(), before + 1);
  assert.equal(backend.currentText(), 'const value = 1;\nreturn old;');
});

test('native multi-line replacement resolves semantic code coordinates deterministically', async () => {
  const backend = new DeterministicCodeBufferBackend('code-multiline', 'alpha\nbeta\ngamma');
  const result = await new CodeBufferSemanticController(backend).execute(
    edit(backend, 'B', { line: 0, column: 2 }, { line: 1, column: 3 }),
    verificationBounds,
  );
  assert.equal(result.status, 'verified');
  assert.equal(backend.currentText(), 'alBa\ngamma');
});

test('caller-owned code edit material is snapshotted before awaits', async () => {
  const backend = new DeterministicCodeBufferBackend('code-snapshot', 'abc');
  const intent = edit(backend, 'original', { line: 0, column: 1 }, { line: 0, column: 2 });
  const promise = new CodeBufferSemanticController(backend).execute(intent, verificationBounds);
  intent.text = 'mutated-after-call';
  intent.target.generation = 99;
  intent.range.buffer.generation = 99;
  intent.range.start.column = 0;
  const result = await promise;
  assert.equal(result.status, 'verified');
  assert.equal(backend.currentText(), 'aoriginalc');
  assert.equal(backend.dispatchCount, 1);
});

test('out-of-bounds native code range is rejected without side effects', async () => {
  const backend = new DeterministicCodeBufferBackend('code-invalid-range', 'abc');
  const result = await new CodeBufferSemanticController(backend).execute(
    edit(backend, 'x', { line: 2, column: 0 }, { line: 2, column: 0 }),
    verificationBounds,
  );
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /line exceeds buffer/);
  assert.equal(backend.dispatchCount, 0);
  assert.equal(backend.currentText(), 'abc');
});

test('truncated code observation cannot prove edit success', async () => {
  const backend = new DeterministicCodeBufferBackend('code-truncated', 'abc');
  const result = await new CodeBufferSemanticController(backend).execute(
    edit(backend, 'long-result', { line: 0, column: 1 }, { line: 0, column: 1 }),
    { maxItems: 1, maxTextBytes: 3 },
  );
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.verification.status, 'insufficient-observation');
  assert.deepEqual(result.verification.evidence, ['text-observation-not-complete']);
  assert.equal(backend.dispatchCount, 1);
});

test('backend dispatch result metadata cannot substitute for code model verification', async () => {
  class MutatingResultBackend extends DeterministicCodeBufferBackend {
    override async dispatchSemanticEdit(intent: EditCodeBufferIntent): Promise<CodeBufferDispatchResult> {
      const result = await super.dispatchSemanticEdit(intent);
      result.revision = -999;
      return result;
    }
  }

  const backend = new MutatingResultBackend('code-result-isolation', 'abc');
  const result = await new CodeBufferSemanticController(backend).execute(edit(backend, 'Q'), verificationBounds);
  assert.equal(result.status, 'verified');
  assert.equal(result.verification.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});

test('uncertain code edit dispatch is never automatically replayed', async () => {
  const backend = new DeterministicCodeBufferBackend('code-uncertain', 'abc');
  backend.markNextDispatchUncertain();
  const result = await new CodeBufferSemanticController(backend).execute(edit(backend, 'Q'), verificationBounds);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.dispatch, 'uncertain');
  assert.equal(result.verification.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});
