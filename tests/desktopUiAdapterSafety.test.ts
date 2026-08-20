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
  backend.visuals.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:1},width:10,height:10,artifact:{token:'fixture',byteLength:1}});
  return {backend,adapter:new DesktopUiEnvironmentAdapter(backend,'desktop:test')};
}

test('backend observation generation mismatch is rejected', async () => {
  const {backend,adapter} = fixture();
  backend.visuals.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:2},width:10,height:10,artifact:{token:'mismatch',byteLength:1}});
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

test('backend evidence is copied, bounded, and machine-readable', async () => {
  const {backend,adapter} = fixture();
  const evidence = ['safe-code'];
  backend.focus = async () => ({status:'completed',dispatched:true,verified:true,evidence});
  const result = await adapter.act({adapterId:'desktop:test',actionId:'evidence',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target});
  evidence[0] = 'mutated-after-return';
  assert.deepEqual(result.evidence,['safe-code']);

  backend.focus = async () => ({status:'completed',dispatched:true,verified:true,evidence:['contains sensitive prose with spaces']});
  const invalid = await adapter.act({adapterId:'desktop:test',actionId:'evidence-bad',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target});
  assert.deepEqual(invalid.evidence,['desktop-backend-evidence-invalid']);

  backend.focus = async () => ({status:'completed',dispatched:true,verified:true,evidence:Array.from({length:17},(_,i)=>`code-${i}`)});
  const oversized = await adapter.act({adapterId:'desktop:test',actionId:'evidence-many',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target});
  assert.deepEqual(oversized.evidence,['desktop-backend-evidence-invalid']);
});

test('backend-owned nested observation metadata is rebuilt before return', async () => {
  const backend = new SyntheticDesktopUiBackend();
  const application:any = {applicationId:'app-1',processId:'proc-1',secret:'do-not-copy'};
  const bounds:any = {x:1,y:2,width:300,height:200,secret:'do-not-copy'};
  const artifact:any = {token:'frame-1',mediaType:'image/test',byteLength:12,secret:'do-not-copy'};
  backend.windows = [{nativeWindowId:'win-1',generation:1,application,bounds,foreground:true,focused:true} as any];
  backend.visuals.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:1},width:10,height:20,artifact} as any);
  const adapter = new DesktopUiEnvironmentAdapter(backend,'desktop:test');
  const system = await adapter.observe({adapterId:'desktop:test',channel:'system'});
  const visual = await adapter.observe({adapterId:'desktop:test',channel:'visual',surface});
  const systemWindow:any = (system.data as any).windows[0];
  const visualArtifact:any = (visual.data as any).artifact;
  assert.equal(systemWindow.application.secret,undefined);
  assert.equal(systemWindow.bounds.secret,undefined);
  assert.equal(visualArtifact.secret,undefined);
  application.applicationId = 'mutated'; bounds.width = 999999; artifact.token = 'mutated';
  assert.equal(systemWindow.application.applicationId,'app-1');
  assert.equal(systemWindow.bounds.width,300);
  assert.equal(visualArtifact.token,'frame-1');
});

test('invalid visual dimensions are rejected at the neutral boundary', async () => {
  for (const [width,height] of [[0,10],[10,-1],[100001,10],[1.5,10],[10,Number.POSITIVE_INFINITY]]) {
    const {backend,adapter} = fixture();
    backend.visuals.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:1},width,height,artifact:{token:'invalid-dimensions',byteLength:1}});
    await assert.rejects(adapter.observe({adapterId:'desktop:test',channel:'visual',surface}), /visual dimensions invalid/);
  }
});

test('accessibility node metadata is rebuilt and backend bounds cannot mutate neutral results', async () => {
  const {backend,adapter} = fixture();
  const bounds:any = {x:1,y:2,width:30,height:40,secret:'do-not-copy'};
  backend.accessibility.set('win-1@1',{
    status:'available', window:{nativeWindowId:'win-1',generation:1},
    root:{controlId:'root',role:'window',name:'Editor',enabled:true,focused:false,bounds,secret:'do-not-copy'} as any,
  });
  const obs = await adapter.observe({adapterId:'desktop:test',channel:'semantic-ui',surface});
  const root:any = (obs.data as any).root;
  assert.equal(root.secret,undefined);
  assert.equal(root.bounds.secret,undefined);
  bounds.width = 999999;
  assert.equal(root.bounds.width,30);
  assert.equal(Object.isFrozen(root),true);
  assert.equal(Object.isFrozen(root.bounds),true);
});

