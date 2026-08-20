import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopUiEnvironmentAdapter } from '../src/computer/desktopUiAdapter.js';
import { SyntheticDesktopUiBackend } from '../src/computer/syntheticDesktopUiBackend.js';

const surface = { adapterId:'desktop:test', environment:'desktop-ui' as const, surfaceId:'win-1', generation:1 };
const target = { adapterId:'desktop:test', environment:'desktop-ui' as const, kind:'surface' as const, entityId:'win-1', generation:1 };

function fixture() {
  const backend = new SyntheticDesktopUiBackend();
  backend.windows = [{nativeWindowId:'win-1',generation:1,foreground:true,focused:true}];
  backend.accessibility.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:1},root:{controlId:'root'}});
  backend.visuals.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:1},width:10,height:10});
  return {backend,adapter:new DesktopUiEnvironmentAdapter(backend,'desktop:test')};
}

test('backend observation generation mismatch is rejected', async () => {
  const {backend,adapter} = fixture();
  backend.visuals.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:2},width:10,height:10});
  await assert.rejects(adapter.observe({adapterId:'desktop:test',channel:'visual',surface}));
});

test('native input cannot be mislabeled observe-only', async () => {
  const {backend,adapter} = fixture();
  const result = await adapter.act({adapterId:'desktop:test',actionId:'bad-effect',capability:'desktop.focus',effect:'observe-only',idempotency:'read-only',target});
  assert.equal(result.status,'rejected');
  assert.equal(result.dispatch,'not-dispatched');
  assert.deepEqual(result.evidence,['desktop-input-effect-invalid']);
  assert.equal(backend.actions.length,0);
});
