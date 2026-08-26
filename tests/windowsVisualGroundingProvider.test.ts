import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsVisualGroundingProvider } from '../src/computer/windowsVisualGroundingProvider.js';
import type { WindowsGraphicsCaptureObservation } from '../src/computer/windowsGraphicsCaptureRuntime.js';

const windowRef=Object.freeze({
  hwnd:'0xabc',desktopSessionId:'session:1',process:Object.freeze({processId:10,startIdentity:'p10'}),generation:2,
});
const observation:WindowsGraphicsCaptureObservation=Object.freeze({
  frame:Object.freeze({
    window:windowRef,captureGeneration:4,frameSequence:7,capturedAtMs:100,
    contentWidth:800,contentHeight:600,
    geometry:Object.freeze({left:10,top:20,width:800,height:600,dpi:144}),
  }),
  artifact:Object.freeze({token:'capture-4-7',mediaType:'image/png',byteLength:1000}),
});
const query=Object.freeze({id:'save-button',text:'Find the Save button',maxCandidates:4});

test('visual grounding accepts bounded candidates only for the exact artifact/frame',async()=>{
  const provider=new WindowsVisualGroundingProvider({ground:async()=>({
    artifactToken:'capture-4-7',captureGeneration:4,frameSequence:7,
    candidates:[{id:'candidate-1',confidence:0.92,x:400,y:300,region:{x:350,y:275,width:100,height:50},label:'Save',evidence:['model-grounded']}],
  })});
  const result=await provider.ground(observation,query);
  assert.equal(result.length,1);
  assert.equal(result[0]?.point.frame,observation.frame);
  assert.deepEqual(result[0]?.region,{x:350,y:275,width:100,height:50});
});

test('visual grounding rejects response from another capture generation or artifact',async()=>{
  const provider=new WindowsVisualGroundingProvider({ground:async()=>({
    artifactToken:'capture-other',captureGeneration:3,frameSequence:7,candidates:[],
  })});
  await assert.rejects(()=>provider.ground(observation,query),/frame-mismatch/);
});

test('visual grounding rejects out-of-bounds regions and duplicate candidate ids',async()=>{
  const outside=new WindowsVisualGroundingProvider({ground:async()=>({
    artifactToken:'capture-4-7',captureGeneration:4,frameSequence:7,
    candidates:[{id:'bad',confidence:0.5,x:1,y:1,region:{x:790,y:590,width:20,height:20}}],
  })});
  await assert.rejects(()=>outside.ground(observation,query),/response-invalid/);

  const duplicate=new WindowsVisualGroundingProvider({ground:async()=>({
    artifactToken:'capture-4-7',captureGeneration:4,frameSequence:7,
    candidates:[{id:'same',confidence:0.5,x:1,y:1},{id:'same',confidence:0.6,x:2,y:2}],
  })});
  await assert.rejects(()=>duplicate.ground(observation,query),/response-invalid/);
});

test('visual grounding rejects accessor-bearing provider responses without invoking them',async()=>{
  let calls=0;
  const malicious=Object.defineProperty({},'artifactToken',{enumerable:true,get(){calls+=1;return 'capture-4-7';}});
  const provider=new WindowsVisualGroundingProvider({ground:async()=>malicious});
  await assert.rejects(()=>provider.ground(observation,query),/frame-mismatch/);
  assert.equal(calls,0);
});
