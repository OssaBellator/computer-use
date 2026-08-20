import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopUiEnvironmentAdapter, type DesktopSemanticObservationData, type DesktopSystemObservationData, type DesktopVisualObservationData } from '../src/computer/desktopUiAdapter.js';
import { SyntheticDesktopUiBackend } from '../src/computer/syntheticDesktopUiBackend.js';

function fixture() {
  const backend = new SyntheticDesktopUiBackend();
  backend.windows = [{ nativeWindowId:'win-1', generation:1, application:{applicationId:'app.editor',processId:'proc-7'}, title:'Editor', foreground:true, focused:true }];
  backend.accessibility.set('win-1@1', { status:'available', window:{nativeWindowId:'win-1',generation:1}, root:{ controlId:'root', role:'window', children:[{controlId:'save',role:'button',name:'Save'},{controlId:'field',role:'textbox',name:'Title'}] } });
  backend.visuals.set('win-1@1', { status:'available', window:{nativeWindowId:'win-1',generation:1}, width:800, height:600, artifact:{token:'synthetic-1',mediaType:'image/png',byteLength:128} });
  return {backend, adapter:new DesktopUiEnvironmentAdapter(backend,'desktop:test')};
}

const surface = { adapterId:'desktop:test', environment:'desktop-ui' as const, surfaceId:'win-1', generation:1 };
const save = { adapterId:'desktop:test', environment:'desktop-ui' as const, kind:'ui-control' as const, entityId:'save', surfaceId:'win-1', generation:1 };

test('window identity includes owner, native identity, generation, and focus state', async () => {
  const {adapter} = fixture();
  const obs = await adapter.observe({adapterId:'desktop:test',channel:'system'});
  const data = obs.data as DesktopSystemObservationData;
  assert.equal(data.windows[0]?.nativeWindowId,'win-1');
  assert.equal(data.windows[0]?.generation,1);
  assert.deepEqual(data.windows[0]?.application,{applicationId:'app.editor',processId:'proc-7'});
  assert.equal(data.windows[0]?.foreground,true);
  assert.equal(data.windows[0]?.focused,true);
  assert.deepEqual(data.focusedSurface,surface);
});

test('system observation obeys item and text bounds and reports truncation', async () => {
  const {backend,adapter} = fixture();
  backend.windows.push({nativeWindowId:'win-2',generation:1,title:'Second window',foreground:false,focused:false});
  const byItems = await adapter.observe({adapterId:'desktop:test',channel:'system',limits:{maxItems:1,maxTextBytes:1_000,maxDepth:1}});
  const itemData = byItems.data as DesktopSystemObservationData;
  assert.equal(itemData.windows.length,1);
  assert.equal(itemData.itemCount,1);
  assert.equal(byItems.truncated,true);
  assert.equal(byItems.complete,false);

  const byText = await adapter.observe({adapterId:'desktop:test',channel:'system',limits:{maxItems:10,maxTextBytes:4,maxDepth:1}});
  const textData = byText.data as DesktopSystemObservationData;
  assert.equal(textData.windows.length,0);
  assert.equal(textData.textBytes,0);
  assert.equal(byText.truncated,true);
  assert.equal(byText.complete,false);
});

test('window replacement invalidates old generation and control identity', async () => {
  const {backend,adapter} = fixture();
  backend.windows = [{nativeWindowId:'win-1',generation:2,foreground:true,focused:true}];
  backend.accessibility.set('win-1@2',{status:'available',window:{nativeWindowId:'win-1',generation:2},root:{controlId:'root',children:[{controlId:'save'}]}});
  await assert.rejects(adapter.observe({adapterId:'desktop:test',channel:'semantic-ui',surface}));
  const result = await adapter.act({adapterId:'desktop:test',actionId:'focus-old',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target:save});
  assert.equal(result.status,'rejected');
  assert.equal(result.dispatch,'not-dispatched');
  assert.deepEqual(result.evidence,['stale-window']);
});

test('focus ownership includes focused control when backend exposes it', async () => {
  const {backend,adapter} = fixture();
  backend.focusedControlId = 'field';
  const data = (await adapter.observe({adapterId:'desktop:test',channel:'system'})).data as DesktopSystemObservationData;
  assert.equal(data.focusedControl?.entityId,'field');
  assert.equal(data.focusedControl?.generation,1);
});

test('accessibility tree is bounded and explicit about truncation', async () => {
  const {adapter} = fixture();
  const obs = await adapter.observe({adapterId:'desktop:test',channel:'semantic-ui',surface,limits:{maxItems:2,maxTextBytes:100,maxDepth:5}});
  const data = obs.data as DesktopSemanticObservationData;
  assert.equal(obs.truncated,true);
  assert.equal(obs.complete,false);
  assert.equal(data.itemCount,2);
  assert.equal(data.root?.children.length,1);
  assert.equal(data.root?.children[0]?.entity.generation,1);
});

