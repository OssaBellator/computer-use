import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPUTER_USE_ENABLEMENT_LEVELS,
  assessComputerUseEnablement,
  type ComputerUseEnablementLevelPolicy,
} from '../src/computer/computerUseProgressiveEnablement.js';
import type { ComputerCapability, ComputerCapabilityProfile } from '../src/computer/computerCapabilities.js';

function policies(overrides:Partial<Record<(typeof COMPUTER_USE_ENABLEMENT_LEVELS)[number],readonly ComputerCapability[]>>={}):ComputerUseEnablementLevelPolicy[]{
  return COMPUTER_USE_ENABLEMENT_LEVELS.map((level)=>({
    level,
    requiredCapabilities:(overrides[level]??[]) as ComputerUseEnablementLevelPolicy['requiredCapabilities'],
  }));
}

test('DKG86 exposes exactly CU-0 through CU-8 in ordinal order',()=>{
  assert.deepEqual(COMPUTER_USE_ENABLEMENT_LEVELS,['CU-0','CU-1','CU-2','CU-3','CU-4','CU-5','CU-6','CU-7','CU-8']);
});

test('DKG86 level eligibility is exact to that level and never inherits adjacent capability requirements',()=>{
  const profile:ComputerCapabilityProfile={id:'test',capabilities:{'semantic-ui-observation':'supported'}};
  const ladder=policies({
    'CU-1':['semantic-ui-observation'],
    'CU-2':['pointer-input'],
  });
  const cu1=assessComputerUseEnablement(profile,ladder,'CU-1');
  assert.equal(cu1.eligible,true);
  assert.deepEqual(cu1.requiredCapabilities,['semantic-ui-observation']);
  assert.equal(cu1.authorityGranted,false);
  const cu2=assessComputerUseEnablement(profile,ladder,'CU-2');
  assert.equal(cu2.eligible,false);
  assert.deepEqual(cu2.requiredCapabilities,['pointer-input']);
  assert.deepEqual(cu2.unsupportedCapabilities,['pointer-input']);
  assert.equal(cu2.authorityGranted,false);
});

test('DKG86 partial capability support does not silently enable a production level',()=>{
  const profile:ComputerCapabilityProfile={id:'test',capabilities:{'authentication-factor-application':'partial'}};
  const result=assessComputerUseEnablement(profile,policies({'CU-8':['authentication-factor-application']}),'CU-8');
  assert.equal(result.eligible,false);
  assert.deepEqual(result.partialCapabilities,['authentication-factor-application']);
  assert.deepEqual(result.unsupportedCapabilities,[]);
});

test('DKG86 policy ladder must define every level exactly once with valid granular capabilities',()=>{
  const profile:ComputerCapabilityProfile={id:'test',capabilities:{}};
  assert.throws(()=>assessComputerUseEnablement(profile,policies().slice(0,8),'CU-1'),/computer-use-enablement-policy-count-invalid/);
  const duplicate=policies(); duplicate[8]={level:'CU-7',requiredCapabilities:[]};
  assert.throws(()=>assessComputerUseEnablement(profile,duplicate,'CU-1'),/computer-use-enablement-level-duplicate/);
  const invalid=policies(); invalid[0]={level:'CU-0',requiredCapabilities:['not-real' as never]};
  assert.throws(()=>assessComputerUseEnablement(profile,invalid,'CU-0'),/computer-use-enablement-capabilities-invalid/);
});
