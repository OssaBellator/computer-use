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

test('standalone raw-CDP runtime reaches the semantic multi-page task engine', {
  skip: !(await chromiumAvailable()),
}, async () => {
  const agent = await launchStandaloneBrowserAgent({
    chromium: {
      executablePath,
      headless: true,
      noSandbox: true,
      startupTimeoutMs: 5_000,
    },
    page: {
      touchpadOptions: { initialCursor: { x: 5, y: 5 } },
      pointerOptions: { sleep: async () => {}, sampleIntervalMs: 100 },
    },
  });

  try {
    assert.ok(agent.activeEngine);
    assert.equal(agent.pages.summary().attachedPages, 1);

    const page = await agent.chromium.attachFirstPage();
    await page.session.send('Runtime.evaluate', {
      expression: `(() => {
        document.body.innerHTML = '<button id="toggle" aria-expanded="false" style="position:absolute;left:100px;top:80px;width:120px;height:44px">Toggle</button><input id="text" aria-label="Text" style="position:absolute;left:100px;top:160px;width:180px;height:30px" value="">';
        document.querySelector('#toggle').addEventListener('click', () => {
          document.querySelector('#toggle').setAttribute('aria-expanded', 'true');
        });
      })()`,
    });

    const nodes = await agent.taskEngine.refresh();
    assert.equal(nodes.some((node) => node.name === 'Toggle'), true);
    assert.equal(nodes.some((node) => node.name === 'Text'), true);

    const activated = await agent.taskEngine.activate({
      name: 'Toggle',
      capability: 'activate',
      visible: true,
    });
    assert.equal(activated.status, 'verified');

    const typed = await agent.taskEngine.typeInto(
      { name: 'Text', capability: 'type', visible: true },
      'abc',
      { expectedValue: 'abc' },
    );
    assert.equal(typed.status, 'verified');

    const state = await page.session.send('Runtime.evaluate', {
      expression: `({expanded:document.querySelector('#toggle').getAttribute('aria-expanded'),value:document.querySelector('#text').value})`,
      returnByValue: true,
    });
    assert.deepEqual(state.result.value, { expanded: 'true', value: 'abc' });
  } finally {
    await agent.shutdown();
  }
});