test('malformed and oversized accessibility fields are rejected at the neutral boundary', async () => {
  const cases: any[] = [
    {controlId:'x'.repeat(257)}, {controlId:'root',role:'x'.repeat(257)},
    {controlId:'root',name:'x'.repeat(4097)}, {controlId:'root',value:'x'.repeat(4097)},
    {controlId:'root',enabled:'yes'}, {controlId:'root',focused:1},
    {controlId:'root',bounds:{x:0,y:0,width:-1,height:10}}, {controlId:'root',children:{}}, {controlId:'root',children:[null]},
  ];
  for (const root of cases) {
    const {backend,adapter} = fixture();
    backend.accessibility.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:1},root} as any);
    await assert.rejects(adapter.observe({adapterId:'desktop:test',channel:'semantic-ui',surface}), /desktop accessibility/);
  }
});

test('cyclic accessibility trees are rejected without retaining backend references', async () => {
  const {backend,adapter} = fixture();
  const root:any = {controlId:'root',children:[]};
  root.children.push(root);
  backend.accessibility.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:1},root} as any);
  await assert.rejects(adapter.observe({adapterId:'desktop:test',channel:'semantic-ui',surface}), /accessibility cycle invalid/);
});

test('validated action authority cannot drift while asynchronous preflight is in flight', async () => {
  const {backend,adapter} = fixture();
  const originalObserveSystem = backend.observeSystem.bind(backend);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const enteredPreflight = new Promise<void>((resolve) => { entered = resolve; });
  backend.observeSystem = async (limits) => { entered(); await gate; return originalObserveSystem(limits); };
  const request:any = {adapterId:'desktop:test',actionId:'stable-authority',capability:'desktop.keyboard',effect:'local-reversible',idempotency:'non-idempotent',target:{...target},payload:{kind:'key-down',key:'A'}};
  const pending = adapter.act(request);
  await enteredPreflight;
  request.capability='desktop.pointer.absolute'; request.effect='external-transaction'; request.target.entityId='mutated-window';
  request.payload.key='B'; request.payload.kind='text'; request.payload.text='mutated';
  release();
  const result = await pending;
  assert.equal(result.status,'completed'); assert.equal(result.verification,'verified'); assert.equal(backend.actions.length,1);
  assert.equal(backend.actions[0]?.kind,'keyboard'); assert.equal(backend.actions[0]?.effect,'local-reversible');
  assert.deepEqual(backend.actions[0]?.payload,{kind:'key-down',key:'A'}); assert.equal(backend.actions[0]?.window.nativeWindowId,'win-1');
});

function millionChildren(counter:{reads:number}) {
  const backing:any[] = [];
  backing.length = 1_000_000;
  return new Proxy(backing, {
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        counter.reads += 1;
        return {configurable:true,enumerable:true,writable:true,value:{controlId:`child-${prop}`}};
      }
      return Reflect.getOwnPropertyDescriptor(target,prop);
    },
  });
}

test('wide accessibility children stop before indexing beyond depth and item capacity', async () => {
  {
    const {backend,adapter} = fixture(); const counter={reads:0};
    backend.accessibility.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:1},root:{controlId:'root',children:millionChildren(counter)}} as any);
    const obs = await adapter.observe({adapterId:'desktop:test',channel:'semantic-ui',surface,limits:{maxItems:10,maxTextBytes:1000,maxDepth:0}});
    assert.equal(obs.truncated,true); assert.equal(counter.reads,0);
  }
  {
    const {backend,adapter} = fixture(); const counter={reads:0};
    backend.accessibility.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:1},root:{controlId:'root',children:millionChildren(counter)}} as any);
    const obs = await adapter.observe({adapterId:'desktop:test',channel:'semantic-ui',surface,limits:{maxItems:3,maxTextBytes:1000,maxDepth:2}});
    assert.equal(obs.truncated,true); assert.equal(counter.reads,2);
  }
});

test('control preflight caps wide child acquisition before queue retention', async () => {
  const {backend,adapter} = fixture(); const counter={reads:0};
  backend.accessibility.set('win-1@1',{status:'available',window:{nativeWindowId:'win-1',generation:1},root:{controlId:'root',children:millionChildren(counter)}} as any);
  const control:any = {adapterId:'desktop:test',environment:'desktop-ui',kind:'ui-control',entityId:'missing',surfaceId:'win-1',generation:1};
  const result = await adapter.act({adapterId:'desktop:test',actionId:'wide-preflight',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target:control});
  assert.equal(result.status,'rejected'); assert.equal(result.dispatch,'not-dispatched'); assert.equal(counter.reads,255); assert.equal(backend.actions.length,0);
});

