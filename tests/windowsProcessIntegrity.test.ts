import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyWindowsIntegrityRid, resolveWindowsInputIntegrityContext, WINDOWS_MANDATORY_INTEGRITY_RIDS } from '../src/computer/windowsProcessIntegrity.js';
import { decideWindowsInputIntegrity } from '../src/computer/windowsInputIntegrity.js';

const process = Object.freeze({processId:123,startIdentity:'start-123'});

test('mandatory integrity RIDs keep medium-plus and protected distinct', () => {
  assert.equal(classifyWindowsIntegrityRid(WINDOWS_MANDATORY_INTEGRITY_RIDS.untrusted),'untrusted');
  assert.equal(classifyWindowsIntegrityRid(WINDOWS_MANDATORY_INTEGRITY_RIDS.medium),'medium');
  assert.equal(classifyWindowsIntegrityRid(WINDOWS_MANDATORY_INTEGRITY_RIDS.mediumPlus),'medium-plus');
  assert.equal(classifyWindowsIntegrityRid(WINDOWS_MANDATORY_INTEGRITY_RIDS.protected),'protected');
  assert.equal(classifyWindowsIntegrityRid(0x2200),undefined);
});

test('resolved token integrity feeds fail-closed UIPI ordering', async () => {
  const context = await resolveWindowsInputIntegrityContext({
    currentProcessIntegrityRid:async()=>WINDOWS_MANDATORY_INTEGRITY_RIDS.medium,
    processIntegrityRid:async(target)=>{assert.deepEqual(target,process);return WINDOWS_MANDATORY_INTEGRITY_RIDS.mediumPlus;},
  },process);
  assert.deepEqual(context,{caller:'medium',target:'medium-plus'});
  assert.deepEqual(decideWindowsInputIntegrity(context),{allowed:false,reason:'uipi-higher-integrity-target'});
});

test('token read failure or noncanonical RID remains unknown and blocks input', async () => {
  const failed = await resolveWindowsInputIntegrityContext({
    currentProcessIntegrityRid:async()=>{throw new Error('token-read-failed');},
    processIntegrityRid:async()=>WINDOWS_MANDATORY_INTEGRITY_RIDS.low,
  },process);
  assert.equal(failed.caller,undefined);
  assert.deepEqual(decideWindowsInputIntegrity(failed),{allowed:false,reason:'integrity-unknown'});

  const noncanonical = await resolveWindowsInputIntegrityContext({
    currentProcessIntegrityRid:async()=>WINDOWS_MANDATORY_INTEGRITY_RIDS.high,
    processIntegrityRid:async()=>0x4100,
  },process);
  assert.equal(noncanonical.target,undefined);
  assert.deepEqual(decideWindowsInputIntegrity(noncanonical),{allowed:false,reason:'integrity-unknown'});
});
