import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileWindowsAbsolutePointerInput,
  compileWindowsKeyboardInput,
  compileWindowsRelativePointerInput,
  normalizeWindowsVirtualDesktopPoint,
  WindowsSendInputDispatcher,
} from '../src/computer/windowsSendInputPlan.js';
import type { WindowsNativeInputDispatchAuthority } from '../src/computer/windowsNativeInputGate.js';

const virtualDesktop = Object.freeze({left:-1920,top:0,width:3840,height:1080});
const authority:WindowsNativeInputDispatchAuthority=Object.freeze({
  targetWindow:Object.freeze({
    hwnd:'0x77',desktopSessionId:'session:1',process:Object.freeze({processId:77,startIdentity:'p77'}),generation:3,
  }),
  humanInputSequence:9,
});

test('absolute pointer maps virtual desktop endpoints to Win32 normalized range', () => {
  assert.deepEqual(normalizeWindowsVirtualDesktopPoint(-1920,0,virtualDesktop),{x:0,y:0});
  assert.deepEqual(normalizeWindowsVirtualDesktopPoint(1919,1079,virtualDesktop),{x:65535,y:65535});
  const center = normalizeWindowsVirtualDesktopPoint(0,540,virtualDesktop);
  assert.ok(center.x > 32_000 && center.x < 33_000);
});

test('absolute click compiles move plus down/up without exposing Win32 flags', () => {
  const events = compileWindowsAbsolutePointerInput({kind:'click',x:100,y:200,button:'left'},virtualDesktop);
  assert.equal(events.length,3);
  assert.equal(events[0]?.kind,'mouse-absolute-move');
  assert.deepEqual(events.slice(1),[
    {kind:'mouse-button',button:'left',keyUp:false},
    {kind:'mouse-button',button:'left',keyUp:true},
  ]);
});

test('text input becomes UTF-16 unicode key down/up records including surrogate pairs', () => {
  const events = compileWindowsKeyboardInput({kind:'text',text:'A😀'});
  // A = one UTF-16 code unit, emoji = surrogate pair; each gets down + up.
  assert.equal(events.length,6);
  assert.deepEqual(events[0],{kind:'keyboard-unicode',codeUnit:65,keyUp:false});
  assert.deepEqual(events[1],{kind:'keyboard-unicode',codeUnit:65,keyUp:true});
  assert.equal(events[2]?.kind,'keyboard-unicode');
  assert.equal(events[4]?.kind,'keyboard-unicode');
});

test('modified key-down presses modifiers before key and key-up releases them after key', () => {
  const down = compileWindowsKeyboardInput({kind:'key-down',key:'D',modifiers:['meta','shift']});
  const up = compileWindowsKeyboardInput({kind:'key-up',key:'D',modifiers:['meta','shift']});
  assert.deepEqual(down.map((event)=>event.kind),['keyboard-vk','keyboard-vk','keyboard-vk']);
  assert.equal(down[0]?.kind==='keyboard-vk' ? down[0].virtualKey : 0,0x5b);
  assert.equal(down[2]?.kind==='keyboard-vk' ? down[2].virtualKey : 0,0x44);
  assert.equal(up[0]?.kind==='keyboard-vk' ? up[0].virtualKey : 0,0x44);
  assert.equal(up[2]?.kind==='keyboard-vk' ? up[2].virtualKey : 0,0x5b);
});

test('relative pointer rejects excessive deltas', () => {
  assert.deepEqual(compileWindowsRelativePointerInput({dx:10,dy:-20}),[{kind:'mouse-relative-move',dx:10,dy:-20}]);
  assert.throws(()=>compileWindowsRelativePointerInput({dx:100_001,dy:0}),/relative-delta-invalid/);
});

test('SendInput dispatcher is exactly-once, forwards authority, and reports native inserted count', async () => {
  let calls = 0;
  let seenAuthority:WindowsNativeInputDispatchAuthority|undefined;
  const dispatcher = new WindowsSendInputDispatcher({
    sendInput:async(events,nativeAuthority)=>{
      calls+=1;
      seenAuthority=nativeAuthority;
      return {insertedEventCount:events.length};
    },
  },compileWindowsKeyboardInput({kind:'text',text:'x'}));
  assert.deepEqual(await dispatcher.dispatch(authority),{requestedEventCount:2,insertedEventCount:2});
  assert.equal(seenAuthority,authority);
  await assert.rejects(()=>dispatcher.dispatch(authority),/dispatcher-reused/);
  assert.equal(calls,1);
});

test('SendInput dispatcher preserves a native definite pre-dispatch failure',async()=>{
  const dispatcher=new WindowsSendInputDispatcher({
    sendInput:async()=>({insertedEventCount:0,preDispatchFailure:'windows-input-target-not-foreground'}),
  },compileWindowsRelativePointerInput({dx:0,dy:0}));
  assert.deepEqual(await dispatcher.dispatch(authority),{
    requestedEventCount:1,insertedEventCount:0,preDispatchFailure:'windows-input-target-not-foreground',
  });
});