test('accessor-backed target authority is rejected before preflight without invoking getters', async () => {
  const {backend,adapter} = fixture();
  let getterCalls = 0; let preflightCalls = 0;
  const originalObserveSystem = backend.observeSystem.bind(backend);
  backend.observeSystem = async (limits) => { preflightCalls += 1; return originalObserveSystem(limits); };
  const accessorTarget:any = {adapterId:'desktop:test',environment:'desktop-ui',kind:'surface'};
  Object.defineProperty(accessorTarget,'entityId',{enumerable:true,get(){getterCalls += 1; return getterCalls === 1 ? 'win-1' : 'mutated';}});
  Object.defineProperty(accessorTarget,'generation',{enumerable:true,get(){getterCalls += 1; return 1;}});
  const result = await adapter.act({adapterId:'desktop:test',actionId:'getter-target',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target:accessorTarget});
  assert.equal(result.status,'rejected'); assert.deepEqual(result.evidence,['invalid-action-request']);
  assert.equal(getterCalls,0); assert.equal(preflightCalls,0); assert.equal(backend.actions.length,0);
});

test('accessor-backed keyboard and pointer payloads are rejected before preflight', async () => {
  for (const [capability,payload,evidence] of [
    ['desktop.keyboard', (()=>{let calls=0; const p:any={kind:'text'}; Object.defineProperty(p,'text',{enumerable:true,get(){calls+=1; return calls===1?'safe':'mutated';}}); return p;})(), 'invalid-keyboard-payload'],
    ['desktop.pointer.absolute', (()=>{const p:any={kind:'move',y:2}; Object.defineProperty(p,'x',{enumerable:true,get(){return 1;}}); return p;})(), 'invalid-pointer-payload'],
    ['desktop.pointer.relative', (()=>{const p:any={dy:2}; Object.defineProperty(p,'dx',{enumerable:true,get(){return 1;}}); return p;})(), 'invalid-pointer-payload'],
  ] as const) {
    const {backend,adapter} = fixture(); let preflightCalls=0;
    const originalObserveSystem=backend.observeSystem.bind(backend);
    backend.observeSystem=async (limits)=>{preflightCalls+=1; return originalObserveSystem(limits);};
    const result=await adapter.act({adapterId:'desktop:test',actionId:'getter-payload',capability,effect:'local-reversible',idempotency:'idempotent',target,payload});
    assert.equal(result.status,'rejected'); assert.deepEqual(result.evidence,[evidence]); assert.equal(preflightCalls,0); assert.equal(backend.actions.length,0);
  }
});

test('proxy get traps cannot drift validation from the frozen keyboard dispatch snapshot', async () => {
  const {backend,adapter} = fixture();
  let getCalls=0;
  const payload = new Proxy({kind:'text',text:'safe'} as any,{get(target,prop,receiver){getCalls+=1; if(prop==='text') return getCalls===1?'safe':'mutated'; return Reflect.get(target,prop,receiver);}});
  const result=await adapter.act({adapterId:'desktop:test',actionId:'proxy-payload',capability:'desktop.keyboard',effect:'local-reversible',idempotency:'idempotent',target,payload});
  assert.equal(result.status,'completed'); assert.equal(getCalls,0); assert.deepEqual(backend.actions[0]?.payload,{kind:'text',text:'safe'});
  assert.equal(Object.isFrozen(backend.actions[0]?.payload),true);
});

test('accessor-backed backend action results degrade to unknown after dispatch', async () => {
  const {backend,adapter} = fixture();
  backend.keyboard = async (window,input,effect) => {
    backend.actions.push({kind:'keyboard',window,input,effect,payload:input} as any);
    const result:any = {};
    Object.defineProperty(result,'status',{enumerable:true,get:()=> 'completed'});
    Object.defineProperty(result,'dispatched',{enumerable:true,get:()=> false});
    Object.defineProperty(result,'verified',{enumerable:true,value:true});
    return result;
  };
  const result = await adapter.act({adapterId:'desktop:test',actionId:'bad-result-accessor',capability:'desktop.keyboard',effect:'local-reversible',idempotency:'idempotent',target,payload:{kind:'key-down',key:'A'}});
  assert.equal(backend.actions.length,1);
  assert.equal(result.status,'unknown');
  assert.equal(result.dispatch,'unknown');
  assert.equal(result.verification,'unverified');
  assert.deepEqual(result.evidence,['desktop-backend-result-invalid']);
});

test('malformed backend action result cannot become retry-safe after native emission', async () => {
  const {backend,adapter} = fixture();
  backend.keyboard = async (window,input,effect) => {
    backend.actions.push({kind:'keyboard',window,input,effect,payload:input} as any);
    return {status:'completed',dispatched:'no',verified:true,evidence:['safe-code']} as any;
  };
  const result = await adapter.act({adapterId:'desktop:test',actionId:'bad-result-shape',capability:'desktop.keyboard',effect:'local-reversible',idempotency:'idempotent',target,payload:{kind:'key-down',key:'A'}});
  assert.equal(backend.actions.length,1);
  assert.equal(result.status,'unknown');
  assert.equal(result.dispatch,'unknown');
  assert.equal(result.verification,'unverified');
});

