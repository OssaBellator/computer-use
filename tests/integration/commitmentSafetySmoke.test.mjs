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

async function commitCount(page) {
  const state = await page.session.send('Runtime.evaluate', {
    expression: 'window.commitCount',
    returnByValue: true,
  });
  return state.result.value;
}

test('standalone TaskRuntime gates and verifies a synthetic checkout commitment around native browser input', {
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
      touchpadOptions: { initialCursor: { x: 10, y: 10 } },
      pointerOptions: { sleep: async () => {}, sampleIntervalMs: 50 },
    },
  });

  try {
    const page = await agent.chromium.attachFirstPage();
    await page.session.send('Runtime.evaluate', {
      expression: `(() => {
        window.commitCount = 0;
        document.body.innerHTML = [
          '<main>',
          '<h1>Review your order</h1>',
          '<p>Order total AUD 25.00</p>',
          '<p>Merchant: Synthetic Store</p>',
          '<p>Payment method: Test Card</p>',
          '<button id="confirm" aria-pressed="false" style="position:absolute;left:120px;top:180px;width:140px;height:44px">Confirm</button>',
          '<p id="status">Not submitted</p>',
          '</main>',
        ].join('');
        document.querySelector('#confirm').addEventListener('click', () => {
          window.commitCount += 1;
          document.querySelector('#confirm').setAttribute('aria-pressed', 'true');
          document.querySelector('#status').textContent = 'Synthetic order confirmed';
        });
      })()`,
    });

    const program = {
      version: 1,
      name: 'synthetic-checkout',
      entry: 'confirm',
      steps: [
        {
          id: 'confirm',
          kind: 'activate',
          target: { role: 'button', name: 'Confirm' },
          next: 'done',
        },
        { id: 'done', kind: 'complete' },
      ],
    };

    const blocked = await new TaskRuntime(agent.taskEngine).run(program);
    assert.equal(blocked.status, 'policy-blocked');
    assert.equal(await commitCount(page), 0);
    assert.equal(blocked.trace[0]?.commitmentStatus, 'detected');
    assert.equal(blocked.trace[0]?.commitmentKind, 'purchase');

    let approval;
    let verification;
    const allowed = await new TaskRuntime(agent.taskEngine).run(program, {}, {
      approve: async (context) => {
        approval = context.commitment;
        return true;
      },
      onCommitmentVerification: async (context) => {
        verification = context.verification;
      },
    });
    assert.equal(allowed.status, 'completed');
    assert.equal(await commitCount(page), 1);
    assert.equal(approval?.kind, 'purchase');
    assert.equal(approval?.amount?.currency, 'AUD');
    assert.equal(approval?.amount?.value, '25.00');
    assert.equal(approval?.counterparty, 'synthetic store');
    assert.equal(verification?.status, 'confirmed');
    assert.equal(verification?.observed?.amount?.value, '25.00');
    assert.equal(allowed.trace[0]?.outcome, 'commitment-confirmed');
    assert.equal(allowed.trace[0]?.commitmentVerificationStatus, 'confirmed');

    const traceText = JSON.stringify(allowed.trace);
    assert.equal(traceText.includes('25.00'), false);
    assert.equal(traceText.includes('synthetic store'), false);
  } finally {
    await agent.shutdown();
  }
});
