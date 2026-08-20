import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { launchStandaloneBrowserAgent } from '../../dist/src/engine/standaloneBrowserAgent.js';

const executablePath = process.env.CHROMIUM_BIN || '/usr/bin/chromium';

async function chromiumAvailable() {
  try {
    await access(executablePath);
    return true;
  } catch {
    return false;
  }
}

async function value(session, expression) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });
  return result.result.value;
}

test('standalone rich text controller observes and replaces DOM and text-control selections', {
  skip: !(await chromiumAvailable()),
}, async () => {
  const agent = await launchStandaloneBrowserAgent({
    chromium: {
      executablePath,
      headless: true,
      noSandbox: true,
      startupTimeoutMs: 5_000,
    },
  });

  try {
    const page = await agent.chromium.attachFirstPage();
    const richText = agent.activeEngine?.richText;
    assert.ok(richText);

    await page.session.send('Runtime.evaluate', {
      expression: `(() => {
        document.body.innerHTML = '<div id="editor" contenteditable="true">alpha beta gamma</div><input id="text" value="abcdef">';
        const editor = document.querySelector('#editor');
        editor.focus();
        const node = editor.firstChild;
        const range = document.createRange();
        range.setStart(node, 6);
        range.setEnd(node, 10);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      })()`,
    });

    const domBefore = await richText.observe();
    assert.equal(domBefore.selections.length, 1);
    assert.equal(domBefore.selections[0].kind, 'dom');
    assert.equal(domBefore.selections[0].selectedText, 'beta');
    assert.equal(domBefore.selections[0].editingHost?.tagName, 'div');

    const replacedDom = await richText.insertText('δ');
    assert.equal(replacedDom.status, 'inserted');
    assert.equal(replacedDom.selectionCollapsed, true);
    assert.equal(
      await value(page.session, `document.querySelector('#editor').innerText`),
      'alpha δ gamma',
    );

    await page.session.send('Runtime.evaluate', {
      expression: `(() => {
        const input = document.querySelector('#text');
        input.focus();
        input.setSelectionRange(1, 4, 'backward');
      })()`,
    });

    const inputBefore = await richText.observe();
    assert.equal(inputBefore.selections.length, 1);
    const textSelection = inputBefore.selections[0];
    assert.equal(textSelection.kind, 'text-control');
    assert.equal(textSelection.selectedText, 'bcd');
    assert.equal(textSelection.direction, 'backward');
    assert.equal(textSelection.anchor?.offset, 4);
    assert.equal(textSelection.focus?.offset, 1);

    const replacedInput = await richText.insertText('XYZ');
    assert.equal(replacedInput.status, 'inserted');
    assert.deepEqual(
      await value(page.session, `(() => {
        const input = document.querySelector('#text');
        return { value: input.value, start: input.selectionStart, end: input.selectionEnd };
      })()`),
      { value: 'aXYZef', start: 4, end: 4 },
    );

    const selectedAll = await richText.selectAll({ primaryModifier: 'Control' });
    assert.equal(selectedAll.status, 'selected-all');
    assert.equal(selectedAll.after.selections[0].selectedText, 'aXYZef');

    const deleted = await richText.deleteSelection();
    assert.equal(deleted.status, 'deleted');
    assert.equal(await value(page.session, `document.querySelector('#text').value`), '');
  } finally {
    await agent.shutdown();
  }
});
