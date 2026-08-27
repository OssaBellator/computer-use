import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveWindowsNativeHostCapabilityProfile } from '../src/computer/windowsNativeHostRuntime.js';
import type { WindowsNativeHostOperation } from '../src/computer/windowsNativeHostProtocol.js';

function support(profile:ReturnType<typeof deriveWindowsNativeHostCapabilityProfile>,key:keyof typeof profile.capabilities){
  const value=profile.capabilities[key];
  return typeof value==='string'?value:value?.support;
}

test('native runtime capability profile follows implemented operations rather than protocol reservation',()=>{
  const implemented:WindowsNativeHostOperation[]=[
    'hello','system.windows','system.virtual-desktop',
    'uia.resolve-window','uia.build-cache','uia.resolve-control','uia.compare-elements','uia.snapshot-control','uia.perform-pattern',
    'uia.events.register','uia.events.unregister','uia.events.poll',
    'integrity.current','integrity.process','input.send',
  ];
  const profile=deriveWindowsNativeHostCapabilityProfile(implemented);
  assert.equal(support(profile,'uia-observation'),'supported');
  assert.equal(support(profile,'uia-value'),'supported');
  assert.equal(support(profile,'keyboard-input'),'supported');
  assert.equal(support(profile,'pointer-input'),'supported');
  assert.equal(support(profile,'input-integrity-gating'),'supported');
  assert.equal(support(profile,'wgc-hwnd-capture'),'unsupported');
  assert.equal(support(profile,'transient-capture-retention'),'unsupported');
  assert.equal(support(profile,'window-modal-authority'),'partial');
  assert.equal(support(profile,'human-interference-detection'),'unsupported');
  assert.equal(support(profile,'foreground-interaction-lease'),'unsupported');
});

test('native window-state observation upgrades modal authority only with the semantic observation surface',()=>{
  const semantic:WindowsNativeHostOperation[]=[
    'hello','uia.resolve-window','uia.build-cache','uia.resolve-control','uia.compare-elements','uia.snapshot-control',
  ];
  assert.equal(support(deriveWindowsNativeHostCapabilityProfile([...semantic,'uia.window-states']),'window-modal-authority'),'supported');
  assert.equal(support(deriveWindowsNativeHostCapabilityProfile(['hello','uia.window-states']),'window-modal-authority'),'unsupported');
});

test('human monitoring alone is insufficient for a foreground lease; exact window observation completes it',()=>{
  const monitorOnly=deriveWindowsNativeHostCapabilityProfile(['hello','input.send','input.human-sequence']);
  assert.equal(support(monitorOnly,'human-interference-detection'),'supported');
  assert.equal(support(monitorOnly,'foreground-interaction-lease'),'unsupported');

  const complete=deriveWindowsNativeHostCapabilityProfile(['hello','system.windows','input.send','input.human-sequence']);
  assert.equal(support(complete,'foreground-interaction-lease'),'supported');
});

test('capture is supported only when both frame production and artifact release are implemented',()=>{
  const onlyFrame=deriveWindowsNativeHostCapabilityProfile(['hello','capture.next-frame']);
  assert.equal(support(onlyFrame,'wgc-hwnd-capture'),'unsupported');
  assert.equal(support(onlyFrame,'transient-capture-retention'),'unsupported');

  const complete=deriveWindowsNativeHostCapabilityProfile(['hello','capture.next-frame','artifact.release']);
  assert.equal(support(complete,'wgc-hwnd-capture'),'supported');
  assert.equal(support(complete,'visual-frame-binding'),'supported');
  assert.equal(support(complete,'transient-capture-retention'),'supported');
});

test('missing integrity operations cannot advertise guarded native input',()=>{
  const profile=deriveWindowsNativeHostCapabilityProfile(['hello','input.send']);
  assert.equal(support(profile,'keyboard-input'),'supported');
  assert.equal(support(profile,'input-integrity-gating'),'unsupported');
});
