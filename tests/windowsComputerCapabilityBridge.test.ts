import test from 'node:test';
import assert from 'node:assert/strict';
import { computerCapabilityState } from '../src/computer/computerCapabilities.js';
import { windowsProviderComputerCapabilityProfile } from '../src/computer/windowsComputerCapabilityBridge.js';
import type { WindowsProviderCapabilityProfile } from '../src/computer/windowsProviderCapabilities.js';

function profile(capabilities:WindowsProviderCapabilityProfile['capabilities']):WindowsProviderCapabilityProfile {
  return {id:'windows-test',capabilities};
}

test('Windows provider projects only directly proven neutral computer capabilities',()=>{
  const result=windowsProviderComputerCapabilityProfile(profile({
    'uia-observation':'supported',
    'window-modal-authority':'supported',
    'wgc-hwnd-capture':'supported',
    'visual-frame-binding':'supported',
    'pointer-input':'supported',
    'keyboard-input':'supported',
    'input-integrity-gating':'supported',
    'foreground-interaction-lease':'supported',
    'human-interference-detection':'supported',
    'side-effect-verification':'partial',
    'authentication-factor-brokered-use':'supported',
  }));
  assert.equal(computerCapabilityState(result,'semantic-ui-observation').support,'supported');
  assert.equal(computerCapabilityState(result,'visual-observation').support,'supported');
  assert.equal(computerCapabilityState(result,'pointer-input').support,'supported');
  assert.equal(computerCapabilityState(result,'keyboard-input').support,'supported');
  assert.equal(computerCapabilityState(result,'text-input').support,'supported');
  assert.equal(computerCapabilityState(result,'side-effect-verification').support,'partial');
  assert.equal(computerCapabilityState(result,'authentication-factor-application').support,'supported');
  assert.equal(result.capabilities['clipboard-read'],undefined);
  assert.equal(result.capabilities['file-read'],undefined);
});

test('neutral input capability degrades when any Windows safety prerequisite is partial or unsupported',()=>{
  const result=windowsProviderComputerCapabilityProfile(profile({
    'pointer-input':'supported',
    'keyboard-input':'supported',
    'input-integrity-gating':'supported',
    'foreground-interaction-lease':'partial',
    'human-interference-detection':'supported',
  }));
  assert.equal(computerCapabilityState(result,'pointer-input').support,'partial');
  assert.equal(computerCapabilityState(result,'keyboard-input').support,'partial');
  assert.equal(computerCapabilityState(result,'text-input').support,'partial');

  const blocked=windowsProviderComputerCapabilityProfile(profile({
    'pointer-input':'supported',
    'input-integrity-gating':'unsupported',
    'foreground-interaction-lease':'supported',
    'human-interference-detection':'supported',
  }));
  assert.equal(computerCapabilityState(blocked,'pointer-input').support,'unsupported');
});
