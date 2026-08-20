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

test('keyboard payloads reject missing, oversized, duplicate, and unknown fields before dispatch', async () => {
  const cases: unknown[] = [
    {kind:'key-down'},
    {kind:'key-up',key:'x'.repeat(200)},
    {kind:'text'},
    {kind:'text',text:'x',modifiers:['shift']},
    {kind:'key-down',key:'A',modifiers:['shift','shift']},
    {kind:'key-down',key:'A',modifiers:['caps-lock']},
    {kind:'key-down',key:'A',extra:true},
  ];
  for (const payload of cases) {
    const {backend,adapter} = fixture();
    const result = await adapter.act({adapterId:'desktop:test',actionId:'bad-key',capability:'desktop.keyboard',effect:'local-reversible',idempotency:'idempotent',target,payload});
    assert.equal(result.dispatch,'not-dispatched');
    assert.deepEqual(result.evidence,['invalid-keyboard-payload']);
    assert.equal(backend.actions.length,0);
  }
});

test('absolute pointer payload is discriminated, bounded, and validates buttons', async () => {
  const cases: unknown[] = [
    {kind:'click',x:1,y:2},
    {kind:'click',x:1,y:2,button:'primary'},
    {kind:'move',x:1,y:2,button:'left'},
    {kind:'down',x:1_000_001,y:0,button:'left'},
    {kind:'up',x:1,y:2,button:'left',extra:true},
    {kind:'move',x:1.5,y:2},
  ];
  for (const payload of cases) {
    const {backend,adapter} = fixture();
    const result = await adapter.act({adapterId:'desktop:test',actionId:'bad-pointer',capability:'desktop.pointer.absolute',effect:'local-reversible',idempotency:'idempotent',target,payload});
    assert.equal(result.dispatch,'not-dispatched');
    assert.deepEqual(result.evidence,['invalid-pointer-payload']);
    assert.equal(backend.actions.length,0);
  }
});

test('relative pointer payload rejects huge deltas and unknown fields before dispatch', async () => {
  const cases: unknown[] = [{dx:100_001,dy:0},{dx:1,dy:2,extra:true},{dx:1.2,dy:2}];
  for (const payload of cases) {
    const {backend,adapter} = fixture();
    const result = await adapter.act({adapterId:'desktop:test',actionId:'bad-relative',capability:'desktop.pointer.relative',effect:'local-reversible',idempotency:'idempotent',target,payload});
    assert.equal(result.dispatch,'not-dispatched');
    assert.deepEqual(result.evidence,['invalid-pointer-payload']);
    assert.equal(backend.actions.length,0);
  }
});

test('direct adapter use rejects foreign adapter and environment targets', async () => {
  for (const foreignTarget of [
    {...target,adapterId:'desktop:other'},
    {...target,environment:'browser' as const},
  ]) {
    const {backend,adapter} = fixture();
    const result = await adapter.act({adapterId:'desktop:test',actionId:'foreign',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target:foreignTarget});
    assert.equal(result.status,'rejected');
    assert.equal(result.dispatch,'not-dispatched');
    assert.deepEqual(result.evidence,['invalid-action-request']);
    assert.equal(backend.actions.length,0);
  }
});

test('higher-risk native input preserves dispatch without claiming domain verification', async () => {
  const {backend,adapter} = fixture();
  const result = await adapter.act({adapterId:'desktop:test',actionId:'external-key',capability:'desktop.keyboard',effect:'external-transaction',idempotency:'non-idempotent',target,payload:{kind:'key-down',key:'Enter'}});
  assert.equal(result.status,'completed');
  assert.equal(result.dispatch,'dispatched-once');
  assert.equal(result.verification,'not-applicable');
  assert.equal(backend.actions.length,1);
});

test('unavailable observation reasons must be bounded machine codes', async () => {
  const {backend,adapter} = fixture();
  backend.accessibility.set('win-1@1',{status:'unavailable',window:{nativeWindowId:'win-1',generation:1},reason:'X'.repeat(1000)});
  await assert.rejects(adapter.observe({adapterId:'desktop:test',channel:'semantic-ui',surface}), /reason code invalid/);
  backend.visuals.set('win-1@1',{status:'unavailable',window:{nativeWindowId:'win-1',generation:1},reason:'contains spaces'});
  await assert.rejects(adapter.observe({adapterId:'desktop:test',channel:'visual',surface}), /reason code invalid/);
});
