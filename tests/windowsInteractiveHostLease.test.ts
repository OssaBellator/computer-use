import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopInteractionLeaseManager } from '../src/computer/desktopInteractionLease.js';
import { WindowsInteractiveHostLeaseService } from '../src/computer/windowsInteractiveHostLease.js';
import type { WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';

const target:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0x900',desktopSessionId:'session:1',process:Object.freeze({processId:900,startIdentity:'p900'}),generation:3,
});
const surface=Object.freeze({adapterId:'desktop:windows',environment:'desktop-ui' as const,surfaceId:'0x900',generation:3});
const bounds=Object.freeze({x:0,y:0,width:640,height:480});

function manager(sequence=5){return new DesktopInteractionLeaseManager({snapshot:async()=>({sequence})},()=>100);}

test('interactive lease acquisition requires exact current foreground window and derives desktop identity',async()=>{
  const leases=manager();
  const service=new WindowsInteractiveHostLeaseService({observeWindows:async()=>({
    windows:Object.freeze([{window:target,title:'Target',foreground:true,bounds}]),
    truncated:false,itemCount:1,textBytes:6,
  })},leases);
  const acquired=await service.acquire({leaseId:'foreground-lease',targetWindow:target,targetSurface:surface,durationMs:1_000});
  assert.equal(acquired.lease.mode,'interactive-host');
  assert.equal(acquired.lease.targetDesktop,'session:1');
  assert.equal(acquired.lease.humanInputBaseline,5);
  assert.deepEqual(acquired.targetWindow,target);
  assert.deepEqual(await leases.validate(acquired.lease,{targetDesktop:'session:1',targetSurface:surface}),{status:'valid'});
});

test('background target cannot acquire interactive foreground lease',async()=>{
  const service=new WindowsInteractiveHostLeaseService({observeWindows:async()=>({
    windows:Object.freeze([{window:target,title:'Target',foreground:false,bounds}]),
    truncated:false,itemCount:1,textBytes:6,
  })},manager());
  await assert.rejects(()=>service.acquire({leaseId:'background-lease',targetWindow:target,targetSurface:surface,durationMs:1_000}),/window-not-foreground/);
});

test('truncated window observation never guesses that an unresolved target is absent/current',async()=>{
  const other:WindowsUiaWindowRef=Object.freeze({...target,hwnd:'0x901'});
  const service=new WindowsInteractiveHostLeaseService({observeWindows:async()=>({
    windows:Object.freeze([{window:other,title:'Other',foreground:true,bounds}]),
    truncated:true,itemCount:1,textBytes:5,
  })},manager());
  await assert.rejects(()=>service.acquire({leaseId:'truncated-lease',targetWindow:target,targetSurface:surface,durationMs:1_000}),/window-unresolved-truncated/);
});
