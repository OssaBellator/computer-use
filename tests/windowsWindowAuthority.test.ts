import test from 'node:test';
import assert from 'node:assert/strict';
import { decideWindowsWindowAuthority } from '../src/computer/windowsWindowAuthority.js';
import type { WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';

const main: WindowsUiaWindowRef = Object.freeze({
  hwnd:'0x10',desktopSessionId:'interactive:1',process:Object.freeze({processId:5,startIdentity:'p5'}),generation:1,
});
const modal: WindowsUiaWindowRef = Object.freeze({
  hwnd:'0x11',desktopSessionId:'interactive:1',process:Object.freeze({processId:5,startIdentity:'p5'}),generation:1,
});
const modal2: WindowsUiaWindowRef = Object.freeze({
  hwnd:'0x12',desktopSessionId:'interactive:1',process:Object.freeze({processId:5,startIdentity:'p5'}),generation:1,
});

test('blocked target with no represented modal fails closed even when HWND is current', () => {
  const result = decideWindowsWindowAuthority(main,[{window:main,isModal:false,interactionState:'blocked-by-modal-window'}]);
  assert.deepEqual(result,{allowed:false,reason:'window-blocked-by-modal'});
});

test('blocked owner routes to its single owned modal', () => {
  const result = decideWindowsWindowAuthority(main,[
    {window:main,isModal:false,interactionState:'blocked-by-modal-window'},
    {window:modal,isModal:true,interactionState:'ready-for-user-interaction',owner:main},
  ]);
  assert.deepEqual(result,{allowed:true,target:modal});
});

test('single owned modal becomes the exact interaction target even before owner reports blocked', () => {
  const result = decideWindowsWindowAuthority(main,[
    {window:main,isModal:false,interactionState:'running'},
    {window:modal,isModal:true,interactionState:'ready-for-user-interaction',owner:main},
  ]);
  assert.deepEqual(result,{allowed:true,target:modal});
});

test('nested modal chain resolves to deepest unique modal', () => {
  const result = decideWindowsWindowAuthority(main,[
    {window:main,isModal:false,interactionState:'blocked-by-modal-window'},
    {window:modal,isModal:true,interactionState:'blocked-by-modal-window',owner:main},
    {window:modal2,isModal:true,interactionState:'ready-for-user-interaction',owner:modal},
  ]);
  assert.deepEqual(result,{allowed:true,target:modal2});
});

test('multiple plausible owned modals are ambiguous and cannot dispatch', () => {
  const result = decideWindowsWindowAuthority(main,[
    {window:main,isModal:false,interactionState:'running'},
    {window:modal,isModal:true,interactionState:'ready-for-user-interaction',owner:main},
    {window:modal2,isModal:true,interactionState:'ready-for-user-interaction',owner:main},
  ]);
  assert.deepEqual(result,{allowed:false,reason:'modal-ambiguity'});
});

test('closing and non-responsive resolved windows are not interaction-authoritative', () => {
  assert.deepEqual(decideWindowsWindowAuthority(main,[{window:main,isModal:false,interactionState:'closing'}]),{allowed:false,reason:'window-closing'});
  assert.deepEqual(decideWindowsWindowAuthority(main,[{window:main,isModal:false,interactionState:'not-responding'}]),{allowed:false,reason:'window-not-responding'});
  assert.deepEqual(decideWindowsWindowAuthority(main,[
    {window:main,isModal:false,interactionState:'blocked-by-modal-window'},
    {window:modal,isModal:true,interactionState:'closing',owner:main},
  ]),{allowed:false,reason:'window-closing'});
});
