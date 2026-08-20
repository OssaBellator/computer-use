import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { launchStandaloneBrowserAgent } from '../../dist/src/engine/standaloneBrowserAgent.js';

const executablePath = process.env.CHROMIUM_BIN || '/usr/bin/chromium';

async function chromiumAvailable() {
  try { await access(executablePath); return true; } catch { return false; }
}

async function evaluate(session, expression) {
  const result = await session.send('Runtime.evaluate', { expression, returnByValue: true });
  return result.result.value;
}

async function select(session, expression) {
  await session.send('Runtime.evaluate', { expression });
}

test('rich document formatting observes mixed runs and verifies native formatting', {
  skip: !(await chromiumAvailable()),
}, async () => {
  const agent = await launchStandaloneBrowserAgent({
    chromium: { executablePath, headless: true, noSandbox: true, startupTimeoutMs: 5_000 },
  });

  try {
    const page = await agent.chromium.attachFirstPage();
    const richText = agent.activeEngine?.richText;
    assert.ok(richText);

    await select(page.session, `(() => {
      document.body.innerHTML = '<div id="editor" contenteditable="true"><p id="p">plain <strong>bold</strong> <em>italic</em> <u>under</u> <s>strike</s> <code>code</code> <a href="https://example.test/path">link</a></p><h2 id="heading">Heading</h2><ul><li id="item">item</li></ul></div><div id="other" contenteditable="true">other</div>';
      const editor = document.querySelector('#editor');
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#p'));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    })()`);

    const mixed = await richText.observeFormatting();
    assert.ok(mixed);
    assert.equal(mixed.states.length, 1);
    assert.equal(mixed.states[0].summary.bold, 'mixed');
    assert.equal(mixed.states[0].summary.italic, 'mixed');
    assert.equal(mixed.states[0].summary.underline, 'mixed');
    assert.equal(mixed.states[0].summary.strike, 'mixed');
    assert.equal(mixed.states[0].summary.code, 'mixed');
    assert.equal(mixed.states[0].summary.link, 'mixed');
    assert.equal(mixed.states[0].blocks[0].kind, 'paragraph');
    assert.ok(mixed.states[0].runs.some((run) => run.link?.url === 'https://example.test/path'));
    assert.equal(JSON.stringify(mixed).includes('plain'), false);

    const mixedAction = await richText.setBold(true, { primaryModifier: 'Control' });
    assert.equal(mixedAction.status, 'formatting-mixed');

    await select(page.session, `(() => {
      const node = document.querySelector('#p').firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 5);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector('#editor').focus();
    })()`);

    const formatted = await richText.setBold(true, { primaryModifier: 'Control' });
    assert.equal(formatted.status, 'formatted');
    assert.equal(formatted.before?.states[0].summary.bold, 'off');
    assert.equal(formatted.after?.states[0].summary.bold, 'on');
    assert.match(await evaluate(page.session, `document.querySelector('#p').innerHTML`), /plain/);

    await select(page.session, `(() => {
      const node = document.querySelector('#p strong').firstChild;
      const selection = getSelection();
      selection.collapse(node, 2);
      document.querySelector('#editor').focus();
    })()`);
    const caret = await richText.observeFormatting();
    assert.equal(caret?.states[0].collapsed, true);
    assert.equal(caret?.states[0].summary.bold, 'on');
    const caretToggle = await richText.setBold(false, { primaryModifier: 'Control' });
    assert.equal(caretToggle.status, 'formatted');
    assert.equal(caretToggle.after?.states[0].summary.bold, 'off');

    await select(page.session, `(() => {
      const node = document.querySelector('#heading').firstChild;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector('#editor').focus();
    })()`);
    const heading = await richText.observeFormatting();
    assert.equal(heading?.states[0].blocks[0].kind, 'heading');
    assert.equal(heading?.states[0].blocks[0].headingLevel, 2);

    await select(page.session, `(() => {
      const node = document.querySelector('#item').firstChild;
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector('#editor').focus();
    })()`);
    const list = await richText.observeFormatting();
    assert.equal(list?.states[0].blocks[0].list?.kind, 'unordered');
    assert.equal(list?.states[0].blocks[0].list?.depth, 1);

    await select(page.session, `(() => {
      const start = document.querySelector('#p').firstChild;
      const end = document.querySelector('#other').firstChild;
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, 2);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector('#editor').focus();
    })()`);
    const crossHost = await richText.observeFormatting();
    assert.equal(crossHost?.states.length, 0);
    assert.equal(crossHost?.frameErrors[0]?.message, 'selection-crosses-editing-hosts');
  } finally {
    await agent.shutdown();
  }
});
