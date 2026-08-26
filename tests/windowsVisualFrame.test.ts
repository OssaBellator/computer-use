import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWindowsVisualPointBinding, type WindowsVisualFrameRef } from '../src/computer/windowsVisualFrame.js';

const frame: WindowsVisualFrameRef = Object.freeze({
  window:Object.freeze({
    hwnd:'0x55',
    desktopSessionId:'interactive:1',
    process:Object.freeze({processId:77,startIdentity:'proc-start-1'}),
    generation:2,
  }),
  frameSequence:10,
  captureGeneration:4,
  capturedAtMs:1000,
  contentWidth:800,
  contentHeight:600,
  geometry:Object.freeze({left:100,top:50,width:800,height:600,dpi:144}),
});

test('visual point remains valid only for its exact capture coordinate space', () => {
  assert.deepEqual(validateWindowsVisualPointBinding({frame,x:400,y:300},frame),{status:'valid'});
});

test('window generation replacement invalidates visual coordinates', () => {
  const current = {...frame,window:{...frame.window,generation:3}};
  assert.deepEqual(validateWindowsVisualPointBinding({frame,x:1,y:1},current),{status:'window-stale'});
});

test('new frame or capture generation invalidates visual coordinates', () => {
  assert.deepEqual(validateWindowsVisualPointBinding({frame,x:1,y:1},{...frame,frameSequence:11}),{status:'capture-stale'});
  assert.deepEqual(validateWindowsVisualPointBinding({frame,x:1,y:1},{...frame,captureGeneration:5}),{status:'capture-stale'});
});

test('move resize and DPI changes invalidate the coordinate transform', () => {
  for (const geometry of [
    {...frame.geometry,left:101},
    {...frame.geometry,width:801},
    {...frame.geometry,dpi:192},
  ]) {
    assert.deepEqual(validateWindowsVisualPointBinding({frame,x:1,y:1},{...frame,geometry}),{status:'geometry-changed'});
  }
});

test('out of bounds points fail closed', () => {
  assert.deepEqual(validateWindowsVisualPointBinding({frame,x:800,y:20},frame),{status:'point-out-of-bounds'});
  assert.deepEqual(validateWindowsVisualPointBinding({frame,x:-1,y:20},frame),{status:'point-out-of-bounds'});
});
