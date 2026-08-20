import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { TaskRuntime } from '../../dist/src/agent/taskRuntime.js';
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

test('TaskRuntime can wait and complete on structured document content through standalone raw CDP', {
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
        document.body.innerHTML = '<main><h1>Research</h1><div id="results"></div></main>';
        setTimeout(() => {
          document.querySelector('#results').innerHTML = '<p>Result ready: Ada</p><p>Result ready: Grace</p>';
        }, 80);
      })()`,
    });

    const program = {
      version: 1,
      name: 'document-wait-smoke',
      entry: 'wait-results',
      steps: [
        {
          id: 'wait-results',
          kind: 'wait',
          condition: {
            kind: 'document',
            state: {
              kind: 'paragraph',
              textIncludes: 'Result ready:',
              minMatches: 2,
              rendered: true,
            },
          },
          maxPolls: 20,
          pollIntervalMs: 20,
          next: 'complete',
        },
        {
          id: 'complete',
          kind: 'complete',
          condition: {
            kind: 'document',
            state: { kind: 'paragraph', textIncludes: 'Ada' },
          },
        },
      ],
    };

    const result = await new TaskRuntime(agent.taskEngine).run(program);
    assert.equal(result.status, 'completed');
    assert.equal(result.completed, true);
    assert.deepEqual(result.trace.map((entry) => [entry.stepId, entry.outcome]), [
      ['wait-results', 'wait-satisfied'],
      ['complete', 'completed'],
    ]);
    assert.notEqual(result.trace[0].beforeFingerprint, result.trace[0].afterFingerprint);
  } finally {
    await agent.shutdown();
  }
});
