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

test('standalone CDP observer reads bounded structured document content including open Shadow DOM', {
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
    await page.session.send('Runtime.evaluate', {
      expression: `(() => {
        document.documentElement.lang = 'en';
        document.head.innerHTML = '<base href="https://example.test/"><meta name="description" content="fixture description"><link rel="canonical" href="/research">';
        document.title = 'Research Fixture';
        document.body.innerHTML = ` + "`" + `
          <main aria-label="Research">
            <article>
              <h1>Primary heading</h1>
              <p>Visible paragraph with <a href="/source">a source</a>.</p>
              <ul><li>First item</li><li>Second item</li></ul>
              <table><caption>Scores</caption><tr><th>Name</th><td>Ada</td></tr></table>
              <pre><code>const answer = 42;\nconsole.log(answer);</code></pre>
              <img alt="Architecture diagram">
              <p id="offscreen" style="position:absolute;top:1800px">Offscreen but rendered</p>
              <p id="hidden" style="display:none">Hidden paragraph</p>
              <div id="host"><p slot="body">Slotted paragraph</p></div>
            </article>
          </main>` + "`" + `;
        const root = document.querySelector('#host').attachShadow({ mode: 'open' });
        root.innerHTML = '<section aria-label="Shadow section"><h2>Shadow heading</h2><slot name="body"></slot></section>';
      })()`,
    });

    const observer = agent.activeEngine?.interaction.observer;
    assert.ok(observer?.documentContent);
    const snapshot = await observer.documentContent({
      maxBlocks: 100,
      maxTextBytes: 100_000,
    });

    assert.equal(snapshot.frames[0].title, 'Research Fixture');
    assert.equal(snapshot.frames[0].language, 'en');
    assert.equal(snapshot.frames[0].description, 'fixture description');
    assert.equal(snapshot.frames[0].canonicalUrl, 'https://example.test/research');
    assert.equal(snapshot.frameErrors.length, 0);
    assert.equal(snapshot.truncated, false);

    const texts = snapshot.blocks.map((block) => block.text).filter(Boolean);
    assert.ok(texts.includes('Primary heading'));
    assert.ok(texts.includes('Visible paragraph with a source.'));
    assert.ok(texts.includes('First item'));
    assert.ok(texts.includes('Second item'));
    assert.ok(texts.includes('Scores'));
    assert.ok(texts.includes('Name'));
    assert.ok(texts.includes('Ada'));
    assert.ok(texts.includes('const answer = 42;\nconsole.log(answer);'));
    assert.ok(texts.includes('Shadow heading'));
    assert.ok(texts.includes('Slotted paragraph'));
    assert.ok(texts.includes('Offscreen but rendered'));
    assert.equal(texts.includes('Hidden paragraph'), false);

    const source = snapshot.blocks.find(
      (block) => block.kind === 'link' && block.text === 'a source',
    );
    assert.equal(source?.href, 'https://example.test/source');
    const image = snapshot.blocks.find((block) => block.kind === 'image');
    assert.equal(image?.alt, 'Architecture diagram');
    const offscreen = snapshot.blocks.find((block) => block.text === 'Offscreen but rendered');
    assert.equal(offscreen?.rendered, true);
    assert.equal(offscreen?.inViewport, false);

    const viewportOnly = await observer.documentContent({ viewportOnly: true });
    assert.equal(
      viewportOnly.blocks.some((block) => block.text === 'Offscreen but rendered'),
      false,
    );
  } finally {
    await agent.shutdown();
  }
});
