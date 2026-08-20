import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { launchStandaloneChromium } from '../../dist/src/runtime/standaloneChromium.js';

const executablePath = process.env.CHROMIUM_BIN || '/usr/bin/chromium';

async function chromiumAvailable() {
  try {
    await access(executablePath);
    return true;
  } catch {
    return false;
  }
}

test('standalone Chromium launches and controls targets over raw remote-debugging-pipe', {
  skip: !(await chromiumAvailable()),
}, async () => {
  const browser = await launchStandaloneChromium({
    executablePath,
    headless: true,
    noSandbox: true,
    startupTimeoutMs: 5_000,
  });
  const temporaryProfile = browser.userDataDir;

  try {
    assert.match(browser.version.product ?? '', /Chrom(?:e|ium)\//);

    const first = await browser.attachFirstPage();
    const evaluated = await first.session.send('Runtime.evaluate', {
      expression: `document.body.innerHTML='<button id="ready">ready</button>';({text:document.body.innerText,href:location.href})`,
      returnByValue: true,
    });
    assert.deepEqual(evaluated.result.value, {
      text: 'ready',
      href: 'about:blank',
    });

    const second = await browser.createPage('about:blank');
    const secondValue = await second.session.send('Runtime.evaluate', {
      expression: `document.body.innerHTML='<p>two</p>';document.body.innerText`,
      returnByValue: true,
    });
    assert.equal(secondValue.result.value, 'two');
    assert.equal(
      (await browser.targets()).filter((target) => target.type === 'page').length,
      2,
    );
    assert.equal(await browser.closePage(second.targetId), true);
  } finally {
    await browser.shutdown();
  }

  await assert.rejects(access(temporaryProfile));
});