test('accessor-backed system observation envelope is rejected without invoking windows getter', async () => {
  const {backend,adapter} = fixture();
  let getterCalls = 0;
  backend.observeSystem = async () => {
    const raw:any = {truncated:false};
    Object.defineProperty(raw,'windows',{enumerable:true,get(){getterCalls += 1; return getterCalls === 1 ? [] : new Array(1_000_000);}});
    return raw;
  };
  await assert.rejects(adapter.observe({adapterId:'desktop:test',channel:'system',limits:{maxItems:2}}), /system observation invalid/);
  assert.equal(getterCalls,0);
});

test('proxy observation get traps cannot drift bounded system windows or nested identity', async () => {
  const {backend,adapter} = fixture();
  let getCalls = 0;
  const window = new Proxy({nativeWindowId:'win-1',generation:1,foreground:true,focused:true} as any, {
    get(target,prop,receiver) { if (prop === 'nativeWindowId') { getCalls += 1; return 'mutated'; } return Reflect.get(target,prop,receiver); },
  });
  const raw = new Proxy({windows:[window],truncated:false} as any, {
    get(target,prop,receiver) { if (prop === 'windows') { getCalls += 1; return new Array(1_000_000); } return Reflect.get(target,prop,receiver); },
  });
  backend.observeSystem = async () => raw;
  const obs = await adapter.observe({adapterId:'desktop:test',channel:'system',limits:{maxItems:2,maxTextBytes:1000}});
  assert.equal(getCalls,0);
  assert.equal((obs.data as any).windows.length,1);
  assert.equal((obs.data as any).windows[0].nativeWindowId,'win-1');
});

test('visual and accessibility backend accessors are rejected without invoking nested getters', async () => {
  {
    const {backend,adapter} = fixture();
    let getterCalls = 0;
    const raw:any = {status:'available',width:10,height:10};
    Object.defineProperty(raw,'window',{enumerable:true,get(){getterCalls += 1; return {nativeWindowId:'win-1',generation:1};}});
    backend.observeVisual = async () => raw;
    await assert.rejects(adapter.observe({adapterId:'desktop:test',channel:'visual',surface}), /visual observation invalid/);
    assert.equal(getterCalls,0);
  }
  {
    const {backend,adapter} = fixture();
    let getterCalls = 0;
    const ref:any = {generation:1};
    Object.defineProperty(ref,'nativeWindowId',{enumerable:true,get(){getterCalls += 1; return 'win-1';}});
    backend.observeAccessibility = async () => ({status:'available',window:ref,root:{controlId:'root'}} as any);
    await assert.rejects(adapter.observe({adapterId:'desktop:test',channel:'semantic-ui',surface}), /accessibility observation invalid/);
    assert.equal(getterCalls,0);
  }
});

test('observation request authority and limits cannot drift during asynchronous preflight', async () => {
  const {backend,adapter} = fixture();
  const originalObserveSystem = backend.observeSystem.bind(backend);
  const originalObserveAccessibility = backend.observeAccessibility.bind(backend);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const enteredPreflight = new Promise<void>((resolve) => { entered = resolve; });
  let firstSystem = true;
  backend.observeSystem = async (limits) => {
    if (firstSystem) {
      firstSystem = false;
      entered();
      await gate;
    }
    return originalObserveSystem(limits);
  };
  let accessibilityLimits:any;
  backend.observeAccessibility = async (window,limits) => {
    accessibilityLimits = limits;
    return originalObserveAccessibility(window,limits);
  };
  const request:any = {
    adapterId:'desktop:test',
    channel:'semantic-ui',
    surface:{...surface},
    target:{adapterId:'desktop:test',environment:'desktop-ui',kind:'ui-control',entityId:'root',surfaceId:'win-1',generation:1},
    limits:{maxItems:1,maxTextBytes:100,maxDepth:1},
  };
  const pending = adapter.observe(request);
  await enteredPreflight;
  request.channel = 'visual';
  request.surface.surfaceId = 'mutated-window';
  request.target.entityId = 'mutated-control';
  request.target.surfaceId = 'mutated-window';
  request.limits.maxItems = 100;
  request.limits.maxTextBytes = 10000;
  request.limits.maxDepth = 10;
  release();
  const result = await pending;
  assert.equal(result.channel,'semantic-ui');
  assert.equal(result.surface?.surfaceId,'win-1');
  assert.equal(result.target?.entityId,'root');
  assert.equal(result.target?.surfaceId,'win-1');
  assert.deepEqual(accessibilityLimits,{maxItems:1,maxTextBytes:100,maxDepth:1});
  assert.equal(Object.isFrozen(result.target),true);
});
