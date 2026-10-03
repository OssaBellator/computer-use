import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWindowsProviderCapabilities, WINDOWS_PROVIDER_REQUIREMENT_SETS } from '../src/computer/windowsProviderCapabilities.js';

test('provider capability assessment stays granular instead of one use flag', () => {
  const profile = {
    id:'windows-uia-only',
    capabilities:{
      'uia-observation':'supported' as const,
      'window-modal-authority':'supported' as const,
      'uia-invoke':'supported' as const,
      'uia-value':'supported' as const,
      'wgc-hwnd-capture':'unsupported' as const,
      'pointer-input':'unsupported' as const,
    },
  };
  const semantic = assessWindowsProviderCapabilities(profile,WINDOWS_PROVIDER_REQUIREMENT_SETS.semantic);
  assert.equal(semantic.runnable,true);
  assert.equal(semantic.fullySupported,true);

  const visual = assessWindowsProviderCapabilities(profile,WINDOWS_PROVIDER_REQUIREMENT_SETS.visualFallback);
  assert.equal(visual.runnable,false);
  assert.ok(visual.missingRequired.includes('wgc-hwnd-capture'));
  assert.ok(visual.missingRequired.includes('pointer-input'));
});

test('partial required capability remains runnable but not fully supported', () => {
  const profile = {
    id:'partial-visual',
    capabilities:Object.fromEntries(WINDOWS_PROVIDER_REQUIREMENT_SETS.visualFallback.map(({capability})=>[capability,'supported'])) as Record<string,'supported'|'partial'>,
  };
  profile.capabilities['visual-grounding']='partial';
  const result = assessWindowsProviderCapabilities(profile,WINDOWS_PROVIDER_REQUIREMENT_SETS.visualFallback);
  assert.equal(result.runnable,true);
  assert.equal(result.fullySupported,false);
  assert.deepEqual(result.partialRequired,['visual-grounding']);
});
