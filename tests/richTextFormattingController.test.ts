import test from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentFormattingSnapshot, FormattingValue } from '../src/browser/documentFormatting.js';
import { DocumentFormattingObserver } from '../src/browser/documentFormatting.js';
import type { DocumentSelectionSnapshot } from '../src/browser/documentSelection.js';
import { DocumentSelectionObserver } from '../src/browser/documentSelection.js';
import { RichTextController, type RichTextNativeInlineFormat } from '../src/controller/richTextController.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { Point } from '../src/types.js';

function selection(kind: 'dom'|'text-control' = 'dom', overrides: Record<string, unknown> = {}): DocumentSelectionSnapshot {
  return { selections: [{ frameId:'main', kind, collapsed:false, direction:'forward', selectedText:'text', selectedTextTruncated:false, editingHost:{path:'body > div',tagName:kind==='dom'?'div':'input',contentEditable:kind==='dom'?'true':undefined}, rangeCount:1, rects:[], rectsTruncated:false, ...overrides }], frameErrors:[], truncated:false };
}
function formatting(value: FormattingValue, overrides: Record<string, unknown> = {}): DocumentFormattingSnapshot {
  return { states:[{ frameId:'main', collapsed:false, editingHost:{path:'body > div',tagName:'div',contentEditable:'true'}, summary:{bold:value,italic:'off',underline:'off',strike:'off',code:'off',link:'off'}, linkTarget:{state:'none'}, runs:[],runsTruncated:false,blocks:[],blocksTruncated:false,complete:true,...overrides }], frameErrors:[], truncated:false };
}
class Input implements BrowserInput {
  events:string[]=[];
  async movePointer(_p:Point){} async pointerDown(_b:MouseButton='left'){} async pointerUp(_b:MouseButton='left'){}
  async pressKey(key:string){this.events.push(`press:${key}`);} async keyDown(_k:string){} async keyUp(_k:string){}
  async typeText(_t:string){} async insertText(_t:string){} async scroll(_d:Point){}
}
function selectionObserver(states: readonly DocumentSelectionSnapshot[]): DocumentSelectionObserver { let i=0; return { snapshot: async()=>states[Math.min(i++,states.length-1)] } as unknown as DocumentSelectionObserver; }
function formattingObserver(states: readonly DocumentFormattingSnapshot[]): DocumentFormattingObserver { let i=0; return { snapshot: async()=>states[Math.min(i++,states.length-1)] } as unknown as DocumentFormattingObserver; }

test('native bold command verifies observed formatting state after keyboard input', async () => {
  const input=new Input();
  const controller=new RichTextController(input, selectionObserver([selection(),selection()]), formattingObserver([formatting('off'),formatting('on')]));
  const result=await controller.setBold(true,{primaryModifier:'Control'});
  assert.equal(result.status,'formatted');
  assert.equal(result.before?.states[0].summary.bold,'off');
  assert.equal(result.after?.states[0].summary.bold,'on');
  assert.deepEqual(input.events,['press:Control+b']);
});

test('mixed formatting fails closed instead of guessing toggle semantics', async () => {
  const input=new Input();
  const controller=new RichTextController(input, selectionObserver([selection()]), formattingObserver([formatting('mixed')]));
  assert.equal((await controller.setBold(true)).status,'formatting-mixed');
  assert.deepEqual(input.events,[]);
});

test('text controls and unobservable formatting fail closed without dispatch', async () => {
  const input=new Input();
  const textControl=new RichTextController(input, selectionObserver([selection('text-control')]));
  assert.equal((await textControl.setItalic(true)).status,'unsupported-editor');
  const unknown=new RichTextController(input, selectionObserver([selection()]), formattingObserver([formatting('off', { summary:{bold:'off',italic:'off',underline:'unknown',strike:'off',code:'off',link:'off'} })]));
  assert.equal((await unknown.setUnderline(true)).status,'formatting-unobservable');
  assert.deepEqual(input.events,[]);
});

test('native formatting reports unverified when post-command observation does not reach the requested state', async () => {
  const input=new Input();
  const controller=new RichTextController(input, selectionObserver([selection(),selection()]), formattingObserver([formatting('off'),formatting('off')]));
  assert.equal((await controller.setBold(true,{primaryModifier:'Control'})).status,'unverified');
  assert.deepEqual(input.events,['press:Control+b']);
});

test('native formatting reports unverified when the selection collapses during the command', async () => {
  const input = new Input();
  const controller = new RichTextController(
    input,
    selectionObserver([selection(), selection('dom', { collapsed: true, direction: 'none', selectedText: undefined })]),
    formattingObserver([formatting('off'), formatting('on', { collapsed: true })]),
  );
  assert.equal((await controller.setBold(true, { primaryModifier: 'Control' })).status, 'unverified');
  assert.deepEqual(input.events, ['press:Control+b']);
});

test('native formatting reports unverified when fully observed selected text changes', async () => {
  const input = new Input();
  const controller = new RichTextController(
    input,
    selectionObserver([selection(), selection('dom', { selectedText: 'other' })]),
    formattingObserver([formatting('off'), formatting('on')]),
  );
  assert.equal((await controller.setBold(true, { primaryModifier: 'Control' })).status, 'unverified');
  assert.deepEqual(input.events, ['press:Control+b']);
});

test('unsupported runtime format names are rejected before any browser input', async () => {
  const input = new Input();
  const controller = new RichTextController(input, selectionObserver([selection()]), formattingObserver([formatting('off')]));
  await assert.rejects(
    () => controller.setInlineFormat('strike' as RichTextNativeInlineFormat, true),
    /bold, italic, or underline/,
  );
  assert.deepEqual(input.events, []);
});

test('invalid runtime modifier names are rejected before any formatting input', async () => {
  const input = new Input();
  const controller = new RichTextController(input, selectionObserver([selection()]), formattingObserver([formatting('off')]));
  await assert.rejects(
    () => controller.setBold(true, { primaryModifier: 'AltGraph' as 'Control' }),
    /Control or Meta/,
  );
  assert.deepEqual(input.events, []);
});

test('multiple formatting states are treated as ambiguous', async () => {
  const input=new Input();
  const ambiguous=formatting('off');
  ambiguous.states.push({...ambiguous.states[0],frameId:'frame-1'});
  const controller=new RichTextController(input, selectionObserver([selection()]), formattingObserver([ambiguous]));
  assert.equal((await controller.setBold(true)).status,'formatting-ambiguous');
  assert.deepEqual(input.events,[]);
});

test('formatting actions fail closed when another frame could not be observed', async () => {
  const input = new Input();
  const selectionWithError = selection();
  selectionWithError.frameErrors.push({ frameId: 'frame-1', message: 'detached frame' });
  const controller = new RichTextController(
    input,
    selectionObserver([selectionWithError]),
    formattingObserver([formatting('off')]),
  );
  assert.equal((await controller.setBold(true)).status, 'selection-ambiguous');
  assert.deepEqual(input.events, []);
});