test('inaccessible accessibility data is explicit and non-truncated', async () => {
  const {backend,adapter} = fixture();
  backend.accessibility.set('win-1@1',{status:'unavailable',window:{nativeWindowId:'win-1',generation:1},reason:'permission-denied'});
  const obs = await adapter.observe({adapterId:'desktop:test',channel:'semantic-ui',surface});
  const data = obs.data as DesktopSemanticObservationData;
  assert.equal(data.status,'unavailable');
  assert.equal(data.reason,'permission-denied');
  assert.equal(obs.truncated,false);
});

test('stale control is rejected before native dispatch', async () => {
  const {backend,adapter} = fixture();
  const stale = {...save, entityId:'removed'};
  const result = await adapter.act({adapterId:'desktop:test',actionId:'focus-stale',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target:stale});
  assert.equal(result.status,'rejected');
  assert.equal(result.dispatch,'not-dispatched');
  assert.deepEqual(result.evidence,['stale-control']);
  assert.equal(backend.actions.length,0);
});

test('native action result maps dispatch and verification safely', async () => {
  const {backend,adapter} = fixture();
  const result = await adapter.act({adapterId:'desktop:test',actionId:'key-1',capability:'desktop.keyboard',effect:'local-reversible',idempotency:'non-idempotent',target:save,payload:{kind:'key-down',key:'Enter'}});
  assert.deepEqual({status:result.status,dispatch:result.dispatch,verification:result.verification},{status:'completed',dispatch:'dispatched-once',verification:'verified'});
  assert.equal(backend.actions[0]?.kind,'keyboard');
});

test('malformed and oversized keyboard payloads never dispatch', async () => {
  const cases: unknown[] = [
    {kind:'key-down'},
    {kind:'key-up',key:'A',modifiers:['control','bogus']},
    {kind:'key-down',key:'A',modifiers:['shift','shift']},
    {kind:'text'},
    {kind:'text',text:'x'.repeat(4_097)},
    {kind:'key-down',key:'x'.repeat(129)},
    {kind:'text',text:'ok',modifiers:['control']},
  ];
  for (const payload of cases) {
    const {backend,adapter} = fixture();
    const result = await adapter.act({adapterId:'desktop:test',actionId:'bad-key',capability:'desktop.keyboard',effect:'local-reversible',idempotency:'non-idempotent',target:save,payload});
    assert.equal(result.status,'rejected');
    assert.equal(result.dispatch,'not-dispatched');
    assert.deepEqual(result.evidence,['invalid-keyboard-payload']);
    assert.equal(backend.actions.length,0);
  }
});

test('backend action exception becomes conservative unknown dispatch', async () => {
  const {backend,adapter} = fixture();
  backend.throwOnAction = 'pointer-absolute';
  const result = await adapter.act({adapterId:'desktop:test',actionId:'ptr-1',capability:'desktop.pointer.absolute',effect:'local-reversible',idempotency:'idempotent',payload:{kind:'move',x:10,y:20},target:save});
  assert.equal(result.status,'unknown');
  assert.equal(result.dispatch,'unknown');
  assert.equal(result.verification,'unverified');
  assert.deepEqual(result.evidence,['desktop-backend-threw-after-invocation']);
});

test('visual observation seam returns bounded backend-owned capture metadata', async () => {
  const {adapter} = fixture();
  const obs = await adapter.observe({adapterId:'desktop:test',channel:'visual',surface});
  const data = obs.data as DesktopVisualObservationData;
  assert.equal(data.status,'available');
  assert.equal(data.width,800);
  assert.deepEqual(data.artifact,{token:'synthetic-1',mediaType:'image/png',byteLength:128});
  assert.equal(data.window.generation,1);
});

test('oversized visual artifact metadata cannot escape the observation boundary', async () => {
  const {backend,adapter} = fixture();
  backend.visuals.set('win-1@1', {
    status:'available',
    window:{nativeWindowId:'win-1',generation:1},
    artifact:{token:'x'.repeat(257)},
  });
  await assert.rejects(
    adapter.observe({adapterId:'desktop:test',channel:'visual',surface}),
    /visual artifact metadata invalid/,
  );
});

test('surface entity supports window-targeted native input without inventing a control', async () => {
  const {backend,adapter} = fixture();
  const windowEntity = {adapterId:'desktop:test',environment:'desktop-ui' as const,kind:'surface' as const,entityId:'win-1',generation:1};
  const result = await adapter.act({adapterId:'desktop:test',actionId:'focus-window',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target:windowEntity});
  assert.equal(result.status,'completed');
  assert.equal(backend.actions[0]?.kind,'focus');
});
