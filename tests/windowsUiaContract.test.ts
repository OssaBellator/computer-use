import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WindowsUiaSemanticRuntime,
  requiredWindowsUiaPattern,
  sameWindowsUiaControl,
  type WindowsUiaControlRef,
  type WindowsUiaProvider,
} from '../src/computer/windowsUiaContract.js';
import { decideWindowsInputIntegrity } from '../src/computer/windowsInputIntegrity.js';

const ref: WindowsUiaControlRef = Object.freeze({
  window: Object.freeze({
    hwnd:'0x001234',
    desktopSessionId:'interactive:1',
    process:Object.freeze({processId:42,startIdentity:'2026-08-27T00:00:00.000Z'}),
    generation:3,
  }),
  runtimeId:Object.freeze([42,7,9]),
  automationId:'saveButton',
  controlType:'button',
  generation:11,
});

function provider(overrides: Partial<WindowsUiaProvider> = {}): WindowsUiaProvider {
  const current = Object.freeze({
    ref,
    name:'Save',
    enabled:true,
    patterns:Object.freeze(['invoke'] as const),
  });
  return {
    observeCached: async (window) => ({
      window,
      root:current,
      itemCount:1,
      textBytes:4,
      truncated:false,
      invalidationEpoch:1,
      capturedAtMs:1,
    }),
    revalidateControl: async () => ({status:'current',control:current}),
    performSemanticAction: async () => ({status:'completed',dispatched:true,verified:true,evidence:['uia-invoke']}),
    ...overrides,
  };
}

test('semantic UIA dispatch requires exact current control identity and supported pattern', async () => {
  const runtime = new WindowsUiaSemanticRuntime(provider());
  const result = await runtime.act(ref,{kind:'invoke'},'local-reversible');
  assert.deepEqual(
    {status:result.status,dispatch:result.dispatch,verification:result.verification},
    {status:'completed',dispatch:'dispatched-once',verification:'verified'},
  );
  assert.equal(requiredWindowsUiaPattern({kind:'invoke'}),'invoke');
});

test('same RuntimeId cannot rescue a replaced control generation', () => {
  const replaced = {...ref,generation:12};
  assert.equal(sameWindowsUiaControl(ref,replaced),false);
});

test('stale and ambiguous UIA controls fail before dispatch', async () => {
  let dispatches = 0;
  for (const status of ['stale','ambiguous'] as const) {
    const runtime = new WindowsUiaSemanticRuntime(provider({
      revalidateControl: async () => ({status}),
      performSemanticAction: async () => {
        dispatches += 1;
        return {status:'completed',dispatched:true};
      },
    }));
    const result = await runtime.act(ref,{kind:'invoke'},'local-reversible');
    assert.equal(result.dispatch,'not-dispatched');
  }
  assert.equal(dispatches,0);
});

test('semantic action never silently falls back when pattern is absent', async () => {
  let dispatches = 0;
  const runtime = new WindowsUiaSemanticRuntime(provider({
    revalidateControl: async () => ({
      status:'current',
      control:{ref,enabled:true,patterns:Object.freeze(['value'] as const)},
    }),
    performSemanticAction: async () => {
      dispatches += 1;
      return {status:'completed',dispatched:true};
    },
  }));
  const result = await runtime.act(ref,{kind:'invoke'},'local-reversible');
  assert.equal(result.status,'unsupported');
  assert.equal(result.dispatch,'not-dispatched');
  assert.equal(dispatches,0);
});

test('provider exception after invocation boundary is sticky unknown', async () => {
  const runtime = new WindowsUiaSemanticRuntime(provider({
    performSemanticAction: async () => { throw new Error('transport uncertain'); },
  }));
  const result = await runtime.act(ref,{kind:'invoke'},'local-reversible');
  assert.equal(result.status,'unknown');
  assert.equal(result.dispatch,'unknown');
});

test('UIPI input integrity decision fails closed for unknown or higher-integrity targets', () => {
  assert.deepEqual(decideWindowsInputIntegrity({caller:'medium',target:'high'}),{
    allowed:false,reason:'uipi-higher-integrity-target',
  });
  assert.deepEqual(decideWindowsInputIntegrity({caller:'medium'}),{
    allowed:false,reason:'integrity-unknown',
  });
  assert.deepEqual(decideWindowsInputIntegrity({caller:'high',target:'medium'}),{
    allowed:true,reason:'equal-or-lower-integrity',
  });
});